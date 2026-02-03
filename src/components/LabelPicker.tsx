'use client'

import { useState, useRef, useEffect } from 'react'
import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { useLabelConfig } from '@/components/LabelConfigProvider'
import { getLabelClasses } from '@/lib/label-colors'
import { cn } from '@/lib/utils'

interface LabelPickerProps {
  labels: string[]
  onChange: (labels: string[]) => void
}

export function LabelPicker({ labels, onChange }: LabelPickerProps) {
  const { labelConfig } = useLabelConfig()
  const [inputValue, setInputValue] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const addLabel = (label: string) => {
    const trimmed = label.trim()
    if (trimmed && !labels.some((l) => l.toLowerCase() === trimmed.toLowerCase())) {
      onChange([...labels, trimmed])
    }
    setInputValue('')
    setShowDropdown(false)
  }

  const removeLabel = (label: string) => {
    onChange(labels.filter((l) => l !== label))
  }

  // Filter predefined labels: exclude already selected, match input
  const suggestions = labelConfig.filter(
    (c) =>
      !labels.some((l) => l.toLowerCase() === c.name.toLowerCase()) &&
      c.name.toLowerCase().includes(inputValue.toLowerCase()),
  )

  return (
    <div ref={wrapperRef} className="relative">
      <div className="flex flex-wrap items-center gap-1">
        {labels.map((label) => {
          const colorClasses = getLabelClasses(label, labelConfig)
          return (
            <Badge
              key={label}
              variant={colorClasses ? undefined : 'secondary'}
              className={cn('gap-1', colorClasses && `${colorClasses} border-0`)}
            >
              {label}
              <button
                type="button"
                onClick={() => removeLabel(label)}
                className="hover:text-destructive"
              >
                <X className="size-3" />
              </button>
            </Badge>
          )
        })}
        <Input
          type="text"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value)
            setShowDropdown(true)
          }}
          onFocus={() => setShowDropdown(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (inputValue.trim()) addLabel(inputValue)
            }
            if (e.key === 'Backspace' && !inputValue && labels.length > 0) {
              removeLabel(labels[labels.length - 1])
            }
          }}
          className="h-7 min-w-[80px] flex-1 border-none px-1 text-xs shadow-none focus-visible:ring-0"
          placeholder={labels.length === 0 ? 'Add labels...' : ''}
        />
      </div>

      {/* Dropdown with predefined label suggestions */}
      {showDropdown && suggestions.length > 0 && (
        <div className="bg-popover text-popover-foreground absolute z-10 mt-1 w-full rounded-md border shadow-md">
          {suggestions.map((c) => {
            const colorClasses = getLabelClasses(c.name, labelConfig)
            return (
              <button
                key={c.name}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addLabel(c.name)}
              >
                <Badge
                  variant={colorClasses ? undefined : 'secondary'}
                  className={cn('text-xs', colorClasses && `${colorClasses} border-0`)}
                >
                  {c.name}
                </Badge>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
