import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface CountBadgeProps {
  count: number | string
  variant?: 'default' | 'overdue' | 'today' | 'done'
  tooltip?: string
  className?: string
  /**
   * Makes the pill a real `<button>` (the Tasks top bar's overdue/today pills,
   * which apply their date filter on tap). Without it the pill stays a plain
   * `<span>` — every other caller is a read-only count.
   */
  onClick?: () => void
  /** Accessible name for the button form; ignored without `onClick`. */
  ariaLabel?: string
  /** `aria-pressed` for the button form: whether its filter is the active one. */
  pressed?: boolean
}

const variantStyles = {
  default: 'bg-muted text-muted-foreground',
  overdue: 'bg-destructive/15 text-destructive',
  today: 'bg-primary/15 text-primary',
  done: 'bg-green-600/15 text-green-700 dark:text-green-400',
}

export function CountBadge({
  count,
  variant = 'default',
  tooltip,
  className,
  onClick,
  ariaLabel,
  pressed,
}: CountBadgeProps) {
  const classes = cn(
    'min-w-[1.25rem] rounded px-1.5 py-0.5 text-center text-[11px] font-medium',
    variantStyles[variant],
    onClick && 'cursor-pointer transition-opacity hover:opacity-80',
    className,
  )
  const badge = onClick ? (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={pressed}
      className={classes}
    >
      {count}
    </button>
  ) : (
    <span className={classes}>{count}</span>
  )

  if (!tooltip) return badge

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent sideOffset={6}>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
