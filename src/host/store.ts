/**
 * The durable alarm table.
 *
 * Alarms are cross-session, so the session log — the harness's own durability
 * mechanism — is the wrong home for them: an alarm written into session A must
 * still exist when session A is closed and only session B is being used. This
 * store is therefore a plain JSON file under the plugin data directory, written
 * atomically (temp file plus rename) so a kill mid-write leaves the previous
 * table intact rather than a truncated one.
 *
 * @module dsh-clock/host/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { AlarmOrigin, ClockAlarm, ClockConfig, FireTrigger, ResolvedConfig } from '../shared/types.ts'

/** Resolve the plugin data directory, defaulting to `$DSH_HOME/clock`. */
export function resolveDataDir(configured?: string): string {
  if (configured !== undefined && configured !== '') return configured
  const home = process.env.DSH_HOME ?? process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  const base = home.endsWith('.dsh') ? home : join(home, '.dsh')
  return join(base, 'clock')
}

/** Fill in defaults for a partial configuration. */
export function resolveConfig(partial: Partial<ClockConfig> | undefined): ResolvedConfig {
  const input = partial ?? {}
  return {
    dataDir: resolveDataDir(input.dataDir),
    port: typeof input.port === 'number' && input.port > 0 ? input.port : 4801,
    useSystemScheduler: input.useSystemScheduler !== false,
    exposeTool: input.exposeTool !== false,
    defaultTimeZone: input.defaultTimeZone ?? '',
    wakeMode: input.wakeMode === 'steer' ? 'steer' : 'queue',
    retainFiredDays: typeof input.retainFiredDays === 'number' && input.retainFiredDays >= 0 ? input.retainFiredDays : 7,
    driftToleranceSeconds:
      typeof input.driftToleranceSeconds === 'number' && input.driftToleranceSeconds >= 0 ? input.driftToleranceSeconds : 60,
    wakeComputer: input.wakeComputer === true,
  }
}

/** Fixed-width local stamp used to make ids sort by creation. */
function stamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return (
    String(date.getUTCFullYear()) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds())
  )
}

/**
 * Allocate a collision-resistant alarm id.
 * @param at - scheduled instant, used as the sortable prefix.
 * @returns the id.
 */
export function allocateAlarmId(at: number): string {
  const random = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, '0')
  return 'a-' + stamp(at) + '-' + random
}

/** A create request as the tool and the HTTP API both express it. */
export interface AlarmInput {
  at: number
  timeZone: string
  keyword: string
  note?: string
  sessionId: string
  sessionTitle?: string
  label?: string
  origin: AlarmOrigin
}

/** Why a create request was refused. */
export class AlarmInputError extends Error {}

/**
 * Validate and normalize one create request.
 * @param input - the raw request.
 * @returns a pending alarm ready to persist.
 * @throws {AlarmInputError} when a required field is missing or malformed.
 */
export function createAlarm(input: AlarmInput, now: number): ClockAlarm {
  if (!Number.isFinite(input.at)) throw new AlarmInputError('at must be a finite epoch-millisecond instant')
  if (typeof input.sessionId !== 'string' || input.sessionId.trim() === '') {
    throw new AlarmInputError('sessionId is required: an alarm must name the conversation to wake')
  }
  const keyword = typeof input.keyword === 'string' ? input.keyword.trim() : ''
  if (keyword === '') throw new AlarmInputError('keyword is required: it is what opens the wake message')
  return {
    id: allocateAlarmId(input.at),
    at: Math.round(input.at),
    timeZone: input.timeZone,
    keyword,
    note: input.note?.trim() === '' ? undefined : input.note?.trim(),
    sessionId: input.sessionId.trim(),
    sessionTitle: input.sessionTitle,
    label: input.label?.trim() === '' ? undefined : input.label?.trim(),
    origin: input.origin,
    createdAt: now,
    status: 'pending',
  }
}

/**
 * The in-memory table with its one durable file behind it.
 *
 * Every mutation persists before it returns, so a caller that has seen a
 * successful add can rely on the alarm surviving a kill. The table is written
 * whole rather than appended: it is small, and a whole-file rewrite is the
 * cheapest way to keep it always-parseable.
 */
export class AlarmStore {
  private readonly file: string
  private alarms: ClockAlarm[] = []
  private loaded = false

  /** @param dataDir - directory holding `alarms.json`. */
  constructor(dataDir: string) {
    this.file = join(dataDir, 'alarms.json')
  }

  /** Path of the backing file, for diagnostics. */
  get path(): string {
    return this.file
  }

  /** Read the table, tolerating a missing or unparseable file by starting empty. */
  load(): ClockAlarm[] {
    if (this.loaded) return this.alarms
    this.loaded = true
    if (!existsSync(this.file)) return this.alarms
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      const rows = Array.isArray(parsed) ? parsed : (parsed as { alarms?: unknown }).alarms
      if (Array.isArray(rows)) {
        this.alarms = rows.filter((row): row is ClockAlarm => {
          const candidate = row as Partial<ClockAlarm>
          return typeof candidate?.id === 'string' && Number.isFinite(candidate?.at) && typeof candidate?.sessionId === 'string'
        })
      }
    } catch {
      // A corrupt table must not take the host down; an empty one is recoverable
      // by re-creating an alarm, whereas a thrown plugin error is not.
      this.alarms = []
    }
    return this.alarms
  }

  /** Every alarm, newest scheduled first. */
  all(): ClockAlarm[] {
    return this.load()
      .slice()
      .sort((left, right) => left.at - right.at)
  }

  /** Every alarm that can still fire, soonest first. */
  pending(): ClockAlarm[] {
    return this.all().filter((alarm) => alarm.status === 'pending')
  }

  /** Look one alarm up by id. */
  get(id: string): ClockAlarm | undefined {
    return this.load().find((alarm) => alarm.id === id)
  }

  /** Append one alarm and persist. */
  add(alarm: ClockAlarm): ClockAlarm {
    this.load().push(alarm)
    this.persist()
    return alarm
  }

  /** Apply a partial update and persist. */
  patch(id: string, patch: Partial<ClockAlarm>): ClockAlarm | undefined {
    const alarm = this.get(id)
    if (alarm === undefined) return undefined
    Object.assign(alarm, patch)
    this.persist()
    return alarm
  }

  /** Drop one alarm entirely. */
  remove(id: string): boolean {
    const rows = this.load()
    const index = rows.findIndex((alarm) => alarm.id === id)
    if (index < 0) return false
    rows.splice(index, 1)
    this.persist()
    return true
  }

  /**
   * Forget settled alarms older than the retention window.
   * @param now - current instant.
   * @param retainFiredDays - how long a settled alarm stays visible.
   * @returns how many rows were dropped.
   */
  prune(now: number, retainFiredDays: number): number {
    const rows = this.load()
    const cutoff = now - retainFiredDays * 86400000
    const kept = rows.filter((alarm) => alarm.status === 'pending' || (alarm.firedAt ?? alarm.at) >= cutoff)
    const dropped = rows.length - kept.length
    if (dropped > 0) {
      this.alarms = kept
      this.persist()
    }
    return dropped
  }

  /** Replace the whole table, used by tests and by a full re-read. */
  replace(rows: ClockAlarm[]): void {
    this.alarms = rows
    this.loaded = true
    this.persist()
  }

  /** Write the table atomically. */
  private persist(): void {
    const directory = dirname(this.file)
    mkdirSync(directory, { recursive: true })
    const temporary = this.file + '.tmp'
    writeFileSync(temporary, JSON.stringify({ version: 1, alarms: this.alarms }, null, 2), 'utf8')
    renameSync(temporary, this.file)
  }

  /** Remove the backing file entirely, used by tests. */
  destroy(): void {
    for (const target of [this.file, this.file + '.tmp']) {
      if (existsSync(target)) {
        try {
          unlinkSync(target)
        } catch {
          // Nothing to do: the file is already gone.
        }
      }
    }
    this.alarms = []
    this.loaded = false
  }
}

/** Narrow a persisted trigger name, used when re-reading older rows. */
export function asTrigger(value: unknown): FireTrigger | undefined {
  return value === 'timer' || value === 'system-scheduler' || value === 'overdue-replay' || value === 'manual'
    ? value
    : undefined
}
