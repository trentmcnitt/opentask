'use client'

import { useCallback } from 'react'
import { useFoldState } from '@/components/FoldStateProvider'
import { useIsMobile } from '@/hooks/useIsMobile'

/**
 * A fold whose DEFAULT depends on the viewport — shut on a phone, open on a
 * desktop — and whose override does not.
 *
 * WHY THREE STATES AND NOT TWO. `null` is "the user has not chosen yet", and it
 * is not the same as "shut".
 *
 * The dashboard is NOT in the server HTML, which an earlier version of this
 * comment claimed — `SessionProvider` is given no session, so `useSession()` is
 * still `loading` during SSR and `HomeContent` returns the "Loading…" gate
 * instead of `<main>`. The design below is right anyway, for a different
 * reason: the fold has to be correct in the FIRST CLIENT PAINT, and effects
 * have not run at that point. `useIsMobile` reads `window.innerWidth` in a
 * `useEffect` and returns `false` until it does, so a fold whose visuals came
 * from JS would paint fully open on a phone and collapse a frame later — a
 * 350-500px lurch on exactly the surface this fold exists to keep short.
 * Reading `matchMedia` in a lazy `useState` initialiser instead swaps one bug
 * for another as soon as any surface using these folds IS server-rendered: the
 * server renders `false`, the client renders `true`, and that is a hydration
 * mismatch — a console error, on a surface whose acceptance criteria include
 * having none.
 *
 * So the DEFAULT is expressed in CSS (`hidden sm:block` and friends, via
 * `foldClass` below) and is therefore correct in the very first paint with no
 * JavaScript at all, while an explicit choice — which can only ever come from a
 * click, long after mount — is expressed in state and wins over the CSS.
 *
 * `open` is the same question answered in JS. It is a frame late on first load,
 * which is why the VISUALS never use it; it is for `aria-expanded`, which is
 * read by assistive tech long after hydration, and for the toggle handler,
 * which needs to know what it is toggling away from.
 *
 * WHERE THE CHOICE LIVES, AND HOW LONG IT LASTS. In `FoldStateProvider`, up in
 * the root layout, so it SURVIVES IN-APP NAVIGATION and is lost on reload. It
 * used to be `useState` in the panel, which meant a trip to `/quotas` and back
 * reopened every fold. It is deliberately not a server preference yet — see
 * `FoldStateProvider` for why a `track_expanded`-shaped boolean cannot express
 * "shut on the phone, open on the desktop", and what a persisted version would
 * cost.
 */
export type FoldState = boolean | null

/** The three class strings a fold picks between. See `foldClass`. */
export interface FoldClasses {
  /** The user opened it. */
  open: string
  /** The user shut it. */
  shut: string
  /** No choice yet — the viewport decides, in CSS. */
  auto: string
}

/**
 * Pick the classes for a fold's current state.
 *
 * Every string in a `FoldClasses` must be a LITERAL in the source. Tailwind
 * scans source text for class names, so a computed string like `sm:${display}`
 * generates no CSS and silently does nothing.
 */
export function foldClass(state: FoldState, classes: FoldClasses): string {
  if (state === null) return classes.auto
  return state ? classes.open : classes.shut
}

/** Content that is there when open. Hidden below `sm` until the user says otherwise. */
export const FOLD_BODY_BLOCK: FoldClasses = {
  open: 'block',
  shut: 'hidden',
  auto: 'hidden sm:block',
}

/** As `FOLD_BODY_BLOCK`, for a body that lays its children out in a row. */
export const FOLD_BODY_FLEX: FoldClasses = {
  open: 'flex',
  shut: 'hidden',
  auto: 'hidden sm:flex',
}

/** The summary that stands in for the content while it is folded away. */
export const FOLD_SUMMARY: FoldClasses = {
  open: 'hidden',
  shut: 'flex',
  auto: 'flex sm:hidden',
}

/** A disclosure chevron: down when open, pointing at the header when shut. */
export const FOLD_CHEVRON: FoldClasses = {
  open: '',
  shut: '-rotate-90',
  auto: '-rotate-90 sm:rotate-0',
}

/** One fold, identified by a globally unique `key` — see `FoldStateProvider`. */
export function useResponsiveFold(key: string) {
  const isSmall = useIsMobile()
  const { choices, toggleChoice } = useFoldState()
  const state = choices.get(key) ?? null
  const open = state ?? !isSmall
  const toggle = useCallback(() => toggleChoice(key, !isSmall), [key, isSmall, toggleChoice])
  return { state, open, toggle }
}

/**
 * Many independent folds — the Track panel's label groups.
 *
 * `namespace` prefixes every key on the way into the shared map, so two
 * surfaces can both have a group called "health" without sharing its fold.
 */
export function useResponsiveFolds(namespace: string) {
  const isSmall = useIsMobile()
  const { choices, toggleChoice } = useFoldState()

  const stateOf = useCallback(
    (key: string): FoldState => choices.get(`${namespace}:${key}`) ?? null,
    [choices, namespace],
  )
  const isOpen = useCallback(
    (key: string) => choices.get(`${namespace}:${key}`) ?? !isSmall,
    [choices, isSmall, namespace],
  )
  const toggle = useCallback(
    (key: string) => toggleChoice(`${namespace}:${key}`, !isSmall),
    [isSmall, namespace, toggleChoice],
  )

  return { stateOf, isOpen, toggle }
}
