/** Tests for the schedule-backed alarm adapter. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toAlarm, toClockAlarm, toCreateRequest } from '../src/host/officialStore.ts'

const T0 = Date.parse('2026-10-18T10:00:00.000Z')

test('a scheduled record maps onto the panel vocabulary', () => {
  const alarm = toAlarm({
    id: 'a-1',
    title: 'stand up',
    prompt: 'the meeting is starting',
    scheduledAt: '2026-10-18T10:05:00.000Z',
    state: 'scheduled',
    timeZone: 'Asia/Shanghai',
  }, T0)
  assert.equal(alarm.id, 'a-1')
  assert.equal(alarm.keyword, 'stand up', 'title is the keyword')
  assert.equal(alarm.note, 'the meeting is starting', 'prompt is the note')
  assert.equal(alarm.status, 'pending')
  assert.equal(alarm.late, false)
  assert.equal(alarm.at, Date.parse('2026-10-18T10:05:00.000Z'))
})

test('an overdue record is fired and late', () => {
  const alarm = toAlarm({ id: 'a-2', title: 'x', prompt: 'y', scheduledAt: '2026-10-17T10:00:00.000Z', state: 'overdue' }, T0)
  assert.equal(alarm.status, 'fired')
  assert.equal(alarm.late, true)
})

test('an unparseable instant is shown as zero, never dropped', () => {
  const alarm = toAlarm({ id: 'a-3', title: 'x', prompt: 'y', scheduledAt: 'not a date', state: 'scheduled' }, T0)
  assert.equal(alarm.at, 0, 'a visible odd row beats an invisible one')
})

test('a missing zone falls back rather than throwing', () => {
  assert.equal(toAlarm({ id: 'a', title: 't', prompt: 'p' }, T0).timeZone, 'Asia/Shanghai')
})

test('create request carries an absolute instant and the two texts', () => {
  const req = toCreateRequest({ at: T0, timeZone: 'Asia/Shanghai', keyword: '  hi  ', note: 'body' })
  assert.equal(req.title, 'hi', 'title is trimmed')
  assert.equal(req.prompt, 'body')
  assert.equal(req.at, new Date(T0).toISOString())
})

test('an empty keyword still says something, and an empty note falls back to it', () => {
  const req = toCreateRequest({ at: T0, timeZone: 'Asia/Shanghai', keyword: '   ', note: '  ' })
  assert.equal(req.title, 'reminder')
  assert.equal(req.prompt, 'reminder')
})

test('a title longer than the service allows is cut, not rejected', () => {
  const req = toCreateRequest({ at: T0, timeZone: 'Asia/Shanghai', keyword: 'x'.repeat(300), note: 'n' })
  assert.equal(String(req.title).length, 120)
})

test('a catalog entry fills the fields the panel requires', () => {
  const alarm = toClockAlarm({
    id: 'a-9',
    title: 'wake',
    prompt: 'do the thing',
    scheduledAt: '2026-10-18T10:00:00.000Z',
    state: 'scheduled',
    sessionId: 'session-x',
  }, T0, 'Asia/Shanghai')
  assert.equal(alarm.id, 'a-9')
  assert.equal(alarm.sessionId, 'session-x', 'the session binding survives the mapping')
  assert.equal(alarm.keyword, 'wake')
  assert.equal(alarm.note, 'do the thing')
  assert.equal(alarm.status, 'pending')
  assert.equal(alarm.origin, 'user', 'every alarm this plugin shows was created by the user')
  assert.equal(alarm.createdAt, alarm.at, 'the scheduled instant is the only time the record carries')
})

test('an overdue entry is fired, a cancelled one stays cancelled', () => {
  const overdue = toClockAlarm({ id: 'a', title: 't', prompt: 'p', scheduledAt: '2026-10-17T00:00:00.000Z', state: 'overdue', sessionId: 's' }, T0, 'UTC')
  assert.equal(overdue.status, 'fired')
  const cancelled = toClockAlarm({ id: 'b', title: 't', prompt: 'p', state: 'cancelled', sessionId: 's' }, T0, 'UTC')
  assert.equal(cancelled.status, 'cancelled')
})

test('an overdue entry whose instant is still ahead is not claimed as fired', () => {
  const future = toClockAlarm({ id: 'c', title: 't', prompt: 'p', scheduledAt: '2026-10-18T11:00:00.000Z', state: 'overdue', sessionId: 's' }, T0, 'UTC')
  assert.equal(future.status, 'pending', 'overdue is a state, not a licence to claim delivery')
})

test('a missing zone uses the configured default', () => {
  assert.equal(toClockAlarm({ id: 'd', title: 't', prompt: 'p', sessionId: 's' }, T0, 'Europe/Berlin').timeZone, 'Europe/Berlin')
})
