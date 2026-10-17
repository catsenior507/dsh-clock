/** Tests for the official-schedule mapping. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toAlarm, toCreateRequest } from '../src/host/official.ts'

const NOW = 1_700_000_000_000

test('a scheduled record becomes a pending alarm', () => {
  const a = toAlarm({ id: 's1', kind: 'at', title: 'standup', prompt: 'remind me', scheduledAt: new Date(NOW + 60_000).toISOString(), state: 'scheduled' }, NOW)
  assert.equal(a.status, 'pending')
  assert.equal(a.keyword, 'standup')
  assert.equal(a.note, 'remind me')
  assert.equal(a.at, NOW + 60_000)
  assert.equal(a.late, false)
})

test('an overdue record is reported late and fired', () => {
  const a = toAlarm({ id: 's2', kind: 'at', title: 'x', prompt: '', scheduledAt: new Date(NOW - 1000).toISOString(), state: 'overdue' }, NOW)
  assert.equal(a.late, true)
  assert.equal(a.status, 'fired')
})

test('an unparseable instant becomes zero rather than dropping the row', () => {
  const a = toAlarm({ id: 's3', kind: 'at', title: 'x', prompt: '', scheduledAt: 'not a date' }, NOW)
  assert.equal(a.at, 0)
  assert.equal(a.status, 'pending', 'an unknown instant is not claimed to have fired')
})

test('a create request keeps the panel vocabulary and defaults an empty keyword', () => {
  const r1 = toCreateRequest({ at: NOW, keyword: 'hello', note: 'body', timeZone: 'Asia/Shanghai' })
  assert.equal(r1.title, 'hello')
  assert.equal(r1.prompt, 'body')
  assert.equal(r1.at, new Date(NOW).toISOString())
  const r2 = toCreateRequest({ at: NOW, keyword: '', note: '', timeZone: 'Asia/Shanghai' })
  assert.equal(r2.title, '唤醒')
})
