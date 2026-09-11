/**
 * The plugin HTTP surface, shared by both carriers.
 *
 * Two transports mount the same handler table: the harness `webServer` service
 * when the profile has one, and a private loopback server otherwise, because a
 * headless profile has no web server at all and the OS-scheduler ping still has
 * to reach a real endpoint.
 *
 * Every response is JSON shaped `{ ok: true, value }` or `{ ok: false, error }`,
 * so the panel has exactly one failure shape to render.
 *
 * @module dsh-clock/host/api
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ClockAlarm, FireTrigger } from '../shared/types.ts'
import type { ClockService } from './service.ts'
import { isValidTimeZone, isoInZone } from './time.ts'

/** Path prefix used when the plugin rides the harness web server. */
export const API_PREFIX = '/api/clock'

/** Everything the routes need. */
export interface ApiDeps {
  service: ClockService
}

/** One resolved HTTP response. */
export interface ApiResponse {
  status: number
  body: unknown
}

/** The harness web-server service, narrowed to the one method used. */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Read a request body as text, bounded so a malformed peer stays harmless. */
export async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse a JSON body, treating an empty body as an empty object. */
export function parseJson(text: string): Record<string, unknown> {
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** Read a required non-empty string field. */
function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(field + ' is required')
  return value.trim()
}

/** Read an optional trimmed string field. */
function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Resolve the instant a request names.
 *
 * Two spellings are accepted because two callers exist: the agent tool states a
 * delay ("in twenty minutes"), while the panel states an exact instant it drew
 * on a calendar. Both land here as epoch milliseconds.
 * @param body - the request body.
 * @param now - current instant, the base for a relative request.
 * @returns the resolved instant.
 */
export function resolveRequestedAt(body: Record<string, unknown>, now: number): number {
  const after = body.afterSeconds
  if (typeof after === 'number' && Number.isFinite(after)) return now + Math.round(after * 1000)
  const at = body.at
  if (typeof at === 'number' && Number.isFinite(at)) return Math.round(at)
  if (typeof at === 'string' && at.trim() !== '') {
    const parsed = Date.parse(at)
    if (Number.isNaN(parsed)) throw new Error('at is not a parseable date-time: ' + at)
    return parsed
  }
  throw new Error('either at (epoch ms or ISO string) or afterSeconds is required')
}

/** Wrap a value as a success response. */
function ok(value: unknown): ApiResponse {
  return { status: 200, body: { ok: true, value } }
}

/** Wrap a message as a failure response. */
function fail(status: number, error: string): ApiResponse {
  return { status, body: { ok: false, error } }
}

/**
 * Resolve one request against the service.
 * @param deps - the clock service.
 * @param method - HTTP method.
 * @param pathname - pathname, absolute or prefixed.
 * @param _query - decoded query parameters.
 * @param body - parsed JSON body.
 * @returns the status and JSON body to send.
 */
export async function handle(
  deps: ApiDeps,
  method: string,
  pathname: string,
  _query: URLSearchParams,
  body: Record<string, unknown>,
): Promise<ApiResponse> {
  const path = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname
  const service = deps.service
  try {
    if (method === 'GET' && (path === '/state' || path === '/' || path === '')) return ok(await service.state())
    if (method === 'GET' && path === '/now') {
      const now = service.now()
      return ok({ now, timeZone: service.timeZone, iso: isoInZone(now, service.timeZone) })
    }
    if (method === 'POST' && path === '/alarms') {
      const now = service.now()
      const requestedZone = optionalString(body, 'timeZone')
      const timeZone =
        requestedZone !== undefined && isValidTimeZone(requestedZone) ? requestedZone : service.timeZone
      const sessionTitle = optionalString(body, 'sessionTitle')
      const alarm = await service.create({
        at: resolveRequestedAt(body, now),
        timeZone,
        keyword: requiredString(body, 'keyword'),
        note: optionalString(body, 'note'),
        sessionId: requiredString(body, 'sessionId'),
        sessionTitle,
        label: optionalString(body, 'label'),
        origin: body.origin === 'agent' ? 'agent' : 'user',
      })
      return ok(alarm)
    }
    if (method === 'POST' && path === '/alarms/update') {
      const id = requiredString(body, 'id')
      const patch: Partial<ClockAlarm> = {}
      if (body.at !== undefined || body.afterSeconds !== undefined) {
        patch.at = resolveRequestedAt(body, service.now())
      }
      if (typeof body.keyword === 'string' && body.keyword.trim() !== '') patch.keyword = body.keyword.trim()
      if (typeof body.note === 'string') patch.note = body.note.trim() === '' ? undefined : body.note.trim()
      if (typeof body.label === 'string') patch.label = body.label.trim() === '' ? undefined : body.label.trim()
      if (typeof body.sessionId === 'string' && body.sessionId.trim() !== '') patch.sessionId = body.sessionId.trim()
      if (typeof body.sessionTitle === 'string') patch.sessionTitle = body.sessionTitle
      if (typeof body.timeZone === 'string' && isValidTimeZone(body.timeZone)) patch.timeZone = body.timeZone
      const updated = await service.update(id, patch)
      return updated === undefined ? fail(404, 'no alarm with id ' + id) : ok(updated)
    }
    if (method === 'POST' && path === '/alarms/cancel') {
      const updated = await service.cancel(requiredString(body, 'id'))
      return updated === undefined ? fail(404, 'no alarm with that id') : ok(updated)
    }
    if (method === 'POST' && path === '/alarms/forget') {
      const removed = await service.forget(requiredString(body, 'id'))
      return removed ? ok({ removed: true }) : fail(404, 'no alarm with that id')
    }
    if (method === 'POST' && path === '/alarms/fire') {
      const fired = await service.fireOne(requiredString(body, 'id'), 'manual' satisfies FireTrigger)
      return fired === undefined ? fail(404, 'no alarm with that id') : ok(fired)
    }
    if (method === 'POST' && path === '/tick') {
      // The OS scheduler's ping. It is answered immediately and the delivery
      // continues in the background: a scheduled task should not be held open
      // for the length of a model turn, and a failure is recorded on the alarm.
      const claimed = service.claimDue('system-scheduler')
      if (claimed.length > 0) {
        void Promise.allSettled(claimed.map((alarm) => service.deliver(alarm, 'system-scheduler'))).then(() =>
          service.schedulerState,
        )
      }
      return ok({ claimed: claimed.length, ids: claimed.map((alarm) => alarm.id) })
    }
    return fail(404, 'no such endpoint: ' + method + ' ' + path)
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : String(error))
  }
}

/** Adapt the handler table to a Node request/response pair. */
/**
 * CORS headers for a request that came from this machine.
 *
 * The panel is served by the harness web server on one port while this carrier
 * listens on another, so every call the panel makes is cross-origin and the
 * browser discards the response without these headers. That failure looks like
 * a panel that renders but can never save anything, because it is silent in the
 * page and never reaches this handler as an error.
 *
 * The allowed origin is ECHOED rather than set to a wildcard. Creating an alarm
 * ends in a message injected into a conversation, so `*` would let any page the
 * user happens to visit schedule a prompt injection against their own agent.
 * Only loopback origins are accepted.
 * @param origin - the request's Origin header, when present.
 * @returns headers to merge into the response.
 */
export function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin === undefined) return {}
  try {
    const host = new URL(origin).hostname
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return {}
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    }
  } catch {
    return {}
  }
}

async function nodeHandler(deps: ApiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cors = corsHeaders(req.headers.origin)
  if ((req.method ?? 'GET').toUpperCase() === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }
  let response: ApiResponse
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const method = (req.method ?? 'GET').toUpperCase()
    let body: Record<string, unknown> = {}
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      body = parseJson(await readBody(req))
    }
    response = await handle(deps, method, url.pathname, url.searchParams, body)
  } catch (error) {
    response = fail(400, error instanceof Error ? error.message : String(error))
  }
  const payload = JSON.stringify(response.body)
  res.writeHead(response.status, {
    ...cors,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Mount the API on the harness web server.
 * @param webServer - the webServer service.
 * @param deps - the clock service.
 * @returns the disposer removing the route.
 */
export function registerWebRoute(webServer: WebServerLike, deps: ApiDeps): () => void {
  return webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => nodeHandler(deps, req, res),
  })
}

/** How many consecutive ports the private carrier will try before giving up. */
export const PORT_ATTEMPTS = 8

/** Bind one private carrier on exactly one port. */
function listenOnce(deps: ApiDeps, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    void nodeHandler(deps, req, res)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

/**
 * Start the private loopback server used when the harness web server is not
 * reachable from this plugin's context.
 *
 * A restart is exactly when a fixed port is least reliable — the outgoing host
 * may still hold the socket while the incoming one boots — so a short range is
 * walked rather than failing the feature on the first `EADDRINUSE`.
 * @param deps - the clock service.
 * @returns the listening server.
 * @throws when every port in the range is unavailable.
 */
export async function startStandaloneServer(deps: ApiDeps): Promise<Server> {
  let lastError: unknown = new Error('no port available')
  for (let offset = 0; offset < PORT_ATTEMPTS; offset += 1) {
    try {
      return await listenOnce(deps, deps.service.config.port + offset)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
