/**
 * What a tap on the lean row's CLOCK does (Trent, 2026-10-28) — the one rule
 * `LeanButtons` draws and the evals check:
 *
 *   target-today  untargeted (a plain one-off with no picked target): target it today
 *   defer         its target is due: defer it by the default (`useDeferPress`)
 *   menu          its target is not yet due: open the time menu, move nothing
 *
 * A hold (or a right-click) always opens the time menu: the Target menu on
 * an untargeted row, the Defer menu on a targeted one.
 */
import { offersTargetToday, type CornerTask } from '@/lib/row-corner'

export type ClockTap = 'target-today' | 'defer' | 'menu'

export function clockTap(task: CornerTask, isOverdue: boolean): ClockTap {
  if (offersTargetToday(task)) return 'target-today'
  return isOverdue ? 'defer' : 'menu'
}
