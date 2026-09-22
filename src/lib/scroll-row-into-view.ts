/**
 * Bring a deep-linked row on screen (`?reminder=<id>` on `/reminders`,
 * `?task=<id>&highlight=1` on `/`, both from the iOS/macOS widgets — see
 * `WidgetLink` in `ios/OpenTaskWidgets/WidgetTheme.swift`).
 *
 * A callback ref rather than an effect: the row may mount already highlighted
 * (inside a fold the link had to open) or become highlighted while it is
 * already mounted, and React hands the node to a changed callback ref in both
 * cases — one code path instead of two. Module-level so its identity is
 * stable and a caller can pass it directly as `ref={highlighted ?
 * scrollRowIntoView : undefined}`.
 *
 * Shared by `RemindersView.tsx` and `TaskRow.tsx` — both pair it with the same
 * `.animate-row-highlight` class (`globals.css`) and an `onAnimationEnd`
 * guard that clears the highlight once the flash has played, so a remount
 * can't replay it.
 */
export function scrollRowIntoView(el: HTMLElement | null): void {
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}
