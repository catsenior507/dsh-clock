/**
 * Browser-side helpers: transport, time formatting, and the month grid.
 *
 * The transport mirrors the host's two carriers. The panel first tries its own
 * origin, which is where the route lives when the harness web server mounted it,
 * and falls back to the plugin's private loopback range otherwise. The base is
 * cached so a successful probe is paid once.
 *
 * @module dsh-clock/client/clock
 */

import type { ClockAlarm, ClockStateView } from '../shared/types.ts'

/** The port the host prefers for its private carrier. */
const BASE_PORT = 4801

/** How many consecutive ports the host may have walked. */
const PORT_ATTEMPTS = 8

const API = '/api/clock'

let resolvedBase: string | null = null

/** Probe one base for a live endpoint. */
async function probe(base: string): Promise<boolean> {
  try {
    const response = await fetch(base + '/state', { headers: { accept: 'application/json' } })
    return response.ok
  } catch {
    return false
  }
}

/** Resolve the API base, preferring the panel's own origin. */
export async function apiBase(): Promise<string> {
  if (resolvedBase !== null) return resolvedBase
  if (await probe(API)) {
    resolvedBase = API
    return resolvedBase
  }
  for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
    const candidate = 'http://127.0.0.1:' + String(BASE_PORT + offset) + API
    if (await probe(candidate)) {
      resolvedBase = candidate
      return resolvedBase
    }
  }
  resolvedBase = API
  return resolvedBase
}

/** The failure shape every call collapses to. */
export class ClockApiError extends Error {}

/** Call one endpoint and unwrap the ok/value envelope. */
export async function call<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const base = await apiBase()
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = (await response.json()) as { ok?: boolean; value?: unknown; error?: string }
  if (payload.ok !== true) throw new ClockApiError(payload.error ?? 'request failed')
  return payload.value as T
}

/**
 * Tell the host what the browser half is doing.
 *
 * Deliberately silent on every failure: a diagnostic that can break the very
 * feature it is diagnosing is worse than no diagnostic, and this runs during
 * activation, where a rejected promise would be an unhandled rejection.
 * @param message - one line to record.
 */
export function report(message: string): void {
  void (async () => {
    try {
      const base = await apiBase()
      await fetch(base + '/client-log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      })
    } catch {
      // The host is unreachable or refused the request; nothing to do.
    }
  })()
}

/** Read the whole panel state. */
export function fetchState(): Promise<ClockStateView> {
  return call<ClockStateView>('/state')
}

/** Format an instant as HH:MM:SS in a zone. */
export function formatTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms))
}

/** Format an instant as YYYY-MM-DD in a zone. */
export function formatDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}

/** Format an instant as HH:MM in a zone. */
export function formatHm(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
}

/** Signed compact countdown, e.g. \u002b2h13m or -4s. */
export function countdownText(deltaMs: number): string {
  const sign = deltaMs < 0 ? '-' : ''
  let rest = Math.abs(Math.round(deltaMs / 1000))
  const days = Math.floor(rest / 86400)
  rest -= days * 86400
  const hours = Math.floor(rest / 3600)
  rest -= hours * 3600
  const minutes = Math.floor(rest / 60)
  const seconds = rest - minutes * 60
  const parts: string[] = []
  if (days > 0) parts.push(String(days) + '天')
  if (hours > 0) parts.push(String(hours) + '小时')
  if (minutes > 0) parts.push(String(minutes) + '分')
  if (seconds > 0 || parts.length === 0) parts.push(String(seconds) + '秒')
  return sign + parts.join('')
}

/** One cell of the month grid. */
export interface DayCell {
  key: string
  day: number
  inMonth: boolean
  isToday: boolean
}

/**
 * Build a Monday-first month grid.
 * @param year - calendar year.
 * @param month - 0-based month.
 * @param todayKey - today as YYYY-MM-DD, for the highlight.
 * @returns six weeks of cells, always 42 entries so the panel height is stable.
 */
export function monthGrid(year: number, month: number, todayKey: string): DayCell[] {
  const first = new Date(year, month, 1)
  const offset = (first.getDay() + 6) % 7
  const cells: DayCell[] = []
  const start = new Date(year, month, 1 - offset)
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    const key =
      String(date.getFullYear()) +
      '-' +
      String(date.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(date.getDate()).padStart(2, '0')
    cells.push({ key, day: date.getDate(), inMonth: date.getMonth() === month, isToday: key === todayKey })
  }
  return cells
}

/** Bucket alarms by their local calendar day, for the grid dots. */
export function alarmsByDay(alarms: readonly ClockAlarm[], timeZone: string): Map<string, ClockAlarm[]> {
  const map = new Map<string, ClockAlarm[]>()
  for (const alarm of alarms) {
    const key = formatDate(alarm.at, alarm.timeZone === '' ? timeZone : alarm.timeZone)
    const bucket = map.get(key)
    if (bucket === undefined) map.set(key, [alarm])
    else bucket.push(alarm)
  }
  return map
}

/** Combine a YYYY-MM-DD key and an HH:MM string into an epoch instant. */
export function instantFromLocal(dayKey: string, time: string): number {
  const [year, month, day] = dayKey.split('-').map((part) => Number(part))
  const [hour, minute] = time.split(':').map((part) => Number(part))
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, 0, 0).getTime()
}
