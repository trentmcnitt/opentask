/**
 * RE-TAPPING THE TAB YOU ARE ON SCROLLS ITS PAGE TO THE TOP (Trent,
 * 2026-10-29: "if you tap the tab, it should scroll you to the top the same
 * way it does when you tap on Dashboard… The same is true for quotas").
 * Every tab of the phone's tab bar and every link of the desktop sidebar
 * (`useTabRetap`), and the Dashboard tab's own reset (`dashboard-reset`).
 *
 * Smooth, except under reduced motion, where it jumps. It first announces the
 * re-tap (`PAGE_RETAP_EVENT`): a scroll the page had scheduled on its own —
 * the Reminders surface's move to the next section (`useScrollToNextSection`)
 * — is cancelled, so it can't pull the page back down after the tap.
 */
import { retapWalk } from '@/lib/retap-walk'

export const PAGE_RETAP_EVENT = 'page-retap'

/**
 * A re-tap of the tab you are on (`useTabRetap`): the next place that needs
 * you, else the top (src/lib/retap-walk.ts).
 */
export function retapPage(): void {
  window.dispatchEvent(new CustomEvent(PAGE_RETAP_EVENT))
  if (!retapWalk()) scrollPageToTop()
}

export function scrollPageToTop(): void {
  window.dispatchEvent(new CustomEvent(PAGE_RETAP_EVENT))
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
}
