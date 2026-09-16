'use client'

import { useCallback, useState } from 'react'
import { useIsMobile } from '@/hooks/useIsMobile'

/**
 * A fold whose DEFAULT depends on the viewport — shut on a phone, open on a
 * desktop — and whose override does not.
 *
 * WHY THREE STATES AND NOT TWO. `null` is "the user has not chosen yet", and it
 * is not the same as "shut". The dashboard is server-rendered with the user's
 * tasks already in it (`src/app/page.tsx`), so the Track panel is in the very
 * first paint. Resolving the viewport in JS — `useIsMobile`, which reads the
 * width in an effect — would paint the panel fully open on a phone and collapse
 * it a frame later, which is a 350-500px lurch on exactly the surface this fold
 * exists to keep short. Reading `matchMedia` in a lazy `useState` initialiser
 * instead swaps one bug for another: the server renders `false`, the client
 * renders `true`, and that is a hydration mismatch — a console error, on a
 * surface whose acceptance criteria include having none.
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
 * NOT PERSISTED, deliberately, and this is a departure from the sibling it
 * sits next to: the Track panel's own chips/rows fold is a server preference
 * (`track_expanded` in `PreferencesProvider`). A stored boolean cannot express
 * "shut on the phone, open on the desktop" — it is one value for both — so
 * persisting these folds would overwrite the very default this hook exists to
 * provide the moment the user touched one. The in-app precedent for a
 * session-only group fold is `useCollapsedGroups`, which is what this matches.
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

/** One fold. */
export function useResponsiveFold() {
  const isSmall = useIsMobile()
  const [state, setState] = useState<FoldState>(null)
  const open = state ?? !isSmall
  const toggle = useCallback(() => setState((prev) => !(prev ?? !isSmall)), [isSmall])
  return { state, open, toggle }
}

/** Many independent folds, keyed by name — the Track panel's label groups. */
export function useResponsiveFolds() {
  const isSmall = useIsMobile()
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(() => new Map())

  const stateOf = useCallback((key: string): FoldState => choices.get(key) ?? null, [choices])
  const isOpen = useCallback((key: string) => choices.get(key) ?? !isSmall, [choices, isSmall])
  const toggle = useCallback(
    (key: string) =>
      setChoices((prev) => {
        const next = new Map(prev)
        next.set(key, !(prev.get(key) ?? !isSmall))
        return next
      }),
    [isSmall],
  )

  return { stateOf, isOpen, toggle }
}
