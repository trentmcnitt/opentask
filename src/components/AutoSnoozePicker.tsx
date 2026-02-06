'use client'

import { Check } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

interface AutoSnoozePickerProps {
  value: number | null // current value (null = default, 0 = off, positive = custom)
  userDefault: number // for "Default (30m)" display
  onChange: (value: number | null) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

const PRESET_OPTIONS = [
  { value: 1, label: '1 min' },
  { value: 5, label: '5 min' },
  { value: 10, label: '10 min' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
] as const

/** Format minutes as a compact label: 60 -> "1h", others -> "Xm" */
export function formatAutoSnoozeLabel(minutes: number): string {
  if (minutes >= 60) return `${minutes / 60}h`
  return `${minutes}m`
}

export function AutoSnoozePicker({
  value,
  userDefault,
  onChange,
  open,
  onOpenChange,
  children,
}: AutoSnoozePickerProps) {
  const handleSelect = (newValue: number | null) => {
    onChange(newValue)
    onOpenChange(false)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-44 p-1" align="end">
        {/* Default option */}
        <button
          type="button"
          className={cn(
            'flex w-full items-center justify-between rounded px-2 py-1.5 text-sm transition-colors',
            'hover:bg-accent',
            value === null && 'bg-accent',
          )}
          onClick={() => handleSelect(null)}
        >
          <span>Default ({formatAutoSnoozeLabel(userDefault)})</span>
          {value === null && <Check className="size-4" />}
        </button>

        {/* Off option */}
        <button
          type="button"
          className={cn(
            'flex w-full items-center justify-between rounded px-2 py-1.5 text-sm transition-colors',
            'hover:bg-accent',
            value === 0 && 'bg-accent',
          )}
          onClick={() => handleSelect(0)}
        >
          <span>Off</span>
          {value === 0 && <Check className="size-4" />}
        </button>

        {/* Separator */}
        <div className="bg-border my-1 h-px" />

        {/* Preset options */}
        {PRESET_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={cn(
              'flex w-full items-center justify-between rounded px-2 py-1.5 text-sm transition-colors',
              'hover:bg-accent',
              value === opt.value && 'bg-accent',
            )}
            onClick={() => handleSelect(opt.value)}
          >
            <span>{opt.label}</span>
            {value === opt.value && <Check className="size-4" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
