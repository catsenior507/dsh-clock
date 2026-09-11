/**
 * dsh-clock, host half — a calendar and clock that can wake a conversation.
 *
 * The harness already schedules reminders, but only inside the conversation
 * that asked for one: @deepseek-ai/dsh-schedule states plainly that delivery
 * is session-local, that there is no cold-session scheduler, and that a closed
 * session keeps its reminders overdue until somebody resumes it. That is the
 * gap this plugin fills. An alarm here names the conversation it wakes, that
 * conversation may be closed, and waking it resumes it.
 *
 * Three trigger layers, one delivery path:
 *
 * 1. An in-process timer armed for the earliest pending alarm — one setTimeout,
 *    re-derived on every change, never a polling loop.
 * 2. A Windows scheduled task mirroring that same instant, because the OS
 *    knows about machine sleep and missed schedules (StartWhenAvailable), and
 *    is the only layer that can be told to wake the machine.
 * 3. A catch-up replay at host start, which is what actually covers the case
 *    where the host was not running when the alarm was due.
 *
 * All three call the same idempotent claim-then-deliver path, so stacking them
 * cannot deliver a wake twice. Every wake carries the scheduled instant, the
 * actual instant, the signed drift, and a warning when it is late — because a
 * deliberately late wake and an on-time one must not read the same to the agent
 * that receives it.
 *
 * Pieces:
 *
 * - host/service.ts — the alarm table, the three layers, the wake path
 * - host/store.ts — atomic durable storage
 * - host/fire.ts — wake text and delivery through the session controller
 * - host/scheduler.ts — the in-process timer
 * - host/system-scheduler.ts — the Windows Task Scheduler mirror
 * - host/api.ts — the HTTP surface the browser panel drives
 * - host/tool.ts — the clock tool the agent drives
 * - client/ — the calendar and clock panel
 *
 * @module @dsh-external/dsh-client-plugin-clock
 */

import type { ClockConfig } from './shared/types.ts'
import { ClockService, type PluginContext } from './host/service.ts'
import { registerWebRoute, startStandaloneServer, type WebServerLike } from './host/api.ts'
import { registerTool, type ToolRegistryLike } from './host/tool.ts'
import { systemSchedulerSupported } from './host/system-scheduler.ts'

/** Cordis plugin name. */
export const name = 'clock'

/**
 * The services this plugin cannot work without.
 *
 * Cordis refuses to read a service property from a context that never declared
 * it, and that refusal happens at plugin-apply time — so an undeclared
 * dependency is a boot failure rather than a degraded feature. The sessions and
 * tools services are mounted by dsh-base in every profile, so requiring them
 * costs nothing. The session controller is deliberately NOT listed: it is the
 * service that actually performs a wake, but it is registered by the Web
 * Session controller rather than by the base profile, and declaring it would
 * stop the panel from existing at all in a profile that lacks it. It is
 * resolved lazily at delivery time instead, and the panel reports the wake
 * path as unavailable when it is missing.
 */
export const inject = ['sessions', 'tools']

/**
 * Read an optional service without declaring it in the inject list.
 *
 * Cordis exposes ctx.get(name) for exactly this: a missing service yields
 * undefined instead of the inject refusal a property read would raise.
 * @param ctx - the plugin context.
 * @param name - service name.
 * @returns the service, or undefined when the profile does not mount it.
 */
function optionalService<T>(ctx: PluginContext, name: string): T | undefined {
  const direct = (ctx as { get?: (serviceName: string) => unknown }).get
  if (typeof direct === 'function') {
    try {
      const value = direct.call(ctx, name)
      if (value !== undefined) return value as T
    } catch {
      // Fall through to the reflection accessor below.
    }
  }
  const reflect = (ctx as { reflect?: { get?: (serviceName: string, strict?: boolean) => unknown } }).reflect
  if (reflect !== undefined && typeof reflect.get === 'function') {
    try {
      return reflect.get(name, false) as T | undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Mount the host half.
 * @param ctx - the plugin cordis context.
 * @param config - optional plugin configuration from the profile row.
 */
export function apply(ctx: PluginContext, config?: Partial<ClockConfig>): void {
  const sessions = ctx.sessions
  if (sessions === undefined) {
    ctx.logger?.warn('[clock] sessions service unavailable; plugin not activated')
    return
  }
  const service = new ClockService({ ctx, config })
  service.start()
  ctx.effect?.(() => () => {
    void service.dispose()
  }, 'clock: lifecycle')

  const controller = optionalService<unknown>(ctx, 'sessionController')
  if (controller === undefined) {
    ctx.logger?.warn('[clock] sessionController unavailable: alarms can be created and listed, but waking is disabled')
  }
  if (service.config.useSystemScheduler && !systemSchedulerSupported()) {
    ctx.logger?.info?.('[clock] OS scheduler mirror unavailable on this platform; using the in-process timer only')
  }

  const api = mountApi(ctx, service)
  const tool = service.config.exposeTool ? mountTool(ctx, service) : 'disabled'
  // One durable line per activation. The harness logger's output does not reach
  // the host's captured stdout, so without this a plugin that activated only
  // partly would leave nothing anywhere that a maintainer can read.
  service.note(
    'apply: sessionController=' +
      (controller === undefined ? 'missing' : 'present') +
      ' tool=' +
      tool +
      ' api=' +
      api +
      ' systemScheduler=' +
      String(service.config.useSystemScheduler && systemSchedulerSupported()),
  )
}

// Deliberately NO default export: cordis resolves a module plugin as
// module.default ?? module, so a default export would hide the named inject
// above and every ctx.sessions read would fail with "cannot get property
// sessions without inject".

/**
 * Mount the HTTP surface on whichever carrier this profile has.
 * @returns which carrier took it, for the startup log.
 */
function mountApi(ctx: PluginContext, service: ClockService): string {
  const deps = { service }
  const webServer = optionalService<WebServerLike>(ctx, 'webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    try {
      const dispose = registerWebRoute(webServer, deps)
      ctx.effect?.(() => () => dispose(), 'clock: web route')
      ctx.logger?.info?.('[clock] mounted at /api/clock')
      return 'webroute'
    } catch (error) {
      ctx.logger?.warn?.('[clock] mounting the webServer route failed; falling back to a local port: ' + String(error))
    }
  }
  void startStandaloneServer(deps)
    .then((server) => {
      ctx.effect?.(() => () => {
        server.close()
      }, 'clock: standalone server')
      ctx.logger?.info?.('[clock] local API http://127.0.0.1:' + service.config.port)
    })
    .catch((error: unknown) => {
      ctx.logger?.warn?.('[clock] local API port unavailable: ' + String(error))
    })
  return 'standalone'
}

/**
 * Register the model-facing clock tool when a tool registry exists.
 *
 * The injected property is tried before the reflective lookup on purpose. The
 * `tools` service is declared in `inject`, so cordis has already placed it on
 * the context as a property; the reflective `ctx.get()` path is a fallback for
 * versions that expose it differently, not the primary route.
 * @param ctx - the plugin context.
 * @param service - the clock service.
 * @returns the outcome, for the startup log.
 */
function mountTool(ctx: PluginContext, service: ClockService): string {
  const injected = (ctx as unknown as { tools?: ToolRegistryLike }).tools
  const tools = injected ?? optionalService<ToolRegistryLike>(ctx, 'tools')
  if (tools === undefined) return 'no-registry'
  if (typeof tools.register !== 'function') return 'registry-without-register'
  try {
    const dispose = registerTool(tools, service)
    ctx.effect?.(() => () => dispose(), 'clock: clock tool')
    return 'registered'
  } catch (error) {
    ctx.logger?.warn?.('[clock] registering the clock tool failed: ' + String(error))
    return 'threw:' + String(error).slice(0, 120)
  }
}
