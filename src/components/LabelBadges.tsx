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
 * dashboard). The first two labels in their registry colours, then "+N".
 * `ai-to-process` is never shown (the row's shimmer says it). An `ai-failed`
 * chip gets a retry button when the row can reprocess.
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
    <div data-label-badges className={cn('flex flex-shrink-0 items-center gap-1', className)}>
      {visibleLabels.slice(0, 2).map((label) => {
        const colorClasses = getLabelClasses(label, labelConfig)
        const isAiFailed = label === 'ai-failed'
        return (
          <span
            key={label}
            className={cn(
              'inline-flex items-center gap-0.5',
              isAiFailed && onReprocess && 'group/retry',
            )}
          >
            <Badge
              variant={colorClasses ? undefined : 'secondary'}
              className={cn(
                'px-1.5 py-0 text-xs',
                colorClasses && `${colorClasses} border-0`,
                onLabelClick && 'cursor-pointer',
              )}
              onClick={(e) => {
                e.stopPropagation()
                onLabelClick?.(label)
              }}
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
      {visibleLabels.length > 2 && (
        <span className="text-muted-foreground text-xs">+{visibleLabels.length - 2}</span>
      )}
    </div>
  )
}
