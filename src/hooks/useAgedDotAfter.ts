'use client'

import { useSyncExternalStore } from 'react'

/**
 * TEMPORARY (Trent, 2026-10-29): an Aged out heading variant to compare on
 * dev — the word first and the dot after it ("DAYS ●"), with no dot on the
 * rows inside Aged out (rows elsewhere keep theirs). `?agedDot=after` turns
 * it on and remembers it on the device (localStorage `opentask_aged_dot`);
 * `?agedDot=off` (or `before`) clears it. Only on a build with Aged out
 * (`NEXT_PUBLIC_AGED_OUT=1`, dev); remove once he picks.
 */
const STORAGE_KEY = 'opentask_aged_dot'
const ENABLED = process.env.NEXT_PUBLIC_AGED_OUT === '1'

let current: boolean | undefined

function read(): boolean {
  if (current !== undefined) return current
  current = false
  try {
    const param = new URLSearchParams(window.location.search).get('agedDot')
    if (param === 'after') window.localStorage.setItem(STORAGE_KEY, 'after')
    else if (param === 'off' || param === 'before') window.localStorage.removeItem(STORAGE_KEY)
    current = window.localStorage.getItem(STORAGE_KEY) === 'after'
  } catch {
    // No storage: the default.
  }
  return current
}

const subscribe = () => () => {}
const serverSnapshot = () => false

/** Whether the Aged out headings carry the dot AFTER the word, and its rows none. */
export function useAgedDotAfter(): boolean {
  const after = useSyncExternalStore(subscribe, read, serverSnapshot)
  return ENABLED && after
}
