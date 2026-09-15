/**
 * Vocabulary shared by the host half, the browser panel, and the tests.
 *
 * @module dsh-clock/shared/types
 */

/** How an alarm ended up. A pending alarm is the only one that can still fire. */
export type AlarmStatus = 'pending' | 'fired' | 'cancelled'

/** Which layer actually delivered a wake. */
export type FireTrigger = 'timer' | 'system-scheduler' | 'overdue-replay' | 'manual'

/** Who created the alarm. */
export type AlarmOrigin = 'user' | 'agent'

/**
 * One durable wake request: "when the clock passes `at`, put `keyword`
 * into conversation `sessionId`".
 *
 * Alarms are global rather than session-local on purpose — the whole point is
 * to reach a conversation other than the one that created the alarm, including
 * one that is not currently open.
 */
export interface ClockAlarm {
  /** Stable identity, also used as the prompt request id prefix. */
  id: string
  /** Absolute trigger instant, epoch milliseconds (UTC). Zone-free by design. */
  at: number
  /** IANA zone the human picked `at` in, kept so the panel redraws it faithfully. */
  timeZone: string
  /** The token that opens the wake message. */
  keyword: string
  /** Optional longer instruction carried alongside the keyword. */
  note?: string
  /** Target conversation. */
  sessionId: string
  /** Display title of the target, cached so a cold target still reads well. */
  sessionTitle?: string
  /** Optional human label for the alarm itself. */
  label?: string
  origin: AlarmOrigin
  createdAt: number
  status: AlarmStatus
  /** When the wake was actually delivered, epoch ms. */
  firedAt?: number
  /** The exact text handed to the target conversation. */
  deliveredText?: string
  /** Which layer delivered it. */
  via?: FireTrigger
  /** Delivery failure, kept so a failed wake is visible instead of silent. */
  error?: string
  /**
   * The alarm this one was copied from, when a branch received a copy.
   *
   * It is what makes "this branch is already covered" answerable: comparing
   * keyword and instant would call two deliberately identical alarms a copy,
   * and copying again on every state read would multiply them.
   */
  copyOf?: string
}

/** Plugin configuration with defaults resolved. */
export interface ClockConfig {
  dataDir?: string
  port?: number
  useSystemScheduler?: boolean
  exposeTool?: boolean
  defaultTimeZone?: string
  wakeMode?: 'queue' | 'steer'
  retainFiredDays?: number
  driftToleranceSeconds?: number
  /** Let the OS task wake the machine from sleep. Off by default: it is a strong side effect. */
  wakeComputer?: boolean
}

/** Configuration as the running plugin holds it. */
export interface ResolvedConfig extends ClockConfig {
  dataDir: string
  port: number
  useSystemScheduler: boolean
  exposeTool: boolean
  defaultTimeZone: string
  wakeMode: 'queue' | 'steer'
  retainFiredDays: number
  driftToleranceSeconds: number
  wakeComputer: boolean
}

/** One target-conversation row for the panel picker. */
export interface ClockSessionView {
  id: string
  title: string
  cwd?: string
  createdAt: number
  updatedAt: number
  /** True when the conversation has no live session and must be resumed to wake. */
  cold: boolean
  /** The conversation this one branched from, when it is a branch. */
  parentSession?: string
}

/**
 * A branch whose parent still carries pending alarms.
 *
 * Branching copies the conversation but not the alarm table, so an alarm set
 * before the branch keeps pointing at the parent and the branch is never woken.
 * This is the question the panel asks about that.
 */
export interface ClockForkPrompt {
  /** The branch, which is not covered yet. */
  sessionId: string
  title: string
  /** The conversation the alarms still point at. */
  parentId: string
  parentTitle: string
  /** How many pending alarms would have to be copied. */
  alarms: number
}

/** Everything the panel needs in one read. */
export interface ClockStateView {
  now: number
  timeZone: string
  alarms: ClockAlarm[]
  sessions: ClockSessionView[]
  scheduler: {
    /** Whether the OS-level mirror is active and what it is armed for. */
    systemScheduler: boolean
    systemTaskArmedFor: number | null
    /** When the in-process timer will next wake the host. */
    timerArmedFor: number | null
    lastSyncError?: string
  }
  /** Branches of alarmed conversations that are not covered by a copy yet. */
  forks: ClockForkPrompt[]
  /** What the background stored-title read did, so a title-less picker is diagnosable. */
  titleIndex: {
    snapshots: number
    attempted: number
    titled: number
    failed: number
    rawEvents: number
    sampleEventKeys: string
    lastError: string
  }
  config: {
    port: number
    dataDir: string
    defaultTimeZone: string
    wakeMode: 'queue' | 'steer'
  }
}

/** Result of one delivery attempt. */
export type WakeResult = { ok: true; text: string } | { ok: false; error: string }
