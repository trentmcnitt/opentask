/**
 * THE TASK QUEUE SWITCH, AS THIS BROWSER LAST SAW IT (On deck D2 review,
 * 2026-10-20). Until the preferences load, a task-segment row doesn't know
 * whether the switch is on. Rather than guess, it keeps On deck's place empty
 * only when the switch was ON at this viewer's last load; with it off (or
 * nothing stored — a first visit, a private window, storage blocked) it keeps
 * no place, so a switch-off row looks exactly as before the queue from its
 * first paint.
 *
 * A per-viewer convenience in localStorage, every access wrapped: it can be
 * empty or throw, and the page works the same without it. Written by
 * `PreferencesProvider` once the preferences have loaded.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'opentask.taskQueueOn'

export function rememberQueueOn(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    // Storage unavailable: nothing remembered, nothing breaks.
  }
}

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

const noSubscribe = () => () => {}

/** The last-known switch: false on the server and when nothing is stored. */
export function useLastKnownQueueOn(): boolean {
  return useSyncExternalStore(noSubscribe, read, () => false)
}
