/**
 * dsh-clock client half: mounts the calendar and clock panel into the dsh web
 * GUI.
 *
 * React comes from the shell module table, so the bundle carries no framework
 * copy and the panel shares the shell instance. The mount point is a plain body
 * child rather than a slot: the panel is a floating, always-available surface
 * that must keep working even when a theme plugin reshapes the layout.
 *
 * @module dsh-clock/client
 */
import type { Context } from '@deepseek-ai/cordis'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ClockApp } from './panel'
import './clock.module.css'

const OWNER = 'clock'

/**
 * Mount the panel.
 * @param ctx - the client plugin context.
 */
export function apply(ctx: Context): void {
  const mount = document.createElement('div')
  mount.dataset.dshClockRoot = ''
  mount.setAttribute('aria-label', 'calendar and clock')
  document.body.append(mount)

  let root: Root | null = null
  try {
    root = createRoot(mount)
    root.render(React.createElement(ClockApp))
  } catch {
    mount.remove()
    throw new Error('[' + OWNER + '] mounting the calendar panel failed: React root creation threw')
  }

  ctx.effect(() => () => {
    root?.unmount()
    mount.remove()
  }, 'ui-clock: panel lifecycle')
}
