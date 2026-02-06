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
}

export function IconButton({
  icon,
  label,
  onClick,
  disabled = false,
  destructive = false,
  active = false,
}: IconButtonProps) {
  return (
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
  )
}
