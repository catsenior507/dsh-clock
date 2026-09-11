/**
 * dsh-clock client half.
 *
 * Two contributions:
 *
 * 1. A calendar button in `sidebar.footer.action`. The sidebar shell renders
 *    that slot as a LIST inside the same bottom-pinned foot area as the
 *    `sidebar.settings` seat that holds the Settings trigger, so registering
 *    there puts the button beside Settings without replacing anything — the
 *    additive seat the plugin development guide recommends for a small sidebar
 *    action.
 * 2. The panel itself, mounted on the document body by this plugin's own root
 *    rather than by a slot, so the sidebar collapsing to its 56px rail cannot
 *    clip it.
 *
 * Those are two React trees, so state cannot cross them through a context;
 * `bus.ts` is the single value they share.
 *
 * @module dsh-clock/client
 */
import type { Context } from '@deepseek-ai/cordis'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CalendarButton } from './button'
import { ClockApp } from './panel'
import './clock.module.css'

const OWNER = 'clock'

/** The additive sidebar-foot seat this plugin fills. */
const SIDEBAR_SLOT = 'sidebar.footer.action'

/** The slot registry, narrowed to the two methods used. */
interface SlotsLike {
  inject(name: string, callback: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
}

/**
 * Client services this plugin needs.
 *
 * Declaring `slots` is what makes the sidebar seat reachable; without it the
 * plugin would simply not activate, and the panel would quietly stop existing.
 */
export const inject = ['slots']

/**
 * Mount the panel and register the sidebar trigger.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: Context): void {
  const mount = document.createElement('div')
  mount.dataset.dshClockRoot = ''
  document.body.append(mount)

  let root: Root | null = null
  try {
    root = createRoot(mount)
    root.render(React.createElement(ClockApp))
  } catch (error) {
    mount.remove()
    throw new Error('[' + OWNER + '] mounting the calendar panel failed: ' + String(error))
  }

  ctx.effect(() => () => {
    root?.unmount()
    mount.remove()
  }, 'ui-clock: panel lifecycle')

  const slots = (ctx as unknown as { slots?: SlotsLike }).slots
  if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
  let registered: (() => void) | undefined
  ctx.effect(() => {
    const outer = slots.inject(SIDEBAR_SLOT, () => {
      registered = slots.register({ name: SIDEBAR_SLOT, id: 'clock-calendar', order: 20 }, CalendarButton) as
        | (() => void)
        | undefined
      return registered
    }) as (() => void) | undefined
    return () => {
      outer?.()
      registered?.()
    }
  }, 'ui-clock: sidebar action')
}
