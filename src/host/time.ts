/**
 * Zone-aware clock arithmetic.
 *
 * Every instant this plugin stores is epoch milliseconds, and every zone is an
 * IANA name. Nothing is stored as a local wall-clock string, because a machine
 * that changes zone between scheduling and firing must still deliver at the
 * instant the user meant.
 *
 * @module dsh-clock/host/time
 */

/** The process time zone, used when configuration names none. */
export function processTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * Validate an IANA zone by asking the platform to format with it.
 * @param timeZone - candidate zone name.
 * @returns whether the platform accepts it.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/** Offset of `timeZone` at `ms`, as `+08:00` / `-05:30` / `+00:00`. */
export function zoneOffset(ms: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(new Date(ms))
    const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT'
    const offset = name.replace('GMT', '')
    return offset === '' ? '+00:00' : offset
  } catch {
    return '+00:00'
  }
}

/** `2026-09-11 09:30:00` in `timeZone`. */
export function formatInZone(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
  }
}

/** `2026-09-11T09:30:00+08:00` — an RFC 3339 shape the model reads unambiguously. */
export function isoInZone(ms: number, timeZone: string): string {
  return formatInZone(ms, timeZone).replace(' ', 'T') + zoneOffset(ms, timeZone)
}

/** Calendar date key `2026-09-11` in `timeZone`, used to bucket alarms by day. */
export function dateKeyInZone(ms: number, timeZone: string): string {
  return formatInZone(ms, timeZone).slice(0, 10)
}

/**
 * Compact signed duration: `+4s`, `+2h13m`, `-90s`.
 * @param deltaMs - signed difference.
 * @returns the compact form.
 */
export function durationText(deltaMs: number): string {
  const sign = deltaMs < 0 ? '-' : '+'
  let rest = Math.abs(Math.round(deltaMs / 1000))
  const days = Math.floor(rest / 86400)
  rest -= days * 86400
  const hours = Math.floor(rest / 3600)
  rest -= hours * 3600
  const minutes = Math.floor(rest / 60)
  const seconds = rest - minutes * 60
  const parts: string[] = []
  if (days > 0) parts.push(days + 'd')
  if (hours > 0) parts.push(hours + 'h')
  if (minutes > 0) parts.push(minutes + 'm')
  if (seconds > 0 || parts.length === 0) parts.push(seconds + 's')
  return sign + parts.join('')
}

/** How far off a delivery was, as the model should read it. */
export type DriftVerdict = 'on-time' | 'overdue' | 'early'

/**
 * Classify delivery drift.
 * @param driftMs - actual minus scheduled, signed.
 * @param toleranceSeconds - how much lateness still counts as on time.
 * @returns the verdict.
 */
export function driftVerdict(driftMs: number, toleranceSeconds: number): DriftVerdict {
  const tolerance = toleranceSeconds * 1000
  if (driftMs > tolerance) return 'overdue'
  if (driftMs < -tolerance) return 'early'
  return 'on-time'
}

/** Smallest delay Node timers represent without clamping to 1ms. */
export const MAX_TIMER_DELAY_MS = 2147483647
