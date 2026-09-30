'use client'

import { cn } from '@/lib/utils'

/**
 * A button in QuickActionPanel's snooze grid: a preset time, a +/- increment,
 * or one of the Now / Next Hour smart buttons, colored by variant.
 */
export function GridButton({
  label,
  onClick,
  variant = 'preset',
  span = 1,
}: {
  label: string
  onClick: () => void
  variant?: 'preset' | 'increment' | 'decrement' | 'smart'
  span?: 1 | 2
}) {
  // Tiered text sizing: use smaller text for longer labels to prevent overflow.
  // Single-span buttons are narrower and need smaller text sooner.
  const textSize =
    span === 2
      ? label.length <= 20
        ? 'text-sm'
        : 'text-xs'
      : label.length <= 8
        ? 'text-sm'
        : 'text-xs'

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center justify-center rounded-lg border px-2 py-2.5 text-center leading-tight font-medium transition-colors',
        textSize,
        'min-h-[44px]', // Apple HIG touch target
        'active:scale-[0.97]',
        span === 2 && 'col-span-2',
        variant === 'preset' && 'bg-card hover:bg-accent active:bg-accent border-border',
        variant === 'increment' &&
          'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 active:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400 dark:hover:bg-emerald-950/50 dark:active:bg-emerald-950/50',
        variant === 'decrement' &&
          'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 active:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400 dark:hover:bg-amber-950/50 dark:active:bg-amber-950/50',
        variant === 'smart' &&
          'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 active:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-400 dark:hover:bg-blue-950/50 dark:active:bg-blue-950/50',
      )}
    >
      {label}
    </button>
  )
}
