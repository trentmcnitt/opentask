'use client'

/**
 * The lean row's HORIZON MARK, in one place so the glyph can be swapped in
 * one file while the horizon research runs: today the rows' own horizon dot
 * (`HorizonDotButton`, its menu changes the horizon), at the start of the
 * meta line, only on rows the horizon governs (`showsHorizonDot`: a one-off
 * with no picked target).
 */
import { HorizonDotButton } from '@/components/HorizonDot'
import { showsHorizonDot } from '@/lib/row-corner'
import type { HorizonValue } from '@/lib/task-segments'
import type { Task } from '@/types'

export function HorizonMark({
  task,
  onChange,
}: {
  task: Task
  /** Change the horizon (the dot's menu); without it, just the mark and its tooltip. */
  onChange?: (horizon: HorizonValue | null) => void
}) {
  if (!showsHorizonDot(task)) return null
  // The inline dot's touch box is 34px wide (44 tall); the negative margins
  // keep that box but give the meta line only the dot's own width, so the
  // next item sits beside it instead of a gap away. The box overlaps nothing
  // it could steal a tap from: a row with the dot has no target chip, and the
  // created date and deadline chip are not buttons.
  return (
    <HorizonDotButton task={task} variant="inline" onChange={onChange} className="-mx-[11px]" />
  )
}
