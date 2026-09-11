/**
 * The in-process timer: one `setTimeout`, re-armed, never a polling loop.
 *
 * A naive implementation checks the alarm table every few seconds forever. That
 * burns a wakeup per interval for a feature that is idle almost all of the
 * time. This scheduler instead arms exactly one timer for the instant of the
 * *earliest* pending alarm and touches nothing in between, so an idle clock
 * plugin costs no CPU at all.
 *
 * Two edge cases are why the timer is re-derived rather than trusted:
 *
 * - **Node clamps long delays.** A delay above `MAX_TIMER_DELAY_MS` fires
 *   immediately, so anything further out is armed in bounded segments and
 *   re-derived on each wake.
 * - **The wall clock can move.** Re-deriving from `Date.now` on every wake
 *   means a manual clock change, a resume from sleep, or a DST shift cannot
 *   make the alarm fire early or drift.
 *
 * @module dsh-clock/host/scheduler
 */

import type { FireTrigger } from '../shared/types.ts'
import { MAX_TIMER_DELAY_MS } from './time.ts'

/** What the scheduler needs from the service above it. */
export interface SchedulerHost {
  /** Current instant. */
  now(): number
  /** Instant of the soonest pending alarm, or null when none is pending. */
  earliestPending(): number | null
  /** Claim and deliver everything due as of now; returns how many were claimed. */
  fireDue(trigger: FireTrigger): Promise<number>
  /** Mirror the earliest pending instant into the OS scheduler. */
  syncSystemTask(at: number | null): Promise<string | null>
  /** Optional diagnostics sink. */
  log?(message: string): void
}

/** One re-armable timer plus the OS mirror, kept in step with the alarm table. */
export class ClockScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private armed: number | null = null
  private draining = false
  private disposed = false

  /** The service that owns the alarm table and the delivery path. */
  private readonly host: SchedulerHost

  /** @param host - the service that owns the alarm table and the delivery path. */
  constructor(host: SchedulerHost) {
    this.host = host
  }

  /** The instant the in-process timer is currently armed for. */
  get armedFor(): number | null {
    return this.armed
  }

  /** Arm the first timer. Call once the alarm table is readable. */
  start(): void {
    void this.resync()
  }

  /** Re-derive both layers from the current alarm table. */
  async resync(): Promise<void> {
    if (this.disposed) return
    this.clearTimer()
    const earliest = this.host.earliestPending()
    if (earliest === null) {
      await this.host.syncSystemTask(null)
      return
    }
    const error = await this.host.syncSystemTask(earliest)
    if (error !== null) this.host.log?.('system scheduler unavailable: ' + error)
    if (this.disposed) return
    this.arm(earliest)
  }

  /** Cancel any armed timer. */
  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.armed = null
  }

  /** Arm one bounded segment aimed at `at`. */
  private arm(at: number): void {
    const delay = Math.max(0, at - this.host.now())
    const bounded = Math.min(delay, MAX_TIMER_DELAY_MS)
    this.armed = at
    this.timer = setTimeout(() => {
      void this.onTimer()
    }, bounded)
    // An alarm must not be the reason the host stays alive.
    this.timer.unref?.()
  }

  /** Wake, fire what is due, and re-derive. */
  private async onTimer(): Promise<void> {
    this.timer = null
    this.armed = null
    if (this.disposed) return
    // A concurrent HTTP tick may already be draining; let it own this round and
    // simply re-derive afterwards rather than delivering the same alarm twice.
    if (!this.draining) {
      this.draining = true
      try {
        await this.host.fireDue('timer')
      } catch (error) {
        this.host.log?.('timer fire failed: ' + (error instanceof Error ? error.message : String(error)))
      } finally {
        this.draining = false
      }
    }
    await this.resync()
  }

  /** Stop firing and release both layers. */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }
}
