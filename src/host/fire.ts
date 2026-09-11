/**
 * Turning a due alarm into a message in another conversation.
 *
 * The delivery primitive is the harness's own `ctx.sessionController.prompt`.
 * That method is documented to *resolve or resume* an ordinary Session, which
 * is exactly the capability a cross-session wake needs: a conversation that is
 * closed, or that was never opened in this host generation, is resumed before
 * the message lands, so there is no second wake mechanism to maintain here.
 *
 * Two properties are load-bearing:
 *
 * - **The request id is derived from the alarm id.** The controller treats a
 *   repeated request id as the *same* prompt and returns the original
 *   acceptance without inserting a second message. Since three layers (the
 *   in-process timer, the OS scheduler, and the overdue replay at startup) can
 *   all decide to fire the same alarm, that idempotency is what keeps a wake
 *   from arriving two or three times.
 * - **The text carries the clock.** A wake that arrives late is the normal
 *   case — the host may not have been running at the scheduled instant — so the
 *   message states the scheduled time, the actual time, the signed drift, and
 *   an explicit warning when the drift is out of tolerance. Without that, the
 *   woken agent cannot tell "it is 09:30 as planned" from "it is 11:43 and you
 *   are three hours late".
 *
 * @module dsh-clock/host/fire
 */

import type { ClockAlarm, ResolvedConfig } from '../shared/types.ts'
import { driftVerdict, durationText, isoInZone } from './time.ts'

/** The session-controller surface this plugin uses, restated so no harness type is imported. */
export interface SessionControllerLike {
  prompt(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}

/** How long a single delivery may take before it is abandoned. */
export const WAKE_TIMEOUT_MS = 120000

/** Human wording for each trigger layer. */
const TRIGGER_LABEL: Record<string, string> = {
  timer: 'in-process timer',
  'system-scheduler': 'OS scheduler (Windows Task Scheduler)',
  'overdue-replay': 'catch-up replay at host start',
  manual: 'manual fire from the panel',
}

/** The rendered wake message and the facts it was built from. */
export interface WakeText {
  text: string
  driftMs: number
  verdict: 'on-time' | 'overdue' | 'early'
}

/**
 * Render the message a woken conversation receives.
 *
 * Framework wording is English so the plugin reads the same for every user;
 * the keyword and the note are interpolated verbatim, so they stay in whatever
 * language their author wrote.
 * @param alarm - the alarm being delivered.
 * @param now - the instant delivery is happening.
 * @param config - resolved configuration supplying the drift tolerance.
 * @param trigger - which layer fired.
 * @returns the text plus the drift it reported.
 */
export function renderWakeText(alarm: ClockAlarm, now: number, config: ResolvedConfig, trigger: string): WakeText {
  const driftMs = now - alarm.at
  const verdict = driftVerdict(driftMs, config.driftToleranceSeconds)
  const lines: string[] = []
  lines.push('⏰ dsh-clock wake — keyword: ' + alarm.keyword)
  lines.push('')
  lines.push('scheduled  ' + isoInZone(alarm.at, alarm.timeZone) + '  [' + alarm.timeZone + ']')
  lines.push('now        ' + isoInZone(now, alarm.timeZone) + '  [' + alarm.timeZone + ']')
  lines.push('drift      ' + durationText(driftMs) + '  ' + verdict.toUpperCase())
  lines.push('now-epoch  ' + String(now))
  lines.push('trigger    ' + (TRIGGER_LABEL[trigger] ?? trigger))
  if (alarm.label !== undefined) lines.push('label      ' + alarm.label)
  lines.push('')
  if (verdict === 'overdue') {
    lines.push(
      'warning    OVERDUE by ' +
        durationText(driftMs) +
        ': the host was not running at the scheduled instant and this is a catch-up delivery. Re-check anything time-sensitive before continuing.',
    )
  } else if (verdict === 'early') {
    lines.push('warning    EARLY by ' + durationText(driftMs) + ': the system clock moved backwards since this alarm was set.')
  }
  lines.push(
    'note       This message was delivered by a timer, not typed by the user. Treat "' +
      alarm.keyword +
      '" as the signal to resume whatever was planned for this instant.',
  )
  if (alarm.note !== undefined) lines.push('detail     ' + alarm.note)
  return { text: lines.join('\n'), driftMs, verdict }
}

/**
 * Deliver one alarm into its target conversation.
 *
 * The alarm is *not* marked fired here — the caller owns that transition, and
 * marks it before calling, so a delivery that hangs cannot be re-entered by a
 * second trigger layer.
 * @param controller - the host session controller.
 * @param alarm - the alarm to deliver.
 * @param now - the instant of delivery.
 * @param config - resolved configuration.
 * @param trigger - which layer fired.
 * @returns the delivered text, or the failure reason.
 */
export async function deliverWake(
  controller: SessionControllerLike,
  alarm: ClockAlarm,
  now: number,
  config: ResolvedConfig,
  trigger: string,
): Promise<{ ok: true; text: string; driftMs: number; verdict: WakeText['verdict'] } | { ok: false; error: string }> {
  const rendered = renderWakeText(alarm, now, config, trigger)
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), WAKE_TIMEOUT_MS)
  try {
    await controller.prompt(
      {
        // Deterministic per alarm: the controller deduplicates a repeated id, so
        // three trigger layers still produce exactly one message.
        requestId: 'clock-' + alarm.id,
        sessionId: alarm.sessionId,
        mode: config.wakeMode,
        content: [{ type: 'text', text: rendered.text }],
        clientTimeZone: alarm.timeZone,
      },
      abort.signal,
    )
    return { ok: true, text: rendered.text, driftMs: rendered.driftMs, verdict: rendered.verdict }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}
