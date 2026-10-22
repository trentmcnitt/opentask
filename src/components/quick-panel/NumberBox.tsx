'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'

/**
 * A small whole-number box for every-time mode ("every [2] weeks", "After [6]
 * times", an exact time's hour and minute). It never fights the typing: the
 * text is the box's own while focused, so it can be emptied to type "12" —
 * a value in range is passed on as it is typed, and the box is clamped to
 * `min`..`max` only on blur (2026-10-22 review: clamping on every keystroke
 * turned an emptied box into "1" before the next digit landed).
 */
export function NumberBox({
  value,
  min,
  max,
  onChange,
  label,
  disabled = false,
  dirty = false,
  pad = 0,
  className,
}: {
  value: number
  min: number
  max: number
  onChange: (n: number) => void
  label: string
  disabled?: boolean
  dirty?: boolean
  /** Zero-pad to this many digits when not being typed in (a minute: 2). */
  pad?: number
  className?: string
}) {
  const shown = String(value).padStart(pad, '0')
  const [text, setText] = useState<string | null>(null)
  return (
    <Input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      value={text ?? shown}
      disabled={disabled}
      aria-label={label}
      onFocus={() => setText(shown)}
      onChange={(e) => {
        const raw = e.target.value.replace(/\D/g, '').slice(0, 3)
        setText(raw)
        const n = parseInt(raw)
        if (!Number.isNaN(n) && n >= min && n <= max) onChange(n)
      }}
      onBlur={() => {
        const n = parseInt(text ?? '')
        const clamped = Number.isNaN(n) ? value : Math.min(max, Math.max(min, n))
        if (clamped !== value) onChange(clamped)
        setText(null)
      }}
      className={cn('h-8 px-1 text-center', dirty && 'font-medium text-blue-500', className)}
    />
  )
}
