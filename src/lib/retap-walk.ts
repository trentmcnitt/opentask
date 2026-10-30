/**
 * RE-TAPPING THE TAB YOU ARE ON WALKS YOU TO WHAT NEEDS YOU (Trent,
 * 2026-10-29: "tapping the tab button should bring you to the next place. If
 * you're scrolled to the top, it should scroll you down to the first place
 * that needs you… I'd rather just be tapping and have the app basically take
 * me through everything by tapping"). docs/SPEC.md § Guiding Principles 6.
 *
 * - Switching to a tab never scrolls; only a re-tap of the tab you are on.
 * - A CYCLE: tap → stop 1 → tap → stop 2 → … → tap → the top → tap → stop 1
 *   again. A stop is an element with `data-retap-stop` that needs you
 *   (`data-needs-you`); its header lands on its landing line
 *   (`scroll-below-header`: under the top bar, its safe-area inset included —
 *   the next-section scroll's line). The order is the page's, unless the
 *   stops carry `data-retap-order` (the Reminders page: `retapOrder`).
 * - A SCROLL BY HAND resets it (Trent, 2026-10-29): after one, the next tap
 *   goes to the top, and the tap after that starts again at stop 1. The
 *   cycle's own scrolls, and the next-section scroll, are not by hand.
 * - Switching to a tab never scrolls, and starts a fresh cycle.
 * `stepWalk` decides every tap — the one place to change the rule (Trent may
 * try "the next stop below where the page is" instead).
 */
import type { Task } from '@/types'
import { isOverdue } from '@/lib/task-counts'
import { pageAfterFinishing } from '@/lib/time-slot-assign'
import { scrollSectionIntoView } from '@/lib/scroll-row-into-view'

/**
 * The Reminders page's walk (Trent, 2026-10-29, his final rule): at most two
 * stops, then the top, then round again —
 * 1. ONE period: the clock's while it has something waiting, else the
 *    earliest unfinished period that has started — the dashboard card's own
 *    pick (`pageAfterFinishing` over the periods alone);
 * 2. the topmost task segment with something waiting, in strip order (the
 *    same function over the segments alone).
 * Pages are the periods in the day's order, then the segments; the answer is
 * page indexes, in walk order. Not every earlier period, not every segment.
 */
export function retapOrder(
  waiting: readonly number[],
  slotCount: number,
  natural: number,
): number[] {
  const periodsOnly = waiting.map((w, i) => (i < slotCount ? w : 0))
  const segmentsOnly = waiting.map((w, i) => (i < slotCount ? 0 : w))
  const period =
    natural < slotCount && waiting[natural] > 0
      ? natural
      : pageAfterFinishing(periodsOnly, slotCount, -1, natural)
  // Over the segments alone the pager's fallback is the clock's period: not a segment.
  const next = pageAfterFinishing(segmentsOnly, slotCount, -1, natural)
  const segment = next !== null && next >= slotCount ? next : null
  return [period, segment].filter((at): at is number => at !== null && waiting[at] > 0)
}

/**
 * Whether a dashboard task group needs you: Late and On deck whenever they
 * have rows (everything in them is for now); any other group while one of its
 * rows is over target.
 */
export function taskGroupNeedsYou(
  sectionId: string | undefined,
  tasks: Pick<Task, 'due_at' | 'progress_target' | 'is_tracked'>[],
  now: Date,
): boolean {
  if (sectionId === 'late' || sectionId === 'on-deck') return tasks.length > 0
  return tasks.some((t) => isOverdue(t, now))
}

/** Where the cycle is: at its start, on stop `at` (by index), or reset by a scroll by hand. */
export type WalkState = { kind: 'start' } | { kind: 'at'; at: number } | { kind: 'hand' }

/**
 * ONE TAP of the cycle: where it goes (a stop's index, or the top) and the
 * state after. `stops` is how many stops need you now.
 */
export function stepWalk(state: WalkState, stops: number): { go: number | 'top'; next: WalkState } {
  if (state.kind === 'hand') return { go: 'top', next: { kind: 'start' } }
  const at = state.kind === 'at' ? state.at + 1 : 0
  if (at < stops) return { go: at, next: { kind: 'at', at } }
  return { go: 'top', next: { kind: 'start' } }
}

/** The cycle's state, for the page it belongs to (`retapWalk`). */
let walk: { path: string; state: WalkState } = { path: '', state: { kind: 'start' } }
let listening = false
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])
/** A scroll by hand — wheel, touch, a scroll key, the scrollbar — resets the cycle. */
function listenForHandScrolls() {
  if (listening) return
  listening = true
  const byHand = () => {
    if (walk.state.kind === 'at') walk = { ...walk, state: { kind: 'hand' } }
  }
  window.addEventListener('wheel', byHand, { passive: true })
  window.addEventListener('touchmove', byHand, { passive: true })
  window.addEventListener('keydown', (e) => {
    if (SCROLL_KEYS.has(e.key)) byHand()
  })
  // The page's scrollbar: a press on the root element beside the content.
  window.addEventListener('mousedown', (e) => {
    if (
      e.target === document.documentElement &&
      e.clientX >= document.documentElement.clientWidth
    ) {
      byHand()
    }
  })
}

/**
 * One tap of the cycle: scroll to the stop it goes to and say so, or say it
 * goes to the top (false) — the caller scrolls there (the dashboard also
 * resets its filters).
 */
export function retapWalk(): boolean {
  listenForHandScrolls()
  const path = window.location.pathname
  if (walk.path !== path) walk = { path, state: { kind: 'start' } }
  const stops = [...document.querySelectorAll<HTMLElement>('[data-retap-stop][data-needs-you]')]
    // Drawn: a hidden copy (the narrow layout's) is no place to go.
    .filter((el) => el.getClientRects().length > 0)
  const ordered = stops.filter((el) => el.dataset.retapOrder !== undefined)
  const list =
    ordered.length > 0
      ? ordered.sort((a, b) => Number(a.dataset.retapOrder) - Number(b.dataset.retapOrder))
      : stops
  const { go, next } = stepWalk(walk.state, list.length)
  walk = { path, state: next }
  if (go === 'top') return false
  scrollSectionIntoView(list[go])
  return true
}
