'use client'

import { useState } from 'react'
import { Calendar } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import type { Task } from '@/types'

interface SnoozeSheetProps {
  task: Task
  onSnooze: (until: string) => void
  onClose: () => void
  customOnly?: boolean
}

/**
 * Round to the nearest hour per SPEC:
 * minutes < 35 round down, >= 35 round up
 */
function roundToHour(date: Date): Date {
  const result = new Date(date)
  if (result.getMinutes() >= 35) {
    result.setHours(result.getHours() + 1)
  }
  result.setMinutes(0, 0, 0)
  return result
}

export function SnoozeSheet({ task, onSnooze, onClose, customOnly = false }: SnoozeSheetProps) {
  const [showPicker, setShowPicker] = useState(customOnly)
  const [customDateTime, setCustomDateTime] = useState('')

  const getSnoozeTime = (option: string): string => {
    const now = new Date()

    switch (option) {
      case '+1h': {
        const t = roundToHour(new Date(now.getTime() + 60 * 60 * 1000))
        return t.toISOString()
      }
      case '+2h': {
        const t = roundToHour(new Date(now.getTime() + 2 * 60 * 60 * 1000))
        return t.toISOString()
      }
      case '+3h': {
        const t = roundToHour(new Date(now.getTime() + 3 * 60 * 60 * 1000))
        return t.toISOString()
      }
      case 'tomorrow9am': {
        const tomorrow = new Date(now)
        tomorrow.setDate(tomorrow.getDate() + 1)
        tomorrow.setHours(9, 0, 0, 0)
        return tomorrow.toISOString()
      }
      case '+1d': {
        const t = new Date(now.getTime() + 24 * 60 * 60 * 1000)
        t.setMinutes(0, 0, 0)
        return t.toISOString()
      }
      case '+3d': {
        const t = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)
        t.setHours(9, 0, 0, 0)
        return t.toISOString()
      }
      case '+1w': {
        const t = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
        t.setHours(9, 0, 0, 0)
        return t.toISOString()
      }
      default:
        return new Date(now.getTime() + 60 * 60 * 1000).toISOString()
    }
  }

  const options = [
    { id: '+1h', label: '+1 hour', icon: '1h' },
    { id: '+2h', label: '+2 hours', icon: '2h' },
    { id: '+3h', label: '+3 hours', icon: '3h' },
    { id: 'tomorrow9am', label: 'Tomorrow 9 AM', icon: '9AM' },
    { id: '+1d', label: '+1 day', icon: '+1d' },
    { id: '+3d', label: '+3 days', icon: '+3d' },
    { id: '+1w', label: '+1 week', icon: '+1w' },
  ]

  const handleCustomSubmit = () => {
    if (customDateTime) {
      const dt = new Date(customDateTime)
      if (!isNaN(dt.getTime())) {
        onSnooze(dt.toISOString())
      }
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" className="rounded-t-2xl" showCloseButton={true}>
        <SheetHeader>
          <SheetTitle>Snooze</SheetTitle>
        </SheetHeader>

        {/* Task preview */}
        <div className="px-4 py-3 -mx-4 bg-muted">
          <p className="text-sm text-muted-foreground truncate">
            {task.title}
          </p>
        </div>

        {/* Options */}
        {!customOnly && (
          <div className="grid grid-cols-2 gap-2 px-4">
            {options.map((option) => (
              <button
                key={option.id}
                onClick={() => onSnooze(getSnoozeTime(option.id))}
                className="flex items-center gap-3 p-3 rounded-lg border hover:bg-accent transition-colors text-left"
              >
                <span className="flex-shrink-0 w-10 h-10 rounded-full bg-muted flex items-center justify-center text-xs font-semibold text-muted-foreground">
                  {option.icon}
                </span>
                <span className="text-sm font-medium">{option.label}</span>
              </button>
            ))}

            {/* Pick date & time button */}
            <button
              onClick={() => setShowPicker(!showPicker)}
              className="flex items-center gap-3 p-3 rounded-lg border hover:bg-accent transition-colors text-left"
            >
              <span className="flex-shrink-0 w-10 h-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
                <Calendar className="size-4" />
              </span>
              <span className="text-sm font-medium">Pick date & time</span>
            </button>
          </div>
        )}

        {/* Custom datetime picker */}
        {showPicker && (
          <div className="px-4 pb-4 flex gap-2">
            <Input
              type="datetime-local"
              value={customDateTime}
              onChange={(e) => setCustomDateTime(e.target.value)}
              className="flex-1"
              autoFocus
            />
            <Button
              onClick={handleCustomSubmit}
              disabled={!customDateTime}
            >
              Set
            </Button>
          </div>
        )}

        {/* Safe area padding for mobile */}
        <div className="h-6 sm:hidden" />
      </SheetContent>
    </Sheet>
  )
}
