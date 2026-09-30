'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { formatAutoSnoozeLabel } from '@/components/AutoSnoozePicker'

const SNOOZE_PRESETS = [1, 5, 10, 15, 30, 60]

/**
 * One priority tier's auto-snooze (overdue repeat) interval: a preset select,
 * whose "Custom..." swaps in a minutes field (1-360) with Set / Cancel. The
 * custom field's draft and open state are this row's own.
 */
export function AutoSnoozeRow({
  label,
  description,
  value,
  onChange,
  labelColor,
}: {
  label: string
  description: string
  value: number
  onChange: (v: number) => void
  labelColor?: string
}) {
  const [customValue, setCustomValue] = useState('')
  const [showCustom, setShowCustom] = useState(false)

  const applyCustom = () => {
    const val = parseInt(customValue, 10)
    if (val >= 1 && val <= 360) {
      onChange(val)
      setShowCustom(false)
    }
  }

  return (
    <div className="flex items-center justify-between">
      <div>
        <div className={`text-sm ${labelColor ?? ''}`}>{label}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{description}</div>
      </div>
      {showCustom ? (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={360}
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyCustom()
              if (e.key === 'Escape') setShowCustom(false)
            }}
            className="h-8 w-20 text-sm"
            placeholder="min"
            autoFocus
          />
          <Button size="sm" variant="outline" className="h-8" onClick={applyCustom}>
            Set
          </Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => setShowCustom(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <select
          value={value}
          onChange={(e) => {
            const val = e.target.value
            if (val === 'custom') {
              setCustomValue(String(value))
              setShowCustom(true)
            } else {
              onChange(Number(val))
            }
          }}
          className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value={1}>1 min</option>
          <option value={5}>5 min</option>
          <option value={10}>10 min</option>
          <option value={15}>15 min</option>
          <option value={30}>30 min</option>
          <option value={60}>1 hour</option>
          {!SNOOZE_PRESETS.includes(value) && (
            <option value={value}>{formatAutoSnoozeLabel(value)}</option>
          )}
          <option value="custom">Custom...</option>
        </select>
      )}
    </div>
  )
}
