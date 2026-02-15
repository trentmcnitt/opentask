'use client'

import { useState } from 'react'
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

const PRESET_VALUES: Set<number> = new Set(PRESET_OPTIONS.map((o) => o.value))

/** Format minutes as a compact label: 60 -> "1h", 90 -> "1h30m", others -> "Xm" */
export function formatAutoSnoozeLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  const hours = Math.floor(minutes / 60)
  const remaining = minutes % 60
  return `${hours}h${remaining}m`
}

export function AutoSnoozePicker({
  value,
  userDefault,
  onChange,
  open,
  onOpenChange,
  children,
}: AutoSnoozePickerProps) {
  const [customMode, setCustomMode] = useState(false)
  const [customInput, setCustomInput] = useState('')

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setCustomMode(false)
    onOpenChange(nextOpen)
  }

  const handleSelect = (newValue: number | null) => {
    onChange(newValue)
    handleOpenChange(false)
  }

  const submitCustom = () => {
    const val = parseInt(customInput, 10)
    if (val >= 1 && val <= 360) {
      handleSelect(val)
    }
  }

  const isNonPresetCustom = value !== null && value > 0 && !PRESET_VALUES.has(value)

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-48 p-1" align="end">
        {customMode ? (
          <div className="flex items-center gap-1.5 px-1 py-1">
            <input
              type="number"
              min={1}
              max={360}
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCustom()
                if (e.key === 'Escape') setCustomMode(false)
              }}
              className="h-7 w-16 rounded border border-zinc-300 px-1.5 text-sm dark:border-zinc-600 dark:bg-zinc-800"
              placeholder="min"
              autoFocus
            />
            <span className="text-muted-foreground text-xs">min</span>
            <button
              type="button"
              className="rounded bg-zinc-900 px-2 py-0.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
              onClick={submitCustom}
            >
              Set
            </button>
          </div>
        ) : (
          <>
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

            {/* Separator before custom */}
            <div className="bg-border my-1 h-px" />

            {/* Show current non-preset value if set */}
            {isNonPresetCustom && (
              <button
                type="button"
                className={cn(
                  'flex w-full items-center justify-between rounded px-2 py-1.5 text-sm transition-colors',
                  'bg-accent',
                )}
                onClick={() => handleSelect(value)}
              >
                <span>Custom ({formatAutoSnoozeLabel(value)})</span>
                <Check className="size-4" />
              </button>
            )}

            {/* Custom button */}
            <button
              type="button"
              className={cn(
                'flex w-full items-center justify-between rounded px-2 py-1.5 text-sm transition-colors',
                'hover:bg-accent',
              )}
              onClick={() => {
                setCustomInput(isNonPresetCustom ? String(value) : '')
                setCustomMode(true)
              }}
            >
              <span>Custom...</span>
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
