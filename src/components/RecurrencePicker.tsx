'use client'

import { useState, useEffect, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type Frequency = 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
type EndType = 'never' | 'count' | 'date'

const DAYS_OF_WEEK = [
  { id: 'MO', label: 'M', full: 'Monday' },
  { id: 'TU', label: 'T', full: 'Tuesday' },
  { id: 'WE', label: 'W', full: 'Wednesday' },
  { id: 'TH', label: 'T', full: 'Thursday' },
  { id: 'FR', label: 'F', full: 'Friday' },
  { id: 'SA', label: 'S', full: 'Saturday' },
  { id: 'SU', label: 'S', full: 'Sunday' },
]

interface RecurrencePickerProps {
  value?: string | null
  onChange: (rrule: string | null) => void
}

export function RecurrencePicker({ value, onChange }: RecurrencePickerProps) {
  const [frequency, setFrequency] = useState<Frequency>('NONE')
  const [interval, setInterval] = useState(1)
  const [selectedDays, setSelectedDays] = useState<string[]>([])
  const [monthDay, setMonthDay] = useState<number | 'last'>(1)
  const [endType, setEndType] = useState<EndType>('never')
  const [endCount, setEndCount] = useState(10)
  const [endDate, setEndDate] = useState('')

  // Parse initial value
  useEffect(() => {
    if (!value) {
      setFrequency('NONE')
      return
    }

    const parts = parseRRule(value)
    if (parts.FREQ) {
      setFrequency(parts.FREQ as Frequency)
    }
    if (parts.INTERVAL) {
      setInterval(parseInt(parts.INTERVAL))
    }
    if (parts.BYDAY) {
      setSelectedDays(parts.BYDAY.split(','))
    }
    if (parts.BYMONTHDAY) {
      const day = parseInt(parts.BYMONTHDAY)
      setMonthDay(day === -1 ? 'last' : day)
    }
    if (parts.COUNT) {
      setEndType('count')
      setEndCount(parseInt(parts.COUNT))
    } else if (parts.UNTIL) {
      setEndType('date')
      setEndDate(parts.UNTIL.slice(0, 10))
    }
  }, [value])

  // Generate RRULE string
  const rrule = useMemo(() => {
    if (frequency === 'NONE') return null

    const parts: string[] = [`FREQ=${frequency}`]

    if (interval > 1) {
      parts.push(`INTERVAL=${interval}`)
    }

    if (frequency === 'WEEKLY' && selectedDays.length > 0) {
      parts.push(`BYDAY=${selectedDays.join(',')}`)
    }

    if (frequency === 'MONTHLY') {
      if (monthDay === 'last') {
        parts.push('BYMONTHDAY=-1')
      } else {
        parts.push(`BYMONTHDAY=${monthDay}`)
      }
    }

    if (endType === 'count' && endCount > 0) {
      parts.push(`COUNT=${endCount}`)
    } else if (endType === 'date' && endDate) {
      parts.push(`UNTIL=${endDate.replace(/-/g, '')}T235959Z`)
    }

    return parts.join(';')
  }, [frequency, interval, selectedDays, monthDay, endType, endCount, endDate])

  // Notify parent of changes
  useEffect(() => {
    onChange(rrule)
  }, [rrule, onChange])

  // Preview text
  const previewText = useMemo(() => {
    if (frequency === 'NONE') return 'No repeat'

    const intervalStr = interval > 1 ? `${interval} ` : ''
    let base = ''

    switch (frequency) {
      case 'DAILY':
        base = interval === 1 ? 'Every day' : `Every ${interval} days`
        break
      case 'WEEKLY':
        base = interval === 1 ? 'Every week' : `Every ${interval} weeks`
        if (selectedDays.length > 0) {
          const dayNames = selectedDays.map(
            (d) => DAYS_OF_WEEK.find((day) => day.id === d)?.full || d,
          )
          base += ` on ${dayNames.join(', ')}`
        }
        break
      case 'MONTHLY':
        base = interval === 1 ? 'Every month' : `Every ${interval} months`
        if (monthDay === 'last') {
          base += ' on the last day'
        } else {
          base += ` on day ${monthDay}`
        }
        break
      case 'YEARLY':
        base = interval === 1 ? 'Every year' : `Every ${interval} years`
        break
    }

    if (endType === 'count') {
      base += `, ${endCount} times`
    } else if (endType === 'date' && endDate) {
      base += `, until ${new Date(endDate).toLocaleDateString()}`
    }

    return base
  }, [frequency, interval, selectedDays, monthDay, endType, endCount, endDate])

  const toggleDay = (day: string) => {
    setSelectedDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]))
  }

  return (
    <div className="space-y-4">
      {/* Frequency */}
      <div className="flex items-center gap-4">
        <Select value={frequency} onValueChange={(v) => setFrequency(v as Frequency)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="NONE">None</SelectItem>
            <SelectItem value="DAILY">Daily</SelectItem>
            <SelectItem value="WEEKLY">Weekly</SelectItem>
            <SelectItem value="MONTHLY">Monthly</SelectItem>
            <SelectItem value="YEARLY">Yearly</SelectItem>
          </SelectContent>
        </Select>

        {frequency !== 'NONE' && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-sm">Every</span>
            <Input
              type="number"
              min={1}
              max={99}
              value={interval}
              onChange={(e) => setInterval(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-16"
            />
            <span className="text-muted-foreground text-sm">
              {frequency === 'DAILY' && (interval === 1 ? 'day' : 'days')}
              {frequency === 'WEEKLY' && (interval === 1 ? 'week' : 'weeks')}
              {frequency === 'MONTHLY' && (interval === 1 ? 'month' : 'months')}
              {frequency === 'YEARLY' && (interval === 1 ? 'year' : 'years')}
            </span>
          </div>
        )}
      </div>

      {/* Day of week picker (for weekly) */}
      {frequency === 'WEEKLY' && (
        <div className="flex gap-1">
          {DAYS_OF_WEEK.map((day) => (
            <Button
              key={day.id}
              type="button"
              variant={selectedDays.includes(day.id) ? 'default' : 'outline'}
              size="icon"
              onClick={() => toggleDay(day.id)}
              className="h-9 w-9"
              title={day.full}
            >
              {day.label}
            </Button>
          ))}
        </div>
      )}

      {/* Day of month picker (for monthly) */}
      {frequency === 'MONTHLY' && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">On day</span>
          <Select
            value={monthDay.toString()}
            onValueChange={(v) => setMonthDay(v === 'last' ? 'last' : parseInt(v))}
          >
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                <SelectItem key={day} value={day.toString()}>
                  {day}
                </SelectItem>
              ))}
              <SelectItem value="last">Last day</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* End condition */}
      {frequency !== 'NONE' && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">Ends</span>
          <Select value={endType} onValueChange={(v) => setEndType(v as EndType)}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="never">Never</SelectItem>
              <SelectItem value="count">After</SelectItem>
              <SelectItem value="date">On date</SelectItem>
            </SelectContent>
          </Select>

          {endType === 'count' && (
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={999}
                value={endCount}
                onChange={(e) => setEndCount(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-16"
              />
              <span className="text-muted-foreground text-sm">occurrences</span>
            </div>
          )}

          {endType === 'date' && (
            <Input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-40"
            />
          )}
        </div>
      )}

      {/* Preview */}
      <div className="text-muted-foreground bg-muted rounded p-2 text-sm">{previewText}</div>
    </div>
  )
}

function parseRRule(rrule: string): Record<string, string> {
  const parts: Record<string, string> = {}
  const cleaned = rrule.replace(/^RRULE:/i, '')
  for (const part of cleaned.split(';')) {
    const [key, value] = part.split('=')
    if (key && value) {
      parts[key.toUpperCase()] = value
    }
  }
  return parts
}
