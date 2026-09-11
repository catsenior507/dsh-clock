/**
 * Unit tests for the clock plugin.
 *
 * The tests target the parts where being wrong is expensive: the idempotency
 * that keeps three trigger layers from delivering one wake three times, the
 * drift the wake text reports, and the durability of the alarm table.
 *
 * Every service is built with the OS scheduler mirror switched off, so running
 * the suite never registers a Windows scheduled task.
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { AlarmStore, createAlarm } from '../src/host/store.ts'
import { ClockService, firstText, isSubagentSession, titleFromEvents } from '../src/host/service.ts'
import { renderWakeText, type SessionControllerLike } from '../src/host/fire.ts'
import { corsHeaders, resolveRequestedAt } from '../src/host/api.ts'
import { registerSkill, SKILL_BODY } from '../src/host/skill.ts'
import { driftVerdict, durationText, isoInZone, dateKeyInZone, isValidTimeZone } from '../src/host/time.ts'
import { resolveConfig } from '../src/host/store.ts'
import { monthGrid, instantFromLocal, countdownText, alarmsByDay } from '../src/client/clock.ts'
import type { ClockAlarm, ClockConfig } from '../src/shared/types.ts'

const roots: string[] = []

/** A throwaway data directory, removed when the suite ends. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-clock-test-'))
  roots.push(dir)
  return dir
}

after(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // A leftover temp directory is not a test failure.
    }
  }
})

/** Resolved config with the OS mirror off and a private data directory. */
function config(overrides: Partial<ClockConfig> = {}): ClockConfig {
  return { dataDir: tempDir(), useSystemScheduler: false, ...overrides }
}

/** A fake session controller that records every prompt it is handed. */
function recordingController(): { controller: SessionControllerLike; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = []
  return {
    calls,
    controller: {
      prompt: async (request: Record<string, unknown>) => {
        calls.push(request)
        return { accepted: true }
      },
    },
  }
}

/** A context carrying just the services the plugin reads. */
function fakeContext(controller?: SessionControllerLike): Record<string, unknown> {
  const services = new Map<string, unknown>()
  if (controller !== undefined) services.set('sessionController', controller)
  return {
    sessions: { list: () => [], get: () => undefined },
    get: (name: string) => services.get(name),
    logger: { warn: () => {}, info: () => {} },
  }
}

/** Poll until a condition holds, so async start paths are tested without sleeps. */
async function until(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

/** Build a service wired to a controller. */
function makeService(
  controller: SessionControllerLike,
  overrides: Partial<ClockConfig> = {},
): ClockService {
  return new ClockService({
    ctx: fakeContext(controller) as never,
    config: config(overrides),
    controller,
  })
}

describe('durationText', () => {
  it('renders a signed compact duration', () => {
    assert.equal(durationText(4000), '+4s')
    assert.equal(durationText(-90_000), '-1m30s')
    assert.equal(durationText(2 * 3600_000 + 13 * 60_000), '+2h13m')
    assert.equal(durationText(0), '+0s')
  })
})

describe('driftVerdict', () => {
  it('treats the tolerance window as on time and everything past it as overdue', () => {
    assert.equal(driftVerdict(0, 60), 'on-time')
    assert.equal(driftVerdict(59_000, 60), 'on-time')
    assert.equal(driftVerdict(61_000, 60), 'overdue')
    assert.equal(driftVerdict(-61_000, 60), 'early')
  })
})

describe('zone formatting', () => {
  it('formats an instant in the requested zone with its offset', () => {
    const instant = Date.UTC(2026, 8, 11, 1, 30, 0)
    assert.equal(isoInZone(instant, 'Asia/Shanghai'), '2026-09-11T09:30:00+08:00')
    assert.equal(isoInZone(instant, 'UTC'), '2026-09-11T01:30:00+00:00')
    assert.equal(dateKeyInZone(instant, 'Asia/Shanghai'), '2026-09-11')
  })

  it('rejects a zone the platform does not know', () => {
    assert.equal(isValidTimeZone('Asia/Shanghai'), true)
    assert.equal(isValidTimeZone('Mars/Olympus'), false)
  })
})

describe('createAlarm', () => {
  it('normalizes a complete request', () => {
    const alarm = createAlarm({ at: 1000, timeZone: 'UTC', keyword: '  go  ', sessionId: ' s1 ', origin: 'user' }, 0)
    assert.equal(alarm.keyword, 'go')
    assert.equal(alarm.sessionId, 's1')
    assert.equal(alarm.status, 'pending')
    assert.match(alarm.id, /^a-/)
  })

  it('refuses a request with no keyword, no target, or a non-finite instant', () => {
    const base = { at: 1, timeZone: 'UTC', keyword: 'k', sessionId: 's', origin: 'user' as const }
    assert.throws(() => createAlarm({ ...base, keyword: '   ' }, 0), /keyword is required/)
    assert.throws(() => createAlarm({ ...base, sessionId: '' }, 0), /sessionId is required/)
    assert.throws(() => createAlarm({ ...base, at: Number.NaN }, 0), /finite/)
  })
})

describe('AlarmStore', () => {
  it('round-trips through its file and survives a reload', () => {
    const dir = tempDir()
    const store = new AlarmStore(dir)
    const alarm = createAlarm({ at: 5000, timeZone: 'UTC', keyword: 'k', sessionId: 's', origin: 'agent' }, 0)
    store.add(alarm)
    const reloaded = new AlarmStore(dir)
    assert.equal(reloaded.all().length, 1)
    assert.equal(reloaded.get(alarm.id)?.keyword, 'k')
  })

  it('patches, cancels, removes, and prunes', () => {
    const store = new AlarmStore(tempDir())
    const alarm = createAlarm({ at: 1000, timeZone: 'UTC', keyword: 'k', sessionId: 's', origin: 'user' }, 0)
    store.add(alarm)
    store.patch(alarm.id, { status: 'fired', firedAt: 1000 })
    assert.equal(store.pending().length, 0)
    assert.equal(store.all().length, 1)
    assert.equal(store.remove(alarm.id), true)
    assert.equal(store.remove(alarm.id), false)
  })

  it('keeps pending alarms when pruning settled ones', () => {
    const store = new AlarmStore(tempDir())
    const old = createAlarm({ at: 1000, timeZone: 'UTC', keyword: 'old', sessionId: 's', origin: 'user' }, 0)
    const future = createAlarm({ at: 9e12, timeZone: 'UTC', keyword: 'new', sessionId: 's', origin: 'user' }, 0)
    store.add(old)
    store.add(future)
    store.patch(old.id, { status: 'fired', firedAt: 1000 })
    const dropped = store.prune(Date.now(), 7)
    assert.equal(dropped, 1)
    assert.equal(store.all().length, 1)
    assert.equal(store.all()[0]!.keyword, 'new')
  })

  it('starts empty rather than throwing on a corrupt file', () => {
    const dir = tempDir()
    const store = new AlarmStore(dir)
    store.add(createAlarm({ at: 1, timeZone: 'UTC', keyword: 'k', sessionId: 's', origin: 'user' }, 0))
    writeFileSync(join(dir, 'alarms.json'), '{not json', 'utf8')
    const reopened = new AlarmStore(dir)
    assert.deepEqual(reopened.all(), [])
  })
})

describe('renderWakeText', () => {
  const resolved = resolveConfig({ dataDir: 'x', useSystemScheduler: false, driftToleranceSeconds: 60 })
  const alarm: ClockAlarm = {
    id: 'a-1',
    at: Date.UTC(2026, 8, 11, 1, 30, 0),
    timeZone: 'Asia/Shanghai',
    keyword: '继续迁移',
    note: '检查构建是否结束',
    sessionId: 'session-x',
    origin: 'user',
    createdAt: 0,
    status: 'pending',
  }

  it('reports an on-time delivery without a warning', () => {
    const rendered = renderWakeText(alarm, alarm.at + 4000, resolved, 'timer')
    assert.equal(rendered.verdict, 'on-time')
    assert.match(rendered.text, /\+4s {2}ON-TIME/)
    assert.match(rendered.text, /scheduled {2}2026-09-11T09:30:00\+08:00/)
    assert.match(rendered.text, /keyword: 继续迁移/)
    assert.match(rendered.text, /detail {5}检查构建是否结束/)
    assert.doesNotMatch(rendered.text, /OVERDUE/)
  })

  it('flags an overdue delivery and says how late it is', () => {
    const rendered = renderWakeText(alarm, alarm.at + 2 * 3600_000 + 13 * 60_000, resolved, 'overdue-replay')
    assert.equal(rendered.verdict, 'overdue')
    assert.match(rendered.text, /\+2h13m {2}OVERDUE/)
    assert.match(rendered.text, /warning {4}OVERDUE by \+2h13m/)
    assert.match(rendered.text, /catch-up replay at host start/)
  })
})

describe('ClockService delivery', () => {
  it('claims a due alarm exactly once even when three layers fire', async () => {
    const recorder = recordingController()
    const service = makeService(recorder.controller)
    const past = createAlarm(
      { at: Date.now() - 5000, timeZone: 'UTC', keyword: 'wake', sessionId: 'session-a', origin: 'user' },
      Date.now(),
    )
    service.store.add(past)

    const first = await service.fireDue('timer')
    const second = await service.fireDue('system-scheduler')
    const third = await service.fireDue('overdue-replay')

    assert.equal(first, 1)
    assert.equal(second, 0)
    assert.equal(third, 0)
    assert.equal(recorder.calls.length, 1)
  })

  it('hands the controller a deterministic request id and the wake text', async () => {
    const recorder = recordingController()
    const service = makeService(recorder.controller)
    const alarm = createAlarm(
      { at: Date.now() - 1000, timeZone: 'Asia/Shanghai', keyword: 'go', sessionId: 'session-b', origin: 'agent' },
      Date.now(),
    )
    service.store.add(alarm)
    await service.fireDue('timer')
    const call = recorder.calls[0]!
    assert.equal(call.requestId, 'clock-' + alarm.id)
    assert.equal(call.sessionId, 'session-b')
    assert.equal(call.mode, 'queue')
    assert.equal(call.clientTimeZone, 'Asia/Shanghai')
    const content = call.content as { type: string; text: string }[]
    assert.equal(content[0]!.type, 'text')
    assert.match(content[0]!.text, /dsh-clock wake/)
  })

  it('leaves a future alarm pending', async () => {
    const recorder = recordingController()
    const service = makeService(recorder.controller)
    service.store.add(
      createAlarm({ at: Date.now() + 3600_000, timeZone: 'UTC', keyword: 'later', sessionId: 's', origin: 'user' }, Date.now()),
    )
    assert.equal(await service.fireDue('timer'), 0)
    assert.equal(service.store.pending().length, 1)
    assert.equal(service.earliestPending() !== null, true)
  })

  it('records a delivery failure on the alarm instead of losing it', async () => {
    const failing: SessionControllerLike = {
      prompt: async () => {
        throw new Error('resume refused')
      },
    }
    const service = makeService(failing)
    const alarm = createAlarm(
      { at: Date.now() - 1000, timeZone: 'UTC', keyword: 'k', sessionId: 'session-c', origin: 'user' },
      Date.now(),
    )
    service.store.add(alarm)
    await service.fireDue('timer')
    assert.equal(service.store.get(alarm.id)?.status, 'fired')
    assert.match(service.store.get(alarm.id)?.error ?? '', /resume refused/)
  })

  it('delivers an alarm that came due while the host was down, at start', async () => {
    const recorder = recordingController()
    const service = makeService(recorder.controller)
    service.store.add(
      createAlarm(
        { at: Date.now() - 4 * 3600_000, timeZone: 'UTC', keyword: 'missed', sessionId: 'session-d', origin: 'user' },
        Date.now(),
      ),
    )
    service.start()
    assert.equal(await until(() => recorder.calls.length > 0), true)
    const content = recorder.calls[0]!.content as { text: string }[]
    assert.match(content[0]!.text, /OVERDUE/)
  })
})

describe('resolveRequestedAt', () => {
  it('resolves a relative delay and an absolute instant', () => {
    assert.equal(resolveRequestedAt({ afterSeconds: 90 }, 1000), 91_000)
    assert.equal(resolveRequestedAt({ at: '2026-09-11T09:30:00+08:00' }, 0), Date.UTC(2026, 8, 11, 1, 30, 0))
    assert.equal(resolveRequestedAt({ at: 1234 }, 0), 1234)
  })

  it('refuses a request that names no instant', () => {
    assert.throws(() => resolveRequestedAt({}, 0), /at \(epoch ms or ISO string\) or afterSeconds is required/)
    assert.throws(() => resolveRequestedAt({ at: 'not a date' }, 0), /not a parseable/)
  })
})

describe('tolerant extraction', () => {
  it('reads a real user message body and an assistant message body', () => {
    // The persisted shapes, taken from the harness surface contract rather than
    // guessed: a user/message event carries the message itself, while an
    // assistant/message carries it under `message`.
    assert.equal(firstText({ content: [{ type: 'text', text: 'hello there' }] }), 'hello there')
    assert.equal(firstText({ message: { content: [{ type: 'text', text: 'nested' }] } }), 'nested')
    assert.equal(firstText('plain'), 'plain')
  })

  it('does not walk unknown keys, so an unrelated string is never mistaken for a title', () => {
    assert.equal(firstText({ metadata: { note: 'not a title' } }), '')
    assert.equal(firstText({ content: [{ type: 'image' }] }), '')
  })

  it('prefers the newest title event and falls back to the first user message', () => {
    const events = [
      { type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ text: 'first question' }] } },
      { type: 'session/title', time: 2, data: { title: 'Real Title' } },
    ]
    assert.equal(titleFromEvents(events, 'fallback'), 'Real Title')
    assert.equal(titleFromEvents([events[0]!], 'fallback'), 'first question')
    assert.equal(titleFromEvents([], 'fallback'), 'fallback')
  })
})

describe('bundled skill', () => {
  it('registers one bundled, model-invocable skill and returns a disposer', () => {
    const seen: Record<string, unknown>[] = []
    let disposed = false
    const dispose = registerSkill({
      register(skill: Record<string, unknown>) {
        seen.push(skill)
        return () => {
          disposed = true
        }
      },
    })
    assert.equal(seen.length, 1)
    const skill = seen[0]!
    assert.equal(skill.name, 'clock')
    assert.equal(skill.source, 'bundled')
    assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
    assert.equal(typeof dispose, 'function')
    dispose()
    assert.equal(disposed, true)
  })

  it('teaches the parts the tool description cannot carry', () => {
    // A conversation that has never seen this plugin must still learn that a
    // target may be closed and that a late wake says so.
    assert.match(SKILL_BODY, /sessionId/)
    assert.match(SKILL_BODY, /closed/)
    assert.match(SKILL_BODY, /drift/)
    assert.match(SKILL_BODY, /host must be running/i)
  })
})

describe('cross-origin access', () => {
  it('echoes a loopback origin so the panel can call the private carrier', () => {
    // The panel is served from the harness web server and the carrier listens on
    // another port, so every call it makes is cross-origin.
    const headers = corsHeaders('http://127.0.0.1:3080')
    assert.equal(headers['access-control-allow-origin'], 'http://127.0.0.1:3080')
    assert.match(headers['access-control-allow-methods'] ?? '', /POST/)
    assert.equal(corsHeaders('http://localhost:3080')['access-control-allow-origin'], 'http://localhost:3080')
  })

  it('refuses any other origin, because an alarm ends in an injected message', () => {
    assert.deepEqual(corsHeaders('https://evil.example.com'), {})
    assert.deepEqual(corsHeaders('http://127.0.0.1.evil.com'), {})
    assert.deepEqual(corsHeaders(undefined), {})
    assert.deepEqual(corsHeaders('not a url'), {})
  })
})

describe('wake targets', () => {
  it('marks only subagent-owned conversations', () => {
    assert.equal(isSubagentSession({ origin: 'subagent' }), true)
    assert.equal(isSubagentSession({ origin: undefined }), false)
    assert.equal(isSubagentSession({}), false)
    assert.equal(isSubagentSession(undefined), false)
  })

  it('never offers a subagent conversation as a wake target', async () => {
    // The session controller refuses an identity owned by subagent routing, so
    // offering one would be offering a target that is guaranteed to fail.
    const ctx = {
      sessions: {
        list: () => [
          { id: 'session-root', header: { id: 'session-root', createdAt: 1 }, snapshotEvents: () => [] },
          { id: 'child-1', header: { id: 'child-1', createdAt: 2, origin: 'subagent' }, snapshotEvents: () => [] },
        ],
        get: () => undefined,
      },
      get: () => undefined,
      logger: { warn: () => {}, info: () => {} },
    }
    const service = new ClockService({ ctx: ctx as never, config: config() })
    const rows = await service.listSessions()
    assert.deepEqual(
      rows.map((row) => row.id),
      ['session-root'],
    )
  })
})

describe('client calendar helpers', () => {
  it('builds a Monday-first 42-cell grid', () => {
    const grid = monthGrid(2026, 8, '2026-09-11')
    assert.equal(grid.length, 42)
    assert.equal(grid.find((cell) => cell.key === '2026-09-01')?.inMonth, true)
    assert.equal(grid.find((cell) => cell.isToday)?.key, '2026-09-11')
  })

  it('combines a day key and a time into one instant', () => {
    const date = new Date(instantFromLocal('2026-09-11', '09:30'))
    assert.equal(date.getFullYear(), 2026)
    assert.equal(date.getMonth(), 8)
    assert.equal(date.getDate(), 11)
    assert.equal(date.getHours(), 9)
    assert.equal(date.getMinutes(), 30)
  })

  it('buckets alarms by their own zone day', () => {
    const alarms = [
      { at: Date.UTC(2026, 8, 11, 1, 30), timeZone: 'Asia/Shanghai' },
      { at: Date.UTC(2026, 8, 11, 1, 30), timeZone: 'UTC' },
    ] as ClockAlarm[]
    assert.equal(alarmsByDay(alarms, 'UTC').get('2026-09-11')?.length, 2)
  })

  it('renders a countdown', () => {
    assert.equal(countdownText(90_000), '1分30秒')
    assert.equal(countdownText(-1000), '-1秒')
  })
})
