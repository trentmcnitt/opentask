'use client'

import { cn } from '@/lib/utils'
import { formatQuickSelectHeader } from '@/lib/quick-select-dates'
import type { AutoTargetLabel } from '@/lib/editor-target-labels'
import { AUTO_TARGET_WORD } from '@/lib/task-model-words'

/**
 * The target line's value for a deadline task whose target is the deadline's
 * AUTOMATIC one (§8, 2026-10-12): "auto · Tue, Oct 20, 9:00 AM (3 days before
 * deadline)". The date is when it starts (or started) nagging, in the
 * over-target colour once it has; the lead is the whole local days to the
 * deadline ("deadline day" when set late). Blue while a staged change ("Back
 * to auto", a new deadline) is what produced it. See `describeAutoTarget`.
 */
export function AutoTargetText({
  label,
  timezone,
  dirty,
}: {
  label: AutoTargetLabel
  timezone: string
  dirty: boolean
}) {
  // Separate pieces, not one span: the target line wraps between its flex
  // items, so on a phone the lead drops to the next line on its own instead
  // of taking the date with it.
  const tone = dirty
    ? 'font-medium text-blue-500'
    : label.started
      ? 'text-over-target'
      : 'text-muted-foreground'
  return (
    <>
      <span data-quick-panel-auto-target className={cn('font-medium', tone)}>
        {AUTO_TARGET_WORD}
      </span>
      <span className={tone}>&middot;</span>
      <span className={tone}>{formatQuickSelectHeader(label.at, timezone)}</span>
      <span className={dirty ? 'text-blue-500' : 'text-muted-foreground'}>({label.lead})</span>
    </>
  )
}
