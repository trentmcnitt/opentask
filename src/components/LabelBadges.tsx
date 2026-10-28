'use client'

import { RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { getLabelClasses } from '@/lib/label-colors'
import { cn } from '@/lib/utils'
import type { LabelConfig } from '@/types'

/**
 * A task's label chips — the dashboard row's (`TaskRow`), and since
 * 2026-10-22 the task-segment rows' too (Trent's phone review: a queue row
 * showed no labels, so "ai-added" or "house" was only visible on the
 * dashboard). EVERY label, in its registry colour (Trent, 2026-10-28: "I
 * don't want to hide tags" — it showed two, then "+N"); they wrap with the
 * meta line. `ai-to-process` is never shown (the row's shimmer says it). An `ai-failed`
 * chip gets a retry button when the row can reprocess.
 *
 * A chip is NEVER cut (Trent, 2026-10-24). The group sits in a row's
 * `flex-wrap` meta line and moves there as a whole to the next line when it
 * doesn't fit what the line has left; when the group is wider than a whole
 * line (two long labels in the dashboard's narrow panel), it wraps itself, a
 * whole chip at a time (`flex-wrap`, `max-w-full`). A single label longer than
 * the line (labels allow 100 characters) breaks inside its chip rather than
 * overflow it (`max-w-full`, `whitespace-normal`, `overflow-wrap: anywhere` —
 * at its natural width a chip still never wraps, since it fits).
 */
export function LabelBadges({
  labels,
  labelConfig,
  onLabelClick,
  onReprocess,
  className,
}: {
  labels: string[]
  labelConfig: LabelConfig[]
  onLabelClick?: (label: string) => void
  onReprocess?: () => void
  className?: string
}) {
  // Filter out ai-to-process (the animation conveys that state)
  const visibleLabels = labels.filter((l) => l !== 'ai-to-process')

  return (
    <div
      data-label-badges
      className={cn('flex max-w-full min-w-0 flex-wrap items-center gap-1', className)}
    >
      {visibleLabels.map((label) => {
        const colorClasses = getLabelClasses(label, labelConfig)
        const isAiFailed = label === 'ai-failed'
        return (
          <span
            key={label}
            className={cn(
              'inline-flex max-w-full min-w-0 items-center gap-0.5',
              isAiFailed && onReprocess && 'group/retry',
            )}
          >
            <Badge
              variant={colorClasses ? undefined : 'secondary'}
              className={cn(
                'max-w-full min-w-0 shrink px-1.5 py-0 text-xs [overflow-wrap:anywhere] whitespace-normal',
                colorClasses && `${colorClasses} border-0`,
                onLabelClick && 'cursor-pointer',
              )}
              // Only a row that acts on a label keeps the tap; elsewhere (a
              // segment row) a tap on a chip is a tap on the row.
              onClick={
                onLabelClick
                  ? (e) => {
                      e.stopPropagation()
                      onLabelClick(label)
                    }
                  : undefined
              }
            >
              {label}
            </Badge>
            {isAiFailed && onReprocess && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onReprocess()
                }}
                className="text-muted-foreground hover:text-foreground inline-flex items-center justify-center rounded p-0.5 transition-colors"
                title="Retry AI enrichment"
                aria-label="Retry AI enrichment"
              >
                <RefreshCw className="size-3" />
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}
