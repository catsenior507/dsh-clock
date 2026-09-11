/**
 * The one piece of shared state between the sidebar button and the panel.
 *
 * The button is mounted by the slot system inside the shell's sidebar foot,
 * while the panel is mounted on the document body by this plugin's own root.
 * They are two React trees, so a context cannot cross them; a module-level
 * store with `useSyncExternalStore` is the smallest thing that can.
 *
 * @module dsh-clock/client/bus
 */

import { useSyncExternalStore } from 'react'

let open = false
const listeners = new Set<() => void>()

/** Whether the calendar panel is showing. */
export function isOpen(): boolean {
  return open
}

/** Show or hide the panel. */
export function setOpen(value: boolean): void {
  if (open === value) return
  open = value
  for (const listener of listeners) listener()
}

/** Flip the panel. */
export function toggleOpen(): void {
  setOpen(!open)
}

/** Subscribe to open-state changes. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Read the open state from a component. */
export function useOpen(): boolean {
  return useSyncExternalStore(subscribe, isOpen, isOpen)
}
