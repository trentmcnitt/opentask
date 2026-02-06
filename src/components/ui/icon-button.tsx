import * as React from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface IconButtonProps {
  icon: React.ReactNode
  label: string
  onClick?: () => void
  disabled?: boolean
  destructive?: boolean
  active?: boolean
  /** Optional badge overlay in the top-right corner (e.g., count indicator) */
  badge?: string | number
}

export function IconButton({
  icon,
  label,
  onClick,
  disabled = false,
  destructive = false,
  active = false,
  badge,
}: IconButtonProps) {
  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          'size-8',
          disabled && 'text-muted-foreground/40 cursor-not-allowed',
          destructive && 'hover:text-destructive',
          active && 'bg-accent text-accent-foreground',
        )}
        onClick={disabled ? undefined : onClick}
        aria-label={label}
        title={label}
        disabled={disabled}
      >
        {icon}
      </Button>
      {badge !== undefined && (
        <span className="pointer-events-none absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-blue-500 text-[9px] font-bold text-white">
          {badge}
        </span>
      )}
    </div>
  )
}
