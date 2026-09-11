/**
 * The OS-level half of the scheduling: one Windows scheduled task that mirrors
 * the earliest pending alarm.
 *
 * Why this exists at all, stated honestly, because it is the part of the design
 * most likely to be over-claimed:
 *
 * - The **in-process timer** is the primary path and covers the ordinary case
 *   (host running, machine awake) with one `setTimeout` and no polling.
 * - A **catch-up replay at host start** covers the host not running.
 * - What the OS task adds beyond those two is real but narrow: the platform
 *   knows about machine sleep and missed schedules, so `StartWhenAvailable`
 *   lets Windows run the task as soon as the machine is actually available
 *   again, and it is the only layer that can be told to wake the machine. It is
 *   also a redundant trigger if the host process itself is suspended.
 *
 * The task therefore does not *own* the alarm; it only pings the plugin's own
 * endpoint, which fires due alarms idempotently. A missing, failed, or stale
 * task degrades to the other two layers rather than losing the wake.
 *
 * Registration goes through PowerShell's ScheduledTasks module rather than
 * `schtasks.exe` because only the module exposes `StartWhenAvailable`. The
 * script is passed with `-EncodedCommand` (base64 UTF-16LE) so no quoting or
 * escaping layer sits between this file and the shell.
 *
 * @module dsh-clock/host/system-scheduler
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Name of the single task this plugin owns; it is replaced, never accumulated. */
export const SYSTEM_TASK_NAME = 'dsh-clock-wake'

/** How long the registration PowerShell may take. */
const REGISTER_TIMEOUT_MS = 45000

/** Whether this platform has the scheduler this module drives. */
export function systemSchedulerSupported(): boolean {
  return process.platform === 'win32'
}

/** Encode a script for `powershell -EncodedCommand`. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Quote a value as a single-quoted PowerShell literal. */
function psQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

/** `2026-09-11T09:30:00` in the machine's own zone — what `-At` expects. */
export function localIso(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    String(date.getFullYear()) +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    'T' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes()) +
    ':' +
    pad(date.getSeconds())
  )
}

/** Locate curl.exe, which Windows 10 1803 and later ship. */
function curlPath(): string | null {
  const candidates = [
    process.env.SystemRoot === undefined ? '' : process.env.SystemRoot + '\\System32\\curl.exe',
    'C:\\Windows\\System32\\curl.exe',
  ].filter((candidate) => candidate !== '')
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** The ping the task performs when it fires. */
export function tickUrl(port: number): string {
  return 'http://127.0.0.1:' + String(port) + '/api/clock/tick'
}

/** Build the action the task runs: a curl one-liner, or encoded PowerShell as a fallback. */
export function buildAction(port: number): { execute: string; argument: string } {
  const curl = curlPath()
  if (curl !== null) {
    return { execute: curl, argument: '-s -S -o NUL -X POST --max-time 30 ' + tickUrl(port) }
  }
  const script =
    "try { Invoke-RestMethod -Method POST -Uri " + psQuote(tickUrl(port)) + ' -TimeoutSec 30 | Out-Null } catch { }'
  return { execute: 'powershell.exe', argument: '-NoProfile -NonInteractive -EncodedCommand ' + encodePowerShell(script) }
}

/** The registration script for one alarm instant. */
export function buildRegisterScript(at: number, port: number, wakeComputer: boolean): string {
  const action = buildAction(port)
  return [
    '$ErrorActionPreference = ' + psQuote('Stop'),
    '$action = New-ScheduledTaskAction -Execute ' + psQuote(action.execute) + ' -Argument ' + psQuote(action.argument),
    '$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]' + psQuote(localIso(at)) + ')',
    '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries' +
      (wakeComputer ? ' -WakeToRun' : '') +
      ' -ExecutionTimeLimit (New-TimeSpan -Minutes 5)',
    '$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited',
    'Register-ScheduledTask -TaskName ' + psQuote(SYSTEM_TASK_NAME) + ' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null',
    "Write-Output 'dsh-clock: task registered'",
  ].join('; ')
}

/** The removal script. */
export function buildClearScript(): string {
  return [
    '$ErrorActionPreference = ' + psQuote('SilentlyContinue'),
    '$existing = Get-ScheduledTask -TaskName ' + psQuote(SYSTEM_TASK_NAME) + ' -ErrorAction SilentlyContinue',
    'if ($existing) { Unregister-ScheduledTask -TaskName ' + psQuote(SYSTEM_TASK_NAME) + ' -Confirm:$false }',
    "Write-Output 'dsh-clock: task cleared'",
  ].join('; ')
}

/** Run one PowerShell script, returning whether it succeeded and why not. */
export function runPowerShell(script: string): { ok: boolean; detail: string } {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)],
    { encoding: 'utf8', timeout: REGISTER_TIMEOUT_MS, windowsHide: true },
  )
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, detail: String(result.error.message ?? result.error) }
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim()
    const stdout = (result.stdout ?? '').trim()
    return { ok: false, detail: (stderr || stdout || 'exit ' + String(result.status)).slice(0, 400) }
  }
  return { ok: true, detail: (result.stdout ?? '').trim() }
}

/**
 * Point the OS task at `at`, or remove it when there is nothing to arm.
 * @param at - the earliest pending instant, or null to clear.
 * @param port - the plugin's HTTP port.
 * @param wakeComputer - whether the task may wake the machine from sleep.
 * @returns null on success, otherwise the failure text.
 */
export function syncSystemTask(at: number | null, port: number, wakeComputer: boolean): string | null {
  if (!systemSchedulerSupported()) return null
  const script = at === null ? buildClearScript() : buildRegisterScript(at, port, wakeComputer)
  const outcome = runPowerShell(script)
  return outcome.ok ? null : outcome.detail
}
