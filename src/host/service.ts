/**
 * Host-half orchestration: the alarm table, the three trigger layers, the wake
 * path, and the reads the panel and the agent tool both use.
 *
 * The host half duck-types every harness service it touches. An external dsh
 * plugin resolves only \`@deepseek-ai/cordis\` plus its own dependencies —
 * \`dsh-session\`, \`dsh-tools\` and friends are not reachable from a linked
 * package — so importing their types would silently inline a second copy of a
 * runtime contract. The interfaces below restate exactly the surface this
 * plugin uses, and every optional one degrades instead of failing.
 *
 * @module dsh-clock/host/service
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AlarmOrigin,
  ClockAlarm,
  ClockConfig,
  ClockSessionView,
  ClockStateView,
  FireTrigger,
  ResolvedConfig,
} from '../shared/types.ts'
import { AlarmStore, createAlarm, resolveConfig, type AlarmInput } from './store.ts'
import { ClockScheduler, type SchedulerHost } from './scheduler.ts'
import { deliverWake, type SessionControllerLike } from './fire.ts'
import { syncSystemTask as syncOsTask, systemSchedulerSupported } from './system-scheduler.ts'
import { processTimeZone } from './time.ts'

/** A session event as this plugin reads it. */
interface LogEventLike {
  type: string
  time: number
  data: unknown
}

/** The subset of a live Session this plugin reads. */
export interface SessionLike {
  readonly id: string
  readonly header?: {
    readonly id?: string
    readonly createdAt?: number
    readonly cwd?: string
    readonly parentSession?: string
    /** Present and equal to 'subagent' on a conversation owned by subagent routing. */
    readonly origin?: string
  }
  snapshotEvents?(): unknown[]
}

/** The subset of ctx.sessions this plugin uses. */
export interface SessionStoreLike {
  list(): SessionLike[]
  get(id: string): SessionLike | undefined
}

/** One persisted-session snapshot, header-only. */
interface PersistenceSnapshotLike {
  header?: { id?: string; createdAt?: number; cwd?: string; parentSession?: string; origin?: string }
  sizeBytes?: number
}

/** A read handle over one stored session log. */
interface PersistenceHandleLike {
  read(): Promise<{ events?: unknown[] }>
  close?(): Promise<void> | void
}

/** The subset of ctx.sessionPersistence this plugin uses. */
export interface SessionPersistenceLike {
  list(signal?: AbortSignal): Promise<PersistenceSnapshotLike[]>
  open(sessionId: string, mode: 'read'): Promise<PersistenceHandleLike>
}

/** A cordis-style context, narrowed to what this plugin calls. */
export interface HostContextLike {
  on?(name: string, listener: (...args: unknown[]) => void): unknown
  effect?(callback: () => (() => void) | void, name?: string): unknown
  get?(name: string): unknown
}

/** Everything the plugin reaches for on the cordis context. */
export interface PluginContext extends HostContextLike {
  sessions?: SessionStoreLike
  logger?: { warn(message: string): void; info(message: string): void }
}

/** Normalize whatever a session hands back into shaped events. */
function normalizeEvents(raw: unknown[]): LogEventLike[] {
  const events: LogEventLike[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const candidate = item as { type?: unknown; time?: unknown; data?: unknown }
    if (typeof candidate.type !== 'string') continue
    events.push({
      type: candidate.type,
      time: typeof candidate.time === 'number' ? candidate.time : 0,
      data: candidate.data,
    })
  }
  return events
}

/**
 * Find the first usable text inside an unknown payload.
 *
 * Deliberately schema-tolerant: this plugin must keep working across harness
 * versions whose message-part shapes it cannot import, and a picker row with no
 * preview is a far smaller failure than a thrown one.
 * @param value - payload to walk.
 * @param depth - recursion guard.
 * @returns the text, or an empty string.
 */
export function firstText(value: unknown, depth = 0): string {
  if (depth > 4) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstText(item, depth + 1)
      if (found !== '') return found
    }
    return ''
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string' && record.text.trim() !== '') return record.text
    for (const key of ['content', 'parts', 'message', 'data']) {
      const found = firstText(record[key], depth + 1)
      if (found !== '') return found
    }
  }
  return ''
}

/** Newest `session/title` in a log, or the first user message, or the id. */
export function titleFromEvents(events: readonly LogEventLike[], fallbackId: string): string {
  let title = ''
  for (const event of events) {
    if (event.type !== 'session/title') continue
    const value = (event.data as { title?: unknown } | null)?.title
    if (typeof value === 'string' && value.trim() !== '') title = value.trim()
  }
  if (title !== '') return title
  const firstUser = events.find((event) => {
    if (event.type !== 'user/message') return false
    const source = (event.data as { source?: { kind?: string } } | null)?.source
    return source?.kind === 'user'
  })
  if (firstUser === undefined) return fallbackId
  const text = firstText(firstUser.data).replace(/\s+/g, ' ').trim()
  return text === '' ? fallbackId : text.slice(0, 48)
}

/**
 * Whether a conversation belongs to subagent routing.
 *
 * This matters because such a session can never be woken: the session
 * controller rejects an identity whose lifecycle belongs to subagent routing
 * (its own `ApiSessionSubagentOwnership`), so offering one in the picker would
 * be offering a target that is guaranteed to fail.
 *
 * Only `origin` is consulted. Subagent headers also carry a `delegationDepth`,
 * but a depth field is exactly the kind of thing a future version might start
 * writing on every session, and a check that silently emptied the picker would
 * be far worse than one that occasionally shows an extra row.
 * @param header - a live session header or a persistence snapshot header.
 * @returns whether the session is a subagent's.
 */
export function isSubagentSession(header: { origin?: string } | undefined): boolean {
  return header?.origin === 'subagent'
}

/** Loaded plugin configuration with the data directory resolved. */
export interface ClockServiceDeps {
  ctx: PluginContext
  config?: Partial<ClockConfig>
  /** Injected for tests: bypasses the cordis lookup of the session controller. */
  controller?: SessionControllerLike
}

/**
 * The plugin's host service.
 *
 * Three trigger layers converge on {@link fireDue}, and every one of them goes
 * through {@link claimDue} first, which flips an alarm to `fired` *before* any
 * delivery starts. That single ordering rule is what makes the layers safe to
 * stack: whichever arrives first wins, and the others find nothing to claim.
 */
export class ClockService implements SchedulerHost {
  readonly store: AlarmStore
  readonly config: ResolvedConfig
  private readonly ctx: PluginContext
  private readonly scheduler: ClockScheduler
  private readonly injectedController: SessionControllerLike | undefined
  private systemTaskArmedFor: number | null = null
  private lastSyncError: string | undefined
  private started = false
  /** Cached titles for stored conversations, filled in the background. */
  private readonly storedTitles = new Map<string, string>()
  /**
   * What the background title read actually did.
   *
   * A cold conversation whose log cannot be read simply falls back to showing
   * its id, which is indistinguishable from "this conversation has no title".
   * These counters are what makes the difference visible from outside.
   */
  private readonly titleIndex = {
    snapshots: 0,
    attempted: 0,
    titled: 0,
    failed: 0,
    rawEvents: -1,
    sampleEventKeys: '',
    lastError: '',
  }
  private indexing = false

  /** @param deps - context, optional configuration, optional test doubles. */
  constructor(deps: ClockServiceDeps) {
    this.ctx = deps.ctx
    this.config = resolveConfig(deps.config)
    this.store = new AlarmStore(this.config.dataDir)
    this.scheduler = new ClockScheduler(this)
    this.injectedController = deps.controller
    this.store.load()
  }

  /**
   * Append one line to the plugin's startup log.
   *
   * The harness logger's output does not reach the host's captured stdout, so a
   * plugin that activates only partly leaves no trace anywhere a maintainer can
   * read. This is that trace: which optional services resolved, and whether the
   * HTTP carrier and the agent tool actually mounted.
   * @param message - the line to record.
   */
  note(message: string): void {
    try {
      mkdirSync(this.config.dataDir, { recursive: true })
      appendFileSync(join(this.config.dataDir, 'startup.log'), new Date().toISOString() + ' ' + message + '\n', 'utf8')
    } catch {
      // Diagnostics must never be the thing that stops the plugin loading.
    }
  }

  /** Diagnostics sink that tolerates a context without a logger. */
  log(message: string): void {
    try {
      this.ctx.logger?.warn('[clock] ' + message)
    } catch {
      // Logging must never be the thing that breaks a wake.
    }
  }

  /** Current instant. */
  now(): number {
    return Date.now()
  }

  /** The display zone: configured, else the process zone. */
  get timeZone(): string {
    return this.config.defaultTimeZone === '' ? processTimeZone() : this.config.defaultTimeZone
  }

  /**
   * Start all three layers.
   *
   * The overdue replay runs first and on purpose: an alarm whose instant passed
   * while the host was down is exactly the case the injected clock information
   * exists for, and delivering it at startup is the only way it is ever
   * delivered.
   */
  start(): void {
    if (this.started) return
    this.started = true
    try {
      this.store.prune(this.now(), this.config.retainFiredDays)
    } catch (error) {
      this.log('prune failed: ' + String(error))
    }
    void this.replayAndArm()
    void this.refreshStoredTitles()
  }

  /** Deliver anything already overdue, then arm both layers. */
  private async replayAndArm(): Promise<void> {
    try {
      const claimed = await this.fireDue('overdue-replay')
      if (claimed > 0) this.log('delivered ' + String(claimed) + ' overdue alarm(s) at startup')
    } catch (error) {
      this.log('overdue replay failed: ' + String(error))
    }
    await this.scheduler.resync()
  }

  /** Instant of the soonest pending alarm. */
  earliestPending(): number | null {
    const pending = this.store.pending()
    return pending.length === 0 ? null : pending[0]!.at
  }

  /** Mirror the soonest pending instant into the OS scheduler. */
  async syncSystemTask(at: number | null): Promise<string | null> {
    if (!this.config.useSystemScheduler || !systemSchedulerSupported()) {
      this.systemTaskArmedFor = null
      return null
    }
    const error = syncOsTask(at, this.config.port, this.config.wakeComputer)
    this.lastSyncError = error ?? undefined
    this.systemTaskArmedFor = error === null ? at : null
    return error
  }

  /** Snapshot of what the scheduler is currently doing, for the panel. */
  get schedulerState(): { systemScheduler: boolean; systemTaskArmedFor: number | null; timerArmedFor: number | null; lastSyncError?: string } {
    return {
      systemScheduler: this.config.useSystemScheduler && systemSchedulerSupported(),
      systemTaskArmedFor: this.systemTaskArmedFor,
      timerArmedFor: this.scheduler.armedFor,
      lastSyncError: this.lastSyncError,
    }
  }

  /**
   * Claim everything due as of now, flipping each alarm out of `pending`.
   * @param trigger - which layer is claiming.
   * @returns the alarms this caller now owns.
   */
  claimDue(trigger: FireTrigger): ClockAlarm[] {
    const now = this.now()
    const due = this.store.pending().filter((alarm) => alarm.at <= now)
    for (const alarm of due) {
      this.store.patch(alarm.id, { status: 'fired', firedAt: now, via: trigger })
    }
    return due
  }

  /** Deliver one already-claimed alarm and record the outcome. */
  async deliver(alarm: ClockAlarm, trigger: FireTrigger): Promise<void> {
    const controller = this.controller()
    if (controller === undefined) {
      this.store.patch(alarm.id, { error: 'sessionController is not available in this profile' })
      return
    }
    const result = await deliverWake(controller, alarm, this.now(), this.config, trigger)
    if (result.ok) {
      this.store.patch(alarm.id, { deliveredText: result.text, error: undefined })
    } else {
      this.store.patch(alarm.id, { error: result.error })
      this.log('wake failed for ' + alarm.id + ': ' + result.error)
    }
  }

  /** Claim and deliver everything due, awaited. */
  async fireDue(trigger: FireTrigger): Promise<number> {
    const due = this.claimDue(trigger)
    if (due.length === 0) return 0
    await Promise.allSettled(due.map((alarm) => this.deliver(alarm, trigger)))
    await this.scheduler.resync()
    return due.length
  }

  /**
   * Fire one named alarm now, regardless of its instant.
   * @param id - alarm identity.
   * @param trigger - how it was triggered.
   * @returns the alarm, or undefined when it does not exist.
   */
  async fireOne(id: string, trigger: FireTrigger): Promise<ClockAlarm | undefined> {
    const alarm = this.store.get(id)
    if (alarm === undefined) return undefined
    this.store.patch(id, { status: 'fired', firedAt: this.now(), via: trigger, error: undefined })
    await this.deliver(this.store.get(id)!, trigger)
    await this.scheduler.resync()
    return this.store.get(id)
  }

  /** Create one alarm and re-arm. */
  async create(input: AlarmInput): Promise<ClockAlarm> {
    const alarm = createAlarm(input, this.now())
    this.store.add(alarm)
    await this.scheduler.resync()
    return alarm
  }

  /** Replace the instant, keyword, note, or target of a pending alarm. */
  async update(id: string, patch: Partial<ClockAlarm>): Promise<ClockAlarm | undefined> {
    const alarm = this.store.patch(id, patch)
    if (alarm !== undefined) await this.scheduler.resync()
    return alarm
  }

  /** Cancel a pending alarm, keeping it visible as a cancelled row. */
  async cancel(id: string): Promise<ClockAlarm | undefined> {
    const alarm = this.store.get(id)
    if (alarm === undefined) return undefined
    const updated = this.store.patch(id, { status: 'cancelled' })
    await this.scheduler.resync()
    return updated
  }

  /** Drop an alarm entirely. */
  async forget(id: string): Promise<boolean> {
    const removed = this.store.remove(id)
    if (removed) await this.scheduler.resync()
    return removed
  }

  /** Resolve the session controller, preferring an injected test double. */
  private controller(): SessionControllerLike | undefined {
    if (this.injectedController !== undefined) return this.injectedController
    const service = this.ctx.get?.('sessionController') as SessionControllerLike | undefined
    return service === undefined ? undefined : service
  }

  private persistence(): SessionPersistenceLike | undefined {
    return this.ctx.get?.('sessionPersistence') as SessionPersistenceLike | undefined
  }

  /**
   * Live and stored conversations, newest first.
   *
   * The stored half is the point: an alarm exists to reach a conversation that
   * may be closed, and the live store only contains sessions somebody has
   * opened in this host generation.
   * @returns picker rows.
   */
  async listSessions(): Promise<ClockSessionView[]> {
    const rows: ClockSessionView[] = []
    const known = new Set<string>()
    for (const session of this.ctx.sessions?.list() ?? []) {
      if (isSubagentSession(session.header)) continue
      const events = session.snapshotEvents === undefined ? [] : normalizeEvents(session.snapshotEvents())
      const last = events[events.length - 1]
      known.add(session.id)
      rows.push({
        id: session.id,
        title: titleFromEvents(events, session.id),
        cwd: session.header?.cwd,
        createdAt: session.header?.createdAt ?? 0,
        updatedAt: last === undefined ? session.header?.createdAt ?? 0 : last.time,
        cold: false,
      })
    }
    const persistence = this.persistence()
    if (persistence !== undefined) {
      try {
        for (const snapshot of await persistence.list()) {
          if (isSubagentSession(snapshot.header)) continue
          const id = snapshot.header?.id
          if (typeof id !== 'string' || id === '' || known.has(id)) continue
          known.add(id)
          const createdAt = snapshot.header?.createdAt ?? 0
          rows.push({
            id,
            title: this.storedTitles.get(id) ?? id,
            cwd: snapshot.header?.cwd,
            createdAt,
            updatedAt: createdAt,
            cold: true,
          })
        }
      } catch {
        // A broken stored list must not take the live list down with it.
      }
    }
    return rows.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /**
   * Read stored conversation titles once, in the background.
   *
   * A persistence snapshot carries only a header, so a cold conversation has no
   * title until its log is opened. Opening every log on the request path would
   * make the picker slow and would hold read handles while the panel is open, so
   * this runs once after start, writes each title as it lands, and is purely
   * additive: rows are usable (by id) before it finishes.
   */
  async refreshStoredTitles(): Promise<void> {
    if (this.indexing) return
    const persistence = this.persistence()
    if (persistence === undefined) return
    this.indexing = true
    try {
      const snapshots = await persistence.list()
      this.titleIndex.snapshots = snapshots.length
      for (const snapshot of snapshots) {
        const id = snapshot.header?.id
        if (typeof id !== 'string' || id === '' || this.storedTitles.has(id)) continue
        this.titleIndex.attempted += 1
        let handle: PersistenceHandleLike | undefined
        try {
          handle = await persistence.open(id, 'read')
          const inspection = await handle.read()
          const raw = inspection.events ?? []
          if (this.titleIndex.rawEvents < 0) {
            this.titleIndex.rawEvents = raw.length
            const first = raw[0]
            this.titleIndex.sampleEventKeys =
              first === undefined || first === null || typeof first !== 'object'
                ? '(first entry is ' + String(first) + ')'
                : Object.keys(first as Record<string, unknown>).join(',')
          }
          const events = normalizeEvents(raw)
          const title = titleFromEvents(events, id)
          this.storedTitles.set(id, title)
          if (title !== id) this.titleIndex.titled += 1
        } catch (error) {
          this.titleIndex.failed += 1
          this.titleIndex.lastError = String(error).slice(0, 200)
          this.storedTitles.set(id, id)
        } finally {
          try {
            await handle?.close?.()
          } catch {
            // Releasing a read handle is best effort.
          }
        }
      }
    } catch {
      // The picker simply keeps showing ids.
    } finally {
      this.indexing = false
    }
  }

  /** Everything the panel renders in one read. */
  async state(): Promise<ClockStateView> {
    return {
      now: this.now(),
      timeZone: this.timeZone,
      alarms: this.store.all(),
      sessions: await this.listSessions(),
      scheduler: this.schedulerState,
      titleIndex: { ...this.titleIndex },
      config: {
        port: this.config.port,
        dataDir: this.config.dataDir,
        defaultTimeZone: this.timeZone,
        wakeMode: this.config.wakeMode,
      },
    }
  }

  /** Stop the scheduler and release the OS task. */
  async dispose(): Promise<void> {
    this.scheduler.dispose()
    if (this.config.useSystemScheduler && systemSchedulerSupported()) {
      await this.syncSystemTask(null)
    }
  }
}

/** Re-exported so the plugin entry can build one without importing the store module. */
export { resolveConfig }
export type { AlarmOrigin }
