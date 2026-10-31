/**
 * A SELECTED list row (Trent's Mac, 2026-10-31): the task queue's pick blue —
 * the tint `TaskSegmentRow` gives a picked row, with a blue ring — on the
 * lean, compact and card rows alike. It was the grey `ring-ring` drawn
 * OUTSIDE the row, so the row below and the list's clipping cut its bottom
 * edge off; INSET it is drawn whole inside the row's own box.
 */
export const SELECTED_ROW =
  'rounded-lg bg-blue-500/10 ring-2 ring-blue-500 ring-inset dark:bg-blue-500/15'
