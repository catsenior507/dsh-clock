/**
 * The calendar button in the sidebar foot, next to Settings.
 *
 * It is registered into `sidebar.footer.action`, which the sidebar shell renders
 * as a list inside the same bottom-pinned foot area as the `sidebar.settings`
 * seat that holds the Settings trigger. That is the additive seat the plugin
 * development guide recommends for a small sidebar action, and it keeps this
 * button beside Settings without replacing anything.
 *
 * The slot hands the `wide` flag, which is false while the sidebar is collapsed
 * to its 56px rail; the label is dropped then so the button stays one icon.
 *
 * @module dsh-clock/client/button
 */

import React from 'react'
import styles from './clock.module.css'
import { toggleOpen, useOpen } from './bus.ts'

/** Props the shell passes to every list entry in the sidebar foot. */
export interface SidebarActionProps {
  wide?: boolean
}

/**
 * Render the sidebar calendar trigger.
 * @param props - the shell's slot props.
 * @returns the button element.
 */
export function CalendarButton(props: SidebarActionProps): React.ReactElement {
  const open = useOpen()
  const className = styles.sidebarButton + (open ? ' ' + styles.sidebarButtonActive : '')
  return React.createElement(
    'button',
    {
      type: 'button',
      className,
      title: '时钟与日历：定时唤醒某个对话',
      'aria-label': '打开时钟与日历',
      'aria-pressed': open,
      onClick: () => toggleOpen(),
    },
    React.createElement('span', { className: styles.sidebarIcon, 'aria-hidden': 'true' }, '\u{1F4C5}'),
    props.wide === false ? null : React.createElement('span', { className: styles.sidebarLabel }, '日历'),
  )
}
