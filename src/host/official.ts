/**
 * Mapping between the official schedule records and the shape this panel draws.
 *
 * dsh 0.2.x ships a schedule service (`ctx.schedule`) and a full UI for it. This
 * plugin used to keep its own alarm store, its own delivery engine and a
 * PowerShell task mirror; all of that is being retired in favour of the official
 * system. The panel keeps its own vocabulary, so the two need a translation, and
 * that translation is the piece worth testing on its own: it is pure, it has no
 * dependency on the harness, and every later step is built on it.
 *
 * @module dsh-clock/host/official
 */

/** The subset of an official schedule record this module reads. */
export interface ScheduleRecordLike {
  id: string
  kind: string
  title: string
  prompt: string
  /** ISO instant the schedule was stored for, when the kind has one. */
  scheduledAt?: string
  /** `scheduled` or `overdue`. */
  state?: string
  timeZone?: string
}

/** What the panel renders for one alarm. */
export interface AlarmView {
  id: string
  /** Epoch milliseconds. */
  at: number
  timeZone: string
  keyword: string
  note: string
  /** The panel only knows these two states. */
  status: 'pending' | 'fired'
  /** True when the official record says the instant has passed. */
  late: boolean
}

/**
 * Translate one official record into the panel shape.
 *
 * Two decisions are deliberate. `title` becomes the keyword and `prompt` the
 * note, because that is what the panel labels them and what the old alarm store
 * called them. And an unparseable `scheduledAt` is reported as time zero rather
 * than dropped: a row the user cannot see is worse than a row with an odd time.
 *
 * @param record - the official record.
 * @param now - clock, injected for tests.
 * @returns the alarm view.
 */
export function toAlarm(record: ScheduleRecordLike, now: number): AlarmView {
  const at = record.scheduledAt === undefined ? 0 : Date.parse(record.scheduledAt)
  const instant = Number.isFinite(at) ? at : 0
  const overdue = record.state === 'overdue'
  return {
    id: record.id,
    at: instant,
    timeZone: record.timeZone ?? 'Asia/Shanghai',
    keyword: record.title,
    note: record.prompt,
    status: overdue && instant <= now ? 'fired' : 'pending',
    late: overdue,
  }
}

/**
 * Build the request that creates a one-shot official schedule.
 *
 * Only one-shot creation is translated here. Recurring kinds are supported by the
 * official service but the panel has no control for them yet, and inventing a
 * weekly rule from a single date would be a lie about what the user asked for.
 * @param input - what the panel collected.
 * @returns the create request.
 */
export interface CreateInput {
  at: number
  keyword: string
  note: string
  timeZone: string
}

/**
 * Turn the panel input into an official create request.
 * @param input - what the panel collected.
 * @returns the request body for `ctx.schedule.create`.
 */
export function toCreateRequest(input: CreateInput): Record<string, unknown> {
  return {
    title: input.keyword === '' ? '唤醒' : input.keyword,
    prompt: input.note,
    at: new Date(input.at).toISOString(),
    timeZone: input.timeZone,
  }
}
