/**
 * The calendar and clock panel.
 *
 * Layout: a live clock, a month grid that marks the days carrying alarms, the
 * alarm list, and one create form that always creates the alarm the selected
 * day and typed time describe. The panel is a body-level floating surface rather
 * than a slot, so a theme plugin reshaping the layout cannot take it away.
 *
 * @module dsh-clock/client/panel
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { ClockAlarm, ClockStateView } from '../shared/types.ts'
import styles from './clock.module.css'
import {
  alarmsByDay,
  call,
  countdownText,
  fetchState,
  formatDate,
  formatHm,
  formatTime,
  instantFromLocal,
  monthGrid,
} from './clock.ts'
import { setOpen, useOpen } from './bus.ts'

/** Browser zone, which is the zone the user is picking times in. */
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Today as YYYY-MM-DD in the browser zone. */
function todayKey(): string {
  return formatDate(Date.now(), browserZone())
}

/** One alarm row. */
function AlarmRow(props: {
  alarm: ClockAlarm
  now: number
  onFire: (id: string) => void
  onCancel: (id: string) => void
  onForget: (id: string) => void
}): React.ReactElement {
  const { alarm, now, onFire, onCancel, onForget } = props
  const late = alarm.status === 'fired' && alarm.firedAt !== undefined && alarm.firedAt - alarm.at > 60000
  const rowClass =
    styles.alarm +
    (alarm.status === 'fired' ? ' ' + styles.alarmFired : '') +
    (alarm.status === 'cancelled' ? ' ' + styles.alarmCancelled : '')
  return (
    React.createElement('div', { className: rowClass },
      React.createElement('div', { className: styles.alarmTime },
        React.createElement('div', null, formatHm(alarm.at, alarm.timeZone)),
        React.createElement('div', { className: styles.alarmMeta }, formatDate(alarm.at, alarm.timeZone).slice(5)),
      ),
      React.createElement('div', { className: styles.alarmBody },
        React.createElement('div', { className: styles.alarmKeyword }, alarm.keyword),
        React.createElement('div', { className: styles.alarmMeta },
          alarm.sessionTitle !== undefined && alarm.sessionTitle !== '' ? alarm.sessionTitle : alarm.sessionId,
        ),
        React.createElement('div', null,
          alarm.status === 'pending'
            ? React.createElement('span', { className: styles.pill }, '等待中 ' + countdownText(alarm.at - now))
            : null,
          alarm.status === 'fired'
            ? React.createElement('span', { className: styles.pill + ' ' + (late ? styles.pillLate : styles.pillOk) },
                (late ? '迟到投递 ' : '已投递 ') + (alarm.via ?? ''))
            : null,
          alarm.status === 'cancelled' ? React.createElement('span', { className: styles.pill }, '已取消') : null,
        ),
        alarm.error !== undefined
          ? React.createElement('div', { className: styles.alarmError }, '投递失败：' + alarm.error)
          : null,
        alarm.note !== undefined ? React.createElement('div', { className: styles.alarmMeta }, alarm.note) : null,
      ),
      React.createElement('div', { className: styles.alarmActions },
        alarm.status === 'pending'
          ? React.createElement('button', {
              className: styles.iconButton,
              title: '立即触发',
              onClick: () => onFire(alarm.id),
            }, '▶')
          : null,
        alarm.status === 'pending'
          ? React.createElement('button', {
              className: styles.iconButton,
              title: '取消',
              onClick: () => onCancel(alarm.id),
            }, '⊘')
          : null,
        React.createElement('button', {
          className: styles.iconButton,
          title: '删除',
          onClick: () => onForget(alarm.id),
        }, '✕'),
      ),
    )
  )
}

/** The whole panel: launcher plus the surface it opens. */
export function ClockApp(): React.ReactElement {
  // Open state lives on the module bus: the trigger is a different React tree.
  const open = useOpen()
  const [state, setState] = useState<ClockStateView | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [cursor, setCursor] = useState(() => {
    const today = new Date()
    return { year: today.getFullYear(), month: today.getMonth() }
  })
  const [selectedDay, setSelectedDay] = useState(() => todayKey())
  const [time, setTime] = useState('09:00')
  const [keyword, setKeyword] = useState('')
  const [note, setNote] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const zone = state === null ? browserZone() : state.timeZone

  const refresh = useCallback(async () => {
    try {
      const next = await fetchState()
      setState(next)
      setError('')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [])

  // The clock ticks every second; the alarm table is refetched much more slowly
  // because it only changes when this panel or the agent changes it.
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(tick)
  }, [])

  useEffect(() => {
    if (!open) return undefined
    void refresh()
    const poll = window.setInterval(() => { void refresh() }, 30000)
    return () => window.clearInterval(poll)
  }, [open, refresh])

  useEffect(() => {
    if (state === null) return
    const pending = state.sessions.filter((row) => row.cold === false)
    if (sessionId === '' && pending.length > 0) setSessionId(pending[0]!.id)
  }, [state, sessionId])

  const alarms = state === null ? [] : state.alarms
  const byDay = useMemo(() => alarmsByDay(alarms, zone), [alarms, zone])
  const grid = useMemo(
    () => monthGrid(cursor.year, cursor.month, todayKey()),
    [cursor.year, cursor.month],
  )
  const nextPending = useMemo(() => {
    const pending = alarms.filter((alarm) => alarm.status === 'pending').sort((a, b) => a.at - b.at)
    return pending.length === 0 ? null : pending[0]!
  }, [alarms])

  const submit = useCallback(async () => {
    if (keyword.trim() === '') {
      setError('请填写关键词：唤醒消息用它开头')
      return
    }
    if (sessionId === '') {
      setError('请选择要唤醒的对话')
      return
    }
    setBusy(true)
    try {
      const at = instantFromLocal(selectedDay, time)
      await call('/alarms', {
        at,
        timeZone: browserZone(),
        keyword: keyword.trim(),
        note: note.trim() === '' ? undefined : note.trim(),
        label: undefined,
        sessionId,
        sessionTitle: state === null ? undefined : (state.sessions.find((row) => row.id === sessionId)?.title ?? undefined),
        origin: 'user',
      })
      setKeyword('')
      setNote('')
      setError('')
      await refresh()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }, [keyword, note, selectedDay, sessionId, state, time, refresh])

  const act = useCallback(
    async (path: string, id: string) => {
      try {
        await call(path, { id })
        await refresh()
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    },
    [refresh],
  )

  // Escape closes the panel. A pointer press outside it is deliberately not
  // bound: the trigger lives in the sidebar, and a dismissal racing the
  // trigger's own click would close the panel the instant it opened.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  const pendingCount = alarms.filter((alarm) => alarm.status === 'pending').length

  // The panel is mounted by the plugin root on the document body, not by the
  // slot, so it survives the sidebar collapsing and is not clipped by its column.
  return React.createElement(React.Fragment, null,
    // The backdrop dims the page and gives the pointer somewhere to land that
    // is not the panel. Centring is the stylesheet's job, so the panel itself
    // carries no inline geometry.
    !open ? null : React.createElement('div', {
      className: styles.backdrop,
      'aria-hidden': 'true',
      onClick: () => setOpen(false),
    }),
    !open ? null : React.createElement('div', {
      className: styles.panel,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '时钟与日历',
    },
      React.createElement('div', { className: styles.header },
        React.createElement('span', { className: styles.title }, pendingCount > 0 ? '时钟与日历 · ' + String(pendingCount) + ' 个待触发' : '时钟与日历'),
        React.createElement('span', { className: styles.headerSpacer }),
        React.createElement('button', { className: styles.iconButton, onClick: () => setOpen(false), title: '关闭' }, '✕'),
      ),
      React.createElement('div', { className: styles.clock },
        React.createElement('div', { className: styles.clockTime }, formatTime(now, zone)),
        React.createElement('div', { className: styles.clockMeta },
          React.createElement('div', { className: styles.clockDate }, formatDate(now, zone)),
          React.createElement('div', { className: styles.clockZone }, zone),
        ),
        React.createElement('div', { className: styles.nextAlarm },
          React.createElement('div', { className: styles.nextLabel }, '下一个唤醒'),
          nextPending === null
            ? React.createElement('div', { className: styles.nextValueIdle }, '无')
            : React.createElement('div', { className: styles.nextValue }, countdownText(nextPending.at - now)),
        ),
      ),
      React.createElement('div', { className: styles.calendar },
        React.createElement('div', { className: styles.calendarBar },
          React.createElement('button', {
            className: styles.iconButton,
            onClick: () => setCursor((c) => (c.month === 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: c.month - 1 })),
          }, '‹'),
          React.createElement('span', { className: styles.monthLabel }, cursor.year + ' 年 ' + String(cursor.month + 1) + ' 月'),
          React.createElement('button', {
            className: styles.iconButton,
            onClick: () => setCursor((c) => (c.month === 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: c.month + 1 })),
          }, '›'),
          React.createElement('span', { className: styles.headerSpacer }),
          React.createElement('button', {
            className: styles.iconButton,
            title: '回到今天',
            onClick: () => {
              const today = new Date()
              setCursor({ year: today.getFullYear(), month: today.getMonth() })
              setSelectedDay(todayKey())
            },
          }, '今天'),
        ),
        React.createElement('div', { className: styles.weekdays },
          ['一', '二', '三', '四', '五', '六', '日'].map((label) =>
            React.createElement('div', { key: label }, label),
          ),
        ),
        React.createElement('div', { className: styles.days },
          grid.map((cell) => {
            const marks = byDay.get(cell.key) ?? []
            const fired = marks.length > 0 && marks.every((alarm) => alarm.status !== 'pending')
            const dayClass =
              styles.day +
              (cell.inMonth ? '' : ' ' + styles.dayOutside) +
              (cell.isToday ? ' ' + styles.dayToday : '') +
              (cell.key === selectedDay ? ' ' + styles.daySelected : '')
            return React.createElement('button', {
              key: cell.key,
              className: dayClass,
              onClick: () => setSelectedDay(cell.key),
              title: marks.length === 0 ? cell.key : cell.key + ' · ' + String(marks.length) + ' 个唤醒',
            },
              React.createElement('span', null, String(cell.day)),
              marks.length > 0
                ? React.createElement('span', { className: styles.dot + (fired ? ' ' + styles.dotFired : '') })
                : null,
            )
          }),
        ),
      ),
      React.createElement('div', { className: styles.listWrap },
        alarms.length === 0
          ? React.createElement('div', { className: styles.empty }, '还没有任何唤醒。选一个日期和时间，填上关键词即可。')
          : alarms.map((alarm) => React.createElement(AlarmRow, {
              key: alarm.id,
              alarm,
              now,
              onFire: (id: string) => { void act('/alarms/fire', id) },
              onCancel: (id: string) => { void act('/alarms/cancel', id) },
              onForget: (id: string) => { void act('/alarms/forget', id) },
            })),
      ),
      React.createElement('div', { className: styles.form },
        React.createElement('div', { className: styles.formRow },
          React.createElement('input', {
            className: styles.input + ' ' + styles.inputTime,
            type: 'time',
            value: time,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setTime(event.target.value),
          }),
          React.createElement('input', {
            className: styles.input,
            placeholder: '关键词，例如：继续迁移',
            value: keyword,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setKeyword(event.target.value),
          }),
        ),
        React.createElement('div', { className: styles.formRow },
          React.createElement('select', {
            className: styles.select,
            value: sessionId,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setSessionId(event.target.value),
          },
            React.createElement('option', { value: '' }, '选择要唤醒的对话…'),
            (state === null ? [] : state.sessions).map((row) =>
              React.createElement('option', { key: row.id, value: row.id },
                (row.cold ? '（未打开）' : '') + (row.title === '' ? row.id : row.title),
              ),
            ),
          ),
        ),
        React.createElement('div', { className: styles.formRow },
          React.createElement('input', {
            className: styles.input,
            placeholder: '备注（可选）：唤醒时要做什么',
            value: note,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setNote(event.target.value),
          }),
        ),
        React.createElement('div', { className: styles.formRow },
          React.createElement('button', {
            className: styles.button,
            disabled: busy,
            onClick: () => { void submit() },
          }, '在 ' + selectedDay + ' ' + time + ' 唤醒'),
          React.createElement('span', { className: styles.headerSpacer }),
          React.createElement('button', {
            className: styles.iconButton,
            title: '刷新',
            onClick: () => { void refresh() },
          }, '⟳'),
        ),
        state !== null && state.scheduler.systemScheduler
          ? React.createElement('div', { className: styles.hint },
              '系统计划任务：' +
                (state.scheduler.systemTaskArmedFor === null
                  ? '未挂载'
                  : formatDate(state.scheduler.systemTaskArmedFor, zone) + ' ' + formatHm(state.scheduler.systemTaskArmedFor, zone)),
            )
          : React.createElement('div', { className: styles.hint }, '系统计划任务不可用，仅使用进程内定时器'),
        error === '' ? null : React.createElement('div', { className: styles.error }, error),
      ),
    ),
  )
}
