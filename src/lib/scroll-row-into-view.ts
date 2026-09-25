/**
 * Bring a deep-linked row on screen (`?reminder=<id>` on `/reminders`,
 * `?task=<id>&highlight=1` on `/`, `?quota=<id>` on `/quotas`, all from the
 * iOS/macOS widgets — see `WidgetLink` in `ios/OpenTaskWidgets/WidgetTheme.swift`).
 *
 * Used two ways:
 * - As a callback ref directly — `ref={highlighted ? scrollRowIntoView :
 *   undefined}` (`RemindersView.tsx`, `QuotasView.tsx`'s `QuotaRow`). The row
 *   may mount already highlighted (inside a fold the link had to open) or
 *   become highlighted while it is already mounted, and React hands the node
 *   to a changed callback ref in both cases — one code path instead of two.
 *   Module-level so its identity is stable across renders.
 * - Called from inside a `ResizeObserver` callback (`TaskRow.tsx`) on
 *   surfaces where content can mount ABOVE the row after it renders and push
 *   it back off-screen — the dashboard's Reminders/Track panels and AI
 *   Insights annotations, none of which `/reminders` or `/quotas` have. See
 *   `TaskRow.tsx`'s doc comment on that effect for why the plain ref isn't
 *   enough there.
 *
 * Every consumer pairs this with the same `.animate-row-highlight` class
 * (`globals.css`) and an `onAnimationEnd` guard that clears the highlight
 * once the flash has played, so a remount can't replay it.
 */
export function scrollRowIntoView(el: HTMLElement | null): void {
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/**
 * Bring a whole SECTION on screen, header first — the Reminders surface's
 * `goToSlot` (its `?slot=<slotId>` deep link, and a tap on the headline's day
 * bar).
 *
 * `block: 'start'`, not the row's `'center'`: a started slot draws every row,
 * so a section can be taller than the screen, and centring it would put the
 * very header the user asked for above the top. The section's own
 * `scroll-margin-top` keeps it clear of the sticky top bar.
 */
export function scrollSectionIntoView(el: HTMLElement | null): void {
  el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
