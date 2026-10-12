'use client'

import { cn } from '@/lib/utils'
import { formatQuickSelectHeader } from '@/lib/quick-select-dates'
import type { AutoTargetLabel } from '@/lib/editor-target-labels'

/**
 * The target line's value for a deadline task with no target of its own
 * (2026-10-12): "auto · Thu, Oct 15, 9:00 AM (4 days before deadline)". The
 * date is when it starts (or started) nagging, in the over-target colour once
 * it has; the lead comes from the computed implied target, so under ruling A4
 * it reads "(deadline day)". Blue while a staged change (Remove target, a new
 * deadline) is what produced it. See `describeAutoTarget`.
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
        auto
      </span>
      <span className={tone}>&middot;</span>
      <span className={tone}>{formatQuickSelectHeader(label.at, timezone)}</span>
      <span className={dirty ? 'text-blue-500' : 'text-muted-foreground'}>({label.lead})</span>
    </>
  )
}
