/**
 * The model-facing half: one `clock` tool.
 *
 * The agent needs this for the part of scheduling a human cannot do mid-task:
 * knowing that a build will take forty minutes, that a deploy window opens at
 * 02:00, or that it should come back to a half-finished migration after the
 * user's lunch. It can then set its own wake-up instead of asking the user to
 * remember.
 *
 * The definition is passed to `ctx.tools.register` as RAW JSON Schema, which is
 * what the registry stores after compiling a schema spec. It is written that
 * way because this plugin cannot import \`@deepseek-ai/dsh-tools\` from a linked
 * package, and a hand-rolled spec compiler would be a second implementation of
 * a contract this plugin does not own.
 *
 * @module dsh-clock/host/tool
 */

import type { ClockAlarm } from '../shared/types.ts'
import type { ClockService } from './service.ts'
import { durationText, isValidTimeZone, isoInZone } from './time.ts'

/** The model-facing tool name. */
export const TOOL_NAME = 'clock'

/** The calling agent, as the tool runtime hands it to execute(). */
export interface ToolExecLike {
  agent?: { session?: { id?: string } }
  signal?: AbortSignal
}

/** The tool registry, narrowed to the one method used. */
export interface ToolRegistryLike {
  register(definition: Record<string, unknown>): () => void
}

/** One compact row the model reads back. */
interface ToolRow {
  id: string
  at: string
  in: string
  keyword: string
  sessionId: string
  status: string
  label?: string
  note?: string
  error?: string
}

/** The canonical value every call returns. */
interface ToolValue {
  action: string
  summary: string
  sessionId: string
  timeZone: string
  now: string
  alarms: ToolRow[]
  notes: string[]
}

/** Parameter schema, written directly as JSON Schema. */
const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['now', 'set', 'list', 'cancel'],
      description:
        'now reads the current time. set creates a wake-up. list shows alarms. cancel removes pending ones.',
    },
    sessionId: {
      type: 'string',
      description:
        'Conversation to wake. Defaults to the calling conversation; set it to wake a different one.',
    },
    afterSeconds: {
      type: 'number',
      description: 'Relative delay in seconds from now. Give this or at, not both.',
    },
    at: {
      type: 'string',
      description:
        'Absolute instant as an ISO-8601 string, e.g. 2026-09-11T09:30:00+08:00. Give this or afterSeconds.',
    },
    timeZone: {
      type: 'string',
      description: 'IANA zone the instant should be displayed in, e.g. Asia/Shanghai. Defaults to the host zone.',
    },
    keyword: {
      type: 'string',
      description: 'The word or short phrase that opens the wake message and identifies why the agent was woken.',
    },
    note: {
      type: 'string',
      description: 'Longer instruction carried into the wake message, e.g. what to check when it arrives.',
    },
    label: {
      type: 'string',
      description: 'Short label for the alarm itself, shown in the panel.',
    },
    id: { type: 'string', description: 'Alarm id, for cancel.' },
    all: { type: 'boolean', description: 'With cancel, cancel every pending alarm of the calling conversation.' },
  },
  required: ['action'],
}

/**
 * Render one alarm as a compact row.
 *
 * Optional fields are assigned only when present. A key holding `undefined` is
 * still a key, and the output schema below is strict, so leaving one in place
 * would fail validation at the registry rather than simply being omitted.
 * @param alarm - the alarm to render.
 * @param now - current instant, for the relative field.
 * @returns the row.
 */
function toRow(alarm: ClockAlarm, now: number): ToolRow {
  const row: ToolRow = {
    id: alarm.id,
    at: isoInZone(alarm.at, alarm.timeZone),
    in: durationText(alarm.at - now),
    keyword: alarm.keyword,
    sessionId: alarm.sessionId,
    status: alarm.status,
  }
  if (alarm.label !== undefined) row.label = alarm.label
  if (alarm.note !== undefined) row.note = alarm.note
  if (alarm.error !== undefined) row.error = alarm.error
  return row
}

/**
 * Output schema: the canonical value every call returns.
 *
 * The registry requires an output declaration — it refuses a tool with none,
 * reporting `tool "<name>" must declare output`. This is that declaration for
 * the clock tool, written as raw JSON Schema for the same reason the parameter
 * schema is: this plugin cannot import the harness schema compiler.
 */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string' },
    summary: { type: 'string' },
    sessionId: { type: 'string' },
    timeZone: { type: 'string' },
    now: { type: 'string' },
    alarms: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          at: { type: 'string' },
          in: { type: 'string' },
          keyword: { type: 'string' },
          sessionId: { type: 'string' },
          status: { type: 'string' },
          label: { type: 'string' },
          note: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['id', 'at', 'in', 'keyword', 'sessionId', 'status'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['action', 'summary', 'sessionId', 'timeZone', 'now', 'alarms', 'notes'],
}

/**
 * Build the tool definition bound to one service.
 * @param service - the clock service.
 * @returns the definition the registry accepts.
 */
export function buildTool(service: ClockService): Record<string, unknown> {
  return {
    name: TOOL_NAME,
    description:
      'Schedule a wake-up: when a chosen instant passes, a message carrying a keyword is delivered into a conversation — by default this one, or another conversation by id. Use it to come back to work at a set time. A wake delivered late says so, including the scheduled time, the actual time, and the drift.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: ToolValue) {
        const lines = [value.summary]
        if (value.notes.length > 0) lines.push(...value.notes.map((note) => '· ' + note))
        for (const row of value.alarms) {
          lines.push(row.at + '  in ' + row.in + '  [' + row.status + ']  ' + row.keyword + '  -> ' + row.sessionId)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: Record<string, unknown>, exec: ToolExecLike): Promise<ToolValue> => {
      const action = String(args.action ?? '')
      const callingSession = exec.agent?.session?.id ?? ''
      const now = service.now()
      const notes: string[] = []

      if (action === 'now') {
        const requested = typeof args.timeZone === 'string' && isValidTimeZone(args.timeZone) ? args.timeZone : service.timeZone
        return {
          action,
          summary: 'Current time is ' + isoInZone(now, requested) + ' [' + requested + '].',
          sessionId: callingSession,
          timeZone: requested,
          now: isoInZone(now, requested),
          alarms: [],
          notes,
        }
      }

      if (action === 'set') {
        const target = typeof args.sessionId === 'string' && args.sessionId.trim() !== '' ? args.sessionId.trim() : callingSession
        if (target === '') throw new Error('no target conversation: pass sessionId explicitly')
        let at: number
        if (typeof args.afterSeconds === 'number' && Number.isFinite(args.afterSeconds)) {
          at = now + Math.round(args.afterSeconds * 1000)
        } else if (typeof args.at === 'string' && args.at.trim() !== '') {
          const parsed = Date.parse(args.at)
          if (Number.isNaN(parsed)) {
            throw new Error(
              'at must be a parseable ISO-8601 instant with an explicit offset, e.g. 2026-09-11T09:30:00+08:00',
            )
          }
          at = parsed
        } else {
          throw new Error('pass either afterSeconds or an explicit at instant')
        }
        const requestedZone = typeof args.timeZone === 'string' && isValidTimeZone(args.timeZone) ? args.timeZone : service.timeZone
        const alarm = await service.create({
          at,
          timeZone: requestedZone,
          keyword: String(args.keyword ?? ''),
          note: typeof args.note === 'string' ? args.note : undefined,
          label: typeof args.label === 'string' ? args.label : undefined,
          sessionId: target,
          origin: 'agent',
        })
        if (target !== callingSession) {
          notes.push('This alarm wakes a different conversation (' + target + '); it will be resumed if it is closed.')
        }
        return {
          action,
          summary: 'Alarm ' + alarm.id + ' will wake ' + target + ' at ' + isoInZone(at, requestedZone) + '.',
          sessionId: callingSession,
          timeZone: requestedZone,
          now: isoInZone(now, requestedZone),
          alarms: [toRow(alarm, now)],
          notes,
        }
      }

      if (action === 'list') {
        const rows = service.store.all().map((alarm) => toRow(alarm, now))
        return {
          action,
          summary: rows.length === 0 ? 'No alarms.' : String(rows.length) + ' alarm(s).',
          sessionId: callingSession,
          timeZone: service.timeZone,
          now: isoInZone(now, service.timeZone),
          alarms: rows,
          notes,
        }
      }

      if (action === 'cancel') {
        if (args.all === true) {
          if (callingSession === '') throw new Error('cannot cancel all without a calling conversation')
          const mine = service.store.pending().filter((alarm) => alarm.sessionId === callingSession)
          for (const alarm of mine) await service.cancel(alarm.id)
          return {
            action,
            summary: 'Cancelled ' + String(mine.length) + ' pending alarm(s) for this conversation.',
            sessionId: callingSession,
            timeZone: service.timeZone,
            now: isoInZone(now, service.timeZone),
            alarms: [],
            notes,
          }
        }
        const id = typeof args.id === 'string' ? args.id.trim() : ''
        if (id === '') throw new Error('pass id, or all: true')
        const cancelled = await service.cancel(id)
        if (cancelled === undefined) throw new Error('no alarm with id ' + id)
        return {
          action,
          summary: 'Cancelled alarm ' + id + '.',
          sessionId: callingSession,
          timeZone: service.timeZone,
          now: isoInZone(now, service.timeZone),
          alarms: [toRow(cancelled, now)],
          notes,
        }
      }

      throw new Error('unknown action: ' + action)
    },
  }
}

/**
 * Register the clock tool.
 * @param tools - the tool registry.
 * @param service - the clock service.
 * @returns the disposer removing the tool.
 */
export function registerTool(tools: ToolRegistryLike, service: ClockService): () => void {
  return tools.register(buildTool(service))
}
