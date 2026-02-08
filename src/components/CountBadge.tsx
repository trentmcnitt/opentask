import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface CountBadgeProps {
  count: number
  variant?: 'default' | 'overdue' | 'today'
  tooltip?: string
  className?: string
}

const variantStyles = {
  default: 'bg-muted text-muted-foreground',
  overdue: 'bg-destructive/15 text-destructive',
  today: 'bg-primary/15 text-primary',
}

export function CountBadge({ count, variant = 'default', tooltip, className }: CountBadgeProps) {
  const badge = (
    <span
      className={cn(
        'min-w-[1.25rem] rounded px-1.5 py-0.5 text-center text-[11px] font-medium',
        variantStyles[variant],
        className,
      )}
    >
      {count}
    </span>
  )

  if (!tooltip) return badge

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent sideOffset={6}>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
