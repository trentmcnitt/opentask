'use client'

import { useSyncExternalStore } from 'react'

/**
 * TEMPORARY (Trent, 2026-10-29, while lean v2 is designed): the lean row's
 * title weight, overridable on a DEV build so he can try weights without a
 * deploy. `?titleWeight=500` (any 100–900 in steps of 100) sets it and
 * remembers it on the device (localStorage `opentask_title_weight`);
 * `?titleWeight=off` clears it. It replaces both of the title's weights
 * (`titleWeight` in `LeanRow`: 500 plain, 600 tinted) for comparison. Only
 * on the dev build
 * (`NEXT_PUBLIC_DEFAULT_TASK_ROWS` set — production and CI build without
 * it); remove once the weight is decided.
 */
const STORAGE_KEY = 'opentask_title_weight'
const ENABLED = !!process.env.NEXT_PUBLIC_DEFAULT_TASK_ROWS

/** A weight from a URL or storage value: 100–900 in hundreds, else null. */
export function parseTitleWeight(raw: string | null): number | null {
  if (raw === null || !/^[1-9]00$/.test(raw)) return null
  return Number(raw)
}

let current: number | null | undefined

function read(): number | null {
  if (current !== undefined) return current
  current = null
  try {
    const param = new URLSearchParams(window.location.search).get('titleWeight')
    if (param === 'off') window.localStorage.removeItem(STORAGE_KEY)
    else if (parseTitleWeight(param) !== null) window.localStorage.setItem(STORAGE_KEY, param!)
    current = parseTitleWeight(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    // No storage: no override.
  }
  return current
}

const subscribe = () => () => {}
const serverSnapshot = () => null

/** The lean title's weight override, or null (the stylesheet's weight). */
export function useTitleWeightOverride(): number | null {
  const weight = useSyncExternalStore(subscribe, read, serverSnapshot)
  return ENABLED ? weight : null
}
