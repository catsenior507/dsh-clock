/** Tests for the schedule-backed service. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClockService, firstText, forkPrompts, titleFromEvents } from '../src/host/service.ts'

const T0 = Date.parse('2026-10-18T10:00:00.000Z')

/** A schedule service that answers from memory. */
function fakeSchedule(records: unknown[]) {
  const calls = { created: [] as unknown[], updated: [] as unknown[], deleted: [] as unknown[] }
  return {
    calls,
    list: async () => records,
    create: async (sessionId: string, request: Record<string, unknown>) => {
      calls.created.push({ sessionId, request })
      return { id: 'new-1', title: request.title, prompt: request.prompt, scheduledAt: request.at, state: 'scheduled', sessionId }
    },
    update: async (request: Record<string, unknown>) => { calls.updated.push(request); return {} },
    delete: async (request: Record<string, unknown>) => { calls.deleted.push(request); return {} },
  }
}

function serviceWith(schedule: unknown, sessions: unknown[] = []) {
  return new ClockService({
    ctx: {
      sessions: { list: () => sessions, get: () => undefined },
      get: (name: string) => (name === 'schedule' ? schedule : undefined),
      logger: { warn: () => {} },
    },
    config: { dataDir: 'C:\\tmp\\clock-test', defaultTimeZone: 'UTC' },
  })
}

test('firstText digs through whatever shape a message part has', () => {
  assert.equal(firstText('plain'), 'plain')
  assert.equal(firstText([{ content: [{ text: 'deep' }] }]), 'deep')
  assert.equal(firstText({ data: { message: { parts: [{ text: 'x' }] } } }), 'x')
  assert.equal(firstText(null), '')
})

test('title prefers session/title, then the first user message, then the id', () => {
  assert.equal(titleFromEvents([{ type: 'session/title', data: { title: 'Real' } }], 'id'), 'Real')
  assert.equal(
    titleFromEvents([{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ text: 'hello there' }] } }], 'id'),
    'hello there',
  )
  assert.equal(titleFromEvents([], 'fallback'), 'fallback')
})

test('forkPrompts asks only about branches that would never be woken', () => {
  const rows = [
    { id: 'p', title: 'parent', createdAt: 0, updatedAt: 0, cold: false },
    { id: 'c', title: 'child', createdAt: 0, updatedAt: 0, cold: false, parentSession: 'p' },
  ]
  const alarm = { id: 'a', at: T0, timeZone: 'UTC', keyword: 'k', sessionId: 'p', origin: 'user' as const, createdAt: 0, status: 'pending' as const }
  const prompts = forkPrompts(rows, [alarm])
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0]?.sessionId, 'c')
  assert.equal(prompts[0]?.alarms, 1)
  assert.equal(forkPrompts(rows, []).length, 0, 'nothing pending, nothing to ask')
  assert.equal(forkPrompts(rows, [alarm], new Set(['c'])).length, 0, 'a dismissed branch is not asked twice')
})

test('state reads alarms from the schedule service', async () => {
  const schedule = fakeSchedule([
    { id: 'a1', title: 'wake', prompt: 'note', scheduledAt: '2026-10-18T10:05:00.000Z', state: 'scheduled', sessionId: 's1' },
  ])
  const state = await serviceWith(schedule).state()
  assert.equal(state.alarms.length, 1)
  assert.equal(state.alarms[0]?.keyword, 'wake')
  assert.equal(state.alarms[0]?.sessionId, 's1')
  assert.equal(state.scheduler.timerArmedFor, Date.parse('2026-10-18T10:05:00.000Z'), 'next due is reported from the records')
  assert.equal(state.scheduler.systemScheduler, false, 'there is no OS mirror any more, and the field says so')
})

test('a missing schedule service yields no alarms rather than throwing', async () => {
  const state = await serviceWith(undefined).state()
  assert.deepEqual(state.alarms, [])
  assert.equal(state.scheduler.timerArmedFor, null)
})

test('create goes through the official service with title, prompt and an ISO instant', async () => {
  const schedule = fakeSchedule([])
  const alarm = await serviceWith(schedule).create({ at: T0, timeZone: 'UTC', keyword: 'k', note: 'n', sessionId: 's1' })
  assert.equal((schedule.calls.created[0] as { request: { title: string } }).request.title, 'k')
  assert.equal((schedule.calls.created[0] as { request: { prompt: string } }).request.prompt, 'n')
  assert.equal((schedule.calls.created[0] as { request: { at: string } }).request.at, new Date(T0).toISOString())
  assert.equal(alarm?.id, 'new-1')
})

test('forget deletes through the official service', async () => {
  const schedule = fakeSchedule([])
  assert.equal(await serviceWith(schedule).forget('a1'), true)
  assert.deepEqual(schedule.calls.deleted[0], { id: 'a1' })
})
