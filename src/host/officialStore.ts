/**
 * The alarm store, backed by the harness schedule service.
 *
 * dsh 0.2.x ships `ctx.schedule`: durable records, host-side delivery, a UI and
 * a model-facing tool. This plugin grew its own alarm store, its own delivery
 * engine and a PowerShell task mirror before that existed, and keeping two
 * delivery path s is how a reminder fires twice or not at all.
 *
 * This module is the seam. It offers the panel the vocabulary it already uses -
 * an alarm with a keyword, a note and an instant - over records the harness
 * owns. Everything above it can stay; the engine below it is deleted.
 *
 * Kept free of the cordis context so it can be tested against a fake service.
 *
 * @module dsh-clock/host/officialStore
 */

/** The subset of a schedule record this module reads. */
export interface RecordLike {
  id: string
  title: string
  prompt: string
  /** RFC3339 instant, when the kind has one. */
  scheduledAt?: string
  /** `scheduled` or `overdue`. */
  state?: string
  timeZone?: string
}

/** What the panel renders for one alarm. */
export interface AlarmLike {
  id: string
  at: number
  timeZone: string
  keyword: string
  note: string
  status: 'pending' | 'fired'
  late: boolean
}

/** What the service must offer. Narrow on purpose: that is the whole contract. */
export interface ScheduleLike {
  list(request: { sessionId?: string }): Promise<RecordLike[]>
  create(sessionId: string, request: Record<string, unknown>): Promise<RecordLike>
  update(request: Record<string, unknown>): Promise<{ record?: RecordLike } | RecordLike>
  delete(request: Record<string, unknown>): Promise<unknown>
}

/**
 * Translate one official record into the panel shape.
 *
 * An instant that will not parse is reported as time zero rather than dropped:
 * a row the user cannot see is worse than a row with an odd time. The panel
 * shows the number, so an unusable one is visible and arguable, while a missing
 * row is not.
 * @param record - the official record.
 * @param now - the clock, injected for tests.
 * @returns the alarm.
 */
export function toAlarm(record: RecordLike, now: number): AlarmLike {
  const parsed = record.scheduledAt === undefined ? NaN : Date.parse(record.scheduledAt)
  const at = Number.isFinite(parsed) ? parsed : 0
  const overdue = record.state === 'overdue'
  return {
    id: record.id,
    at,
    timeZone: record.timeZone ?? 'Asia/Shanghai',
    keyword: record.title,
    note: record.prompt,
    status: overdue && at <= now ? 'fired' : 'pending',
    late: overdue,
  }
}

/**
 * Build the create request for a one-shot alarm.
 *
 * Only one-shot is translated. The official service supports recurrence, but
 * the panel has no control for it, and inventing a weekly rule from a single
 * date would misstate what the user asked for.
 * @param input - what the panel collected.
 * @returns the request.
 */
export function toCreateRequest(input: {
  at: number
  timeZone: string
  keyword: string
  note: string
}): Record<string, unknown> {
  const title = input.keyword.trim() === '' ? 'reminder' : input.keyword.trim().slice(0, 120)
  const prompt = input.note.trim() === '' ? title : input.note
  // AtInput is `string | { date, time, time_zone }`. An absolute instant is
  // unambiguous as an ISO string, so the zone travels with it and the shape
  // needs no wall-clock fields to be invented.
  return {
    title,
    prompt,
    at: new Date(input.at).toISOString(),
  }
}

/** A schedule record as `list()` returns it: the record plus its session. */
export interface CatalogLike extends RecordLike {
  sessionId: string
  /**
   * `active` while the record can still deliver, `inactive` once it is done.
   *
   * This - not `state` - is what says a one-shot reminder has been delivered:
   * a delivered record keeps `state: "scheduled"` and only flips this flag.
   * Reading `state` alone put delivered alarms back in the pending column.
   */
  status?: string
  /** Present once a delivery was durably acknowledged. */
  lastDelivery?: { scheduledAt?: string; deliveredAt?: string; messageId?: string }
}

/** The panel's alarm, as the clock plugin already defines it. */
export interface ClockAlarmLike {
  id: string
  at: number
  timeZone: string
  keyword: string
  note?: string
  sessionId: string
  sessionTitle?: string
  label?: string
  origin: 'user'
  createdAt: number
  status: 'pending' | 'fired' | 'cancelled'
  firedAt?: number
  deliveredText?: string
  via?: string
  error?: string
  copyOf?: string
}

/**
 * Map one official record onto the alarm the panel draws.
 *
 * `origin` and `createdAt` have no official counterpart and are not optional in
 * the panel's type. Both are filled with the truth as far as it is knowable:
 * every alarm this plugin surfaces was created by the user, and the only time
 * the record carries is the instant it was scheduled for.
 * @param entry - the record with its session binding.
 * @param now - the clock, injected for tests.
 * @param defaultZone - zone to use when the record names none.
 * @returns the alarm.
 */
export function toClockAlarm(entry: CatalogLike, now: number, defaultZone: string): ClockAlarmLike {
  const parsed = entry.scheduledAt === undefined ? NaN : Date.parse(entry.scheduledAt)
  const at = Number.isFinite(parsed) ? parsed : 0
  const state = entry.state ?? 'scheduled'
  // An inactive record has delivered (or was retired); it never delivers again.
  // A lastDelivery receipt is the same fact stated twice, so either one decides.
  const delivered = entry.status === 'inactive' || entry.lastDelivery !== undefined
  const status: ClockAlarmLike['status'] = delivered
    ? 'fired'
    : state === 'overdue' && at <= now ? 'fired' : 'pending'
  return {
    id: entry.id,
    at,
    timeZone: entry.timeZone ?? defaultZone,
    keyword: entry.title,
    note: entry.prompt,
    sessionId: entry.sessionId,
    origin: 'user',
    createdAt: at,
    status,
    ...(delivered ? { firedAt: at } : {}),
  }
}
