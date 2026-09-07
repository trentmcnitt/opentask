import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function taskWord(n: number) {
  return n === 1 ? 'task' : 'tasks'
}

/** Detect macOS/iOS platform (replaces deprecated navigator.platform) */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
}

/**
 * True when a double-click landed on a control inside the row rather than on
 * the row itself.
 *
 * Rows on the list surfaces open their editor on double-click, and the buttons
 * inside them stop the row's `click`. That is not enough: `dblclick` is a
 * SEPARATE event with its own trip up the tree, so stopping `click` leaves it
 * untouched and the row opens anyway. Trent, 2026-09-06, on a quota's +1:
 * "if I double-tap the +1 on Broccoli Avocado, then the modal pops up" — the
 * two clicks logged +2 (rapid-tapping a count is the point of that button) and
 * the dblclick behind them opened the editor on top.
 *
 * Guarding here rather than on each button is deliberate: the per-button rule
 * has now been forgotten twice, and a control added later inherits this one for
 * free. The `contains` check keeps a control that WRAPS the row from matching.
 */
export function fromRowControl(e: {
  target: EventTarget | null
  currentTarget: EventTarget | null
}) {
  const el = e.target as HTMLElement | null
  const control = el?.closest?.('button, a, input, textarea, select, [role="button"]')
  const row = e.currentTarget as HTMLElement | null
  return !!control && !!row && row !== control && row.contains(control)
}
