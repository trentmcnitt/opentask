/**
 * THE DASHBOARD OPENS ON THE TASKS (Trent, 2026-10-31: "when you open the app
 * fresh, it should actually jump right to the tasks… I think maybe it'll just
 * be two positions. When you open Dashboard… it will jump to the tasks, and
 * then you can jump to the top, and that's it… tasks are arguably the most
 * important thing, and it's the easiest to forget, whereas reminders get a
 * lot of attention because I have them on my iOS widget"). docs/SPEC.md §
 * Guiding Principles 6.
 *
 * On a PHONE only (`dashboardPhoneLayout`: one column, below `md`): there the
 * Reminders card, the task queue card and Quotas stack above the task list.
 * A desktop — two columns, or one in a narrow window — opens at the top and
 * its re-tap keeps the walk (src/lib/retap-walk.ts).
 *
 * - THE TASKS are the list's anchor (`data-task-list-landing`): the start of
 *   the task list under Quotas — the Late / Today headers, or the "Targets
 *   done" line / the all-clear card when those are empty — on its landing
 *   line, under the top bar (`scroll-below-header`, the safe area included).
 *   The jump-to-tasks button's own target: that position, or the page's
 *   bottom on a page too short to scroll it that far (`JumpToTasksFab`).
 * - THE FIRST VISIT SINCE LAUNCH (a cold launch, a fresh load, or the first
 *   switch to the Dashboard from another tab) lands there, before the first
 *   paint of the data — no visible jump from the top — and stays pinned there
 *   while the cards above it load and grow, until the user touches, scrolls
 *   or types. Not with a deep link (`deepLinked`), which has a place of its
 *   own to go; the Reminders widget's general tap (`?focus=reminders`) lands
 *   on the Reminders card instead (`focusedCard`). Later switches to the
 *   Dashboard never scroll (2026-10-29).
 * - A RE-TAP of the Dashboard tab (revised by Trent the same day, after using
 *   it: "pressing Dashboard to get to the tasks should only happen if you're
 *   scrolled all the way to the top… or if you tap it while you've scrolled
 *   up past the top, where it's in that elastic zone… Otherwise it does the
 *   natural behavior"): AT THE TOP → the tasks; ANYWHERE ELSE → the top,
 *   above the tasks included. At the top is `scrollY` within
 *   `AT_TOP_PX` — a negative one too, the rubber-band overscroll above the
 *   page and its rebound, so a tap while it bounces back is still "at the
 *   top", not a race.
 */
import { scrollSectionIntoView } from '@/lib/scroll-row-into-view'

const ANCHOR = '[data-task-list-landing]'

/** The dashboard's grid is one column (the Reminders, queue and Quotas cards above the list). */
export function dashboardSingleColumn(): boolean {
  const main = document.querySelector<HTMLElement>('main')
  if (!main) return false
  return getComputedStyle(main).gridTemplateColumns.trim().split(/\s+/).length === 1
}

/**
 * The PHONE layout: one column, below `md` (48rem — where the bottom tab bar
 * shows and the top bar stays put). Trent's ruling was the phone's; a narrow
 * desktop window (one column at 1280, its top bar scrolling away with the
 * page) keeps opening at the top and its re-tap keeps the walk.
 */
export function dashboardPhoneLayout(): boolean {
  return dashboardSingleColumn() && !window.matchMedia('(min-width: 48rem)').matches
}

/**
 * The scroll position of the tasks: the anchor on its landing line, or the
 * page's bottom when the page can't scroll that far. Null without an anchor.
 */
export function tasksScrollY(): number | null {
  const anchor = document.querySelector<HTMLElement>(ANCHOR)
  if (!anchor) return null
  // The anchor carries the landing line itself (`scroll-below-header`).
  const landing = parseFloat(getComputedStyle(anchor).scrollMarginTop) || 0
  const at = anchor.getBoundingClientRect().top + window.scrollY - landing
  const max = document.documentElement.scrollHeight - window.innerHeight
  return Math.max(0, Math.min(at, max))
}

/** How near the top still counts as the top: within a few pixels, or above it (overscroll). */
export const AT_TOP_PX = 8

/** The re-tap's choice: at the top (or overscrolled above it) → the tasks; anywhere else → the top. */
export function dashboardRetapGoes(scrollY: number): 'top' | 'tasks' {
  return scrollY <= AT_TOP_PX ? 'tasks' : 'top'
}

/**
 * A re-tap of the Dashboard tab in the single-column layout: scrolls to the
 * tasks and says so, or says it goes to the top (false — the caller scrolls
 * there). Null when the rule doesn't apply (two columns, no anchor).
 */
export function dashboardRetap(): boolean | null {
  if (!dashboardPhoneLayout()) return null
  if (tasksScrollY() === null) return null
  if (dashboardRetapGoes(window.scrollY) === 'top') return false
  scrollSectionIntoView(document.querySelector<HTMLElement>(ANCHOR))
  return true
}

/** Landed once this launch: later visits to the Dashboard keep their place. */
let landed = false

/**
 * A deep link has its own place to go: a task (`?task=`), the Tasks card's
 * page (`?tasks=`), a filter or a project (`?filter=`, `?project=`, both
 * scroll to their rows or the top) or the quick add (`?action=`, the add box
 * at the top). Read before their own effects consume them: this runs in a
 * layout effect, theirs in effects after it.
 */
const DEEP_LINKS = ['task', 'tasks', 'filter', 'project', 'action'] as const
/**
 * The URL the app launched with. On a fresh load the dashboard shows a
 * loading screen first, and some links' effects (`?project=`) consume their
 * param during it — before the landing's layout effect can see it — so the
 * launch's own URL is asked too. (A client visit has no loading screen: the
 * landing runs first and sees the current URL.)
 */
const launch =
  typeof window === 'undefined'
    ? null
    : { path: window.location.pathname, search: window.location.search }
function deepLinked(): boolean {
  const has = (search: string) => {
    const params = new URLSearchParams(search)
    return DEEP_LINKS.some((key) => params.has(key))
  }
  return has(window.location.search) || (launch?.path === '/' && has(launch.search))
}

/**
 * THE WIDGET'S GENERAL TAP (Trent, 2026-10-31: "when you tap the widget it
 * opens to reminders panel (so just slightly scrolled down from the top) on
 * the dashboard page instead of the reminders tab"): the Reminders widget's
 * background, 2×2 and Lock Screen taps load `/?focus=reminders`
 * (`DeepLinkRouter.remindersCardPath`), and the first visit lands on the
 * Reminders card instead of the tasks — whatever page the widget showed (the
 * task queue's too: always the Reminders card, the simplest). Item taps keep
 * the Reminders tab. On a phone; a desktop shows the card at the top as it is.
 */
const FOCUS_PARAM = 'focus'
function focusedCard(): 'reminders' | null {
  const ask = (search: string) => new URLSearchParams(search).get(FOCUS_PARAM)
  const asked = ask(window.location.search) ?? (launch?.path === '/' ? ask(launch.search) : null)
  return asked === 'reminders' ? 'reminders' : null
}

/** The drawn Reminders card's scroll position on its landing line (`scroll-below-header`). */
function remindersScrollY(): number | null {
  const card = [...document.querySelectorAll<HTMLElement>('[data-reminders-panel]')].find(
    (el) => el.getClientRects().length > 0,
  )
  if (!card) return null
  const landing = parseFloat(getComputedStyle(card).scrollMarginTop) || 0
  const at = card.getBoundingClientRect().top + window.scrollY - landing
  const max = document.documentElement.scrollHeight - window.innerHeight
  return Math.max(0, Math.min(at, max))
}

/**
 * THE FIRST VISIT'S LANDING (see the header): called from a layout effect on
 * the dashboard's first render with data, so the jump happens before that
 * render is painted — on the tasks, or with `?focus=reminders` (the widget's
 * general tap) on the Reminders card; nowhere with another deep link. Then
 * PINNED: as the cards load and the page grows (a `ResizeObserver` on
 * <html>), the target is put back on its line — until the first touch,
 * wheel, press or key (a tab re-tap is a press too), or any scroll that isn't
 * the pin's own (the app's jumps, a scrollbar drag), after which the page is
 * the user's. Returns the unpin, for the effect's cleanup.
 */
export function landOnce(): () => void {
  if (landed) return () => {}
  landed = true
  const focus = focusedCard()
  if (focus && new URLSearchParams(window.location.search).has(FOCUS_PARAM)) {
    const params = new URLSearchParams(window.location.search)
    params.delete(FOCUS_PARAM)
    const rest = params.toString()
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + (rest ? `?${rest}` : ''),
    )
  }
  if (!dashboardPhoneLayout()) return () => {}
  if (focus === 'reminders') return pinTo(remindersScrollY)
  if (deepLinked()) return () => {}
  return pinTo(tasksScrollY)
}

/** Put the page at `target()` and keep it there until the page is the user's (see `landOnce`). */
function pinTo(target: () => number | null): () => void {
  // Where the pin last put the page: a scroll anywhere else is not the
  // pin's — a jump of the app's own (a filter's, a link's) or the user's —
  // and ends the pin.
  let placed = window.scrollY
  const place = () => {
    const at = target()
    if (at !== null && Math.abs(window.scrollY - at) > 0.5) {
      placed = at
      window.scrollTo({ top: at, behavior: 'instant' })
    }
  }
  const onScroll = () => {
    if (Math.abs(window.scrollY - placed) > 1) unpin()
  }
  place()
  const ro = new ResizeObserver(place)
  ro.observe(document.documentElement)
  const unpin = () => {
    ro.disconnect()
    for (const type of USER_INPUT) window.removeEventListener(type, unpin)
    window.removeEventListener('scroll', onScroll)
  }
  for (const type of USER_INPUT) window.addEventListener(type, unpin, { passive: true })
  window.addEventListener('scroll', onScroll, { passive: true })
  return unpin
}

/** What hands the page to the user: any touch, wheel, press or key. */
const USER_INPUT = ['pointerdown', 'touchstart', 'wheel', 'keydown'] as const

/** Tests: start a fresh "launch". */
export function resetLandingForTests(): void {
  landed = false
}
