'use client'

import { useSyncExternalStore, type CSSProperties } from 'react'

/**
 * TEMPORARY (Trent, 2026-10-29: E2 reads "an icy blue… now like an icy teal"
 * on his monitors): the lean row's LIGHT over-target tint, and the later-today
 * tint that follows it, overridable on a DEV build to compare the R6 sheet's
 * options live. `?overTint=e0|e1|e2|e3` sets it and remembers it on the device
 * (localStorage `opentask_over_tint`); `?overTint=off` clears it. The default
 * stays E2 (`LeanRow`'s `STATE_LOOK`, which reads these as CSS variables with
 * E2 as the fallback). Dark is untouched. Only on the dev build
 * (`NEXT_PUBLIC_DEFAULT_TASK_ROWS` set); remove once he picks.
 */
export const OVER_TINTS = {
  e0: { over: 'rgb(231,238,255)', soon: 'rgb(249,251,255)' },
  e1: { over: 'rgb(231,242,255)', soon: 'rgb(249,252,255)' },
  e2: { over: 'rgb(231,245,255)', soon: 'rgb(249,252,255)' },
  e3: { over: 'rgb(224,239,255)', soon: 'rgb(247,251,255)' },
} as const
export type OverTint = keyof typeof OVER_TINTS

const STORAGE_KEY = 'opentask_over_tint'
const ENABLED = !!process.env.NEXT_PUBLIC_DEFAULT_TASK_ROWS

export function parseOverTint(raw: string | null): OverTint | null {
  return raw !== null && raw in OVER_TINTS ? (raw as OverTint) : null
}

let current: OverTint | null | undefined

function read(): OverTint | null {
  if (current !== undefined) return current
  current = null
  try {
    const param = new URLSearchParams(window.location.search).get('overTint')
    if (param === 'off') window.localStorage.removeItem(STORAGE_KEY)
    else if (parseOverTint(param)) window.localStorage.setItem(STORAGE_KEY, param!)
    current = parseOverTint(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    // No storage: no override.
  }
  return current
}

const subscribe = () => () => {}
const serverSnapshot = () => null

/** The row style carrying the override's colours (`--lean-over`, `--lean-soon`), or none. */
export function useOverTintStyle(): CSSProperties | undefined {
  const tint = useSyncExternalStore(subscribe, read, serverSnapshot)
  if (!ENABLED || !tint) return undefined
  const { over, soon } = OVER_TINTS[tint]
  return { '--lean-over': over, '--lean-soon': soon } as CSSProperties
}
