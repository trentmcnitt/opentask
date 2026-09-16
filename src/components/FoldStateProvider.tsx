'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

/**
 * Every responsive fold's explicit choice, held above the router.
 *
 * WHY A PROVIDER AND NOT `useState` IN THE PANEL. The folds this backs live in
 * `TrackPanel`, which is rendered by the dashboard page. In the App Router a
 * page segment unmounts on every client-side navigation while the layouts above
 * it persist — so with the state inside the panel, a trip to `/quotas` and back
 * silently reopened every group the user had just folded shut. Mounting the map
 * in the root layout, beside `PreferencesProvider`, makes the choices last as
 * long as the tab does.
 *
 * NOT PERSISTED TO THE SERVER, and that is a deliberate stopping point rather
 * than the end state. The sibling this pattern should eventually match is
 * `useFilterSection`: the desktop choice is a server preference, the
 * small-screen override is session-only, and the two never write to each other.
 * A fold map needs its own preference to do that (one `track_expanded` boolean
 * cannot say "shut on the phone, open on the desktop", and there is one entry
 * per label rather than one for the panel), which is a schema column, a
 * migration and API plumbing — more than the change that exposed the bug
 * warranted. So the choices survive navigation and are lost on reload.
 *
 * Keys are flat strings and callers namespace their own (`useResponsiveFolds`
 * prefixes every cluster key), so one map serves every fold on every surface
 * without them colliding.
 */
interface FoldStateValue {
  /** Every explicit choice made so far. Absent means "no choice yet". */
  choices: ReadonlyMap<string, boolean>
  /**
   * Flip one fold.
   *
   * `fallbackOpen` is what the fold currently shows when the user has never
   * touched it — the viewport's default. It is passed in rather than read here
   * because only the caller knows which default applies to its own fold.
   */
  toggleChoice: (key: string, fallbackOpen: boolean) => void
}

const FoldStateContext = createContext<FoldStateValue | null>(null)

export function FoldStateProvider({ children }: { children: ReactNode }) {
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(() => new Map())

  const toggleChoice = useCallback((key: string, fallbackOpen: boolean) => {
    setChoices((prev) => {
      const next = new Map(prev)
      next.set(key, !(prev.get(key) ?? fallbackOpen))
      return next
    })
  }, [])

  const value = useMemo(() => ({ choices, toggleChoice }), [choices, toggleChoice])

  return <FoldStateContext.Provider value={value}>{children}</FoldStateContext.Provider>
}

/**
 * Throws rather than falling back to local state if the provider is missing: a
 * silent fallback would be a fold that works in every manual test and quietly
 * forgets itself on navigation, which is the exact bug this replaced.
 */
export function useFoldState(): FoldStateValue {
  const value = useContext(FoldStateContext)
  if (!value) throw new Error('useFoldState must be used inside <FoldStateProvider>')
  return value
}
