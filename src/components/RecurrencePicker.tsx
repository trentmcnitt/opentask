'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
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
export type RecurrenceMode = 'from_due' | 'from_completion'

const DAYS_OF_WEEK = [
  { id: 'MO', label: 'M', full: 'Monday' },
  { id: 'TU', label: 'T', full: 'Tuesday' },
  { id: 'WE', label: 'W', full: 'Wednesday' },
  { id: 'TH', label: 'T', full: 'Thursday' },
  { id: 'FR', label: 'F', full: 'Friday' },
  { id: 'SA', label: 'S', full: 'Saturday' },
  { id: 'SU', label: 'S', full: 'Sunday' },
]

// Generate hour options (1-12)
const HOUR_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1)
// Generate minute options (00, 15, 30, 45)
const MINUTE_OPTIONS = [0, 15, 30, 45]

function formatTime12Hour(hour: number, minute: number): string {
  const period = hour >= 12 ? 'PM' : 'AM'
  const h = hour % 12 || 12
  const m = minute.toString().padStart(2, '0')
  return `${h}:${m} ${period}`
}

function useRRuleBuilder(
  frequency: Frequency,
  interval: number,
  selectedDays: string[],
  monthDay: number | 'last',
  endType: EndType,
  endCount: number,
  endDate: string,
  hour: number,
  minute: number,
) {
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

    // Include time in RRULE
    parts.push(`BYHOUR=${hour}`)
    parts.push(`BYMINUTE=${minute}`)

    if (endType === 'count' && endCount > 0) {
      parts.push(`COUNT=${endCount}`)
    } else if (endType === 'date' && endDate) {
      parts.push(`UNTIL=${endDate.replace(/-/g, '')}T235959Z`)
    }

    return parts.join(';')
  }, [frequency, interval, selectedDays, monthDay, endType, endCount, endDate, hour, minute])

  const previewText = useMemo(() => {
    if (frequency === 'NONE') return 'No repeat'

    let base = ''

    switch (frequency) {
      case 'DAILY':
        base = interval === 1 ? 'Every day' : `Every ${interval} days`
        break
      case 'WEEKLY':
        base = interval === 1 ? 'Every week' : `Every ${interval} weeks`
        if (selectedDays.length > 0) {
          // Check for weekdays (Mon-Fri) and weekends (Sat-Sun) shortcuts
          const weekdays = ['MO', 'TU', 'WE', 'TH', 'FR']
          const weekend = ['SA', 'SU']
          const isWeekdays =
            selectedDays.length === 5 &&
            weekdays.every((d) => selectedDays.includes(d)) &&
            !selectedDays.includes('SA') &&
            !selectedDays.includes('SU')
          const isWeekends =
            selectedDays.length === 2 && weekend.every((d) => selectedDays.includes(d))

          if (isWeekdays) {
            base = 'Weekdays'
          } else if (isWeekends) {
            base = 'Weekends'
          } else {
            const dayNames = selectedDays.map(
              (d) => DAYS_OF_WEEK.find((day) => day.id === d)?.full || d,
            )
            base += ` on ${dayNames.join(', ')}`
          }
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

    // Add time to preview
    base += ` at ${formatTime12Hour(hour, minute)}`

    if (endType === 'count') {
      base += `, ${endCount} times`
    } else if (endType === 'date' && endDate) {
      base += `, until ${new Date(endDate).toLocaleDateString()}`
    }

    return base
  }, [frequency, interval, selectedDays, monthDay, endType, endCount, endDate, hour, minute])

  return { rrule, previewText }
}

function EndConditionPicker({
  endType,
  setEndType,
  endCount,
  setEndCount,
  endDate,
  setEndDate,
}: {
  endType: EndType
  setEndType: (v: EndType) => void
  endCount: number
  setEndCount: (v: number) => void
  endDate: string
  setEndDate: (v: string) => void
}) {
  return (
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
  )
}

function TimePicker({
  hour,
  minute,
  onHourChange,
  onMinuteChange,
}: {
  hour: number
  minute: number
  onHourChange: (h: number) => void
  onMinuteChange: (m: number) => void
}) {
  // Convert 24h hour to 12h display
  const displayHour = hour % 12 || 12
  const isPM = hour >= 12

  const handleHourChange = (newDisplayHour: number) => {
    // Convert 12h back to 24h
    let h24 = newDisplayHour
    if (isPM && h24 !== 12) {
      h24 += 12
    } else if (!isPM && h24 === 12) {
      h24 = 0
    }
    onHourChange(h24)
  }

  const handlePeriodChange = (newPeriod: 'AM' | 'PM') => {
    const wasAM = hour < 12
    const wantsPM = newPeriod === 'PM'
    if (wasAM && wantsPM) {
      onHourChange(hour === 0 ? 12 : hour + 12)
    } else if (!wasAM && !wantsPM) {
      onHourChange(hour === 12 ? 0 : hour - 12)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-sm">At</span>
      <Select value={displayHour.toString()} onValueChange={(v) => handleHourChange(parseInt(v))}>
        <SelectTrigger className="w-[72px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {HOUR_OPTIONS.map((h) => (
            <SelectItem key={h} value={h.toString()}>
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-muted-foreground">:</span>
      <Select value={minute.toString()} onValueChange={(v) => onMinuteChange(parseInt(v))}>
        <SelectTrigger className="w-[72px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MINUTE_OPTIONS.map((m) => (
            <SelectItem key={m} value={m.toString()}>
              {m.toString().padStart(2, '0')}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={isPM ? 'PM' : 'AM'}
        onValueChange={(v) => handlePeriodChange(v as 'AM' | 'PM')}
      >
        <SelectTrigger className="w-[72px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="AM">AM</SelectItem>
          <SelectItem value="PM">PM</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

function RecurrenceModePicker({
  mode,
  onChange,
}: {
  mode: RecurrenceMode
  onChange: (mode: RecurrenceMode) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-sm">Schedule from</span>
      <Select value={mode} onValueChange={(v) => onChange(v as RecurrenceMode)}>
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="from_due">Due date</SelectItem>
          <SelectItem value="from_completion">Completion</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

export interface RecurrencePickerProps {
  value?: string | null
  /** Recurrence mode: 'from_due' (fixed schedule) or 'from_completion' (flexible) */
  recurrenceMode?: RecurrenceMode
  /** Initial time in HH:MM format for defaulting the time picker */
  initialTime?: string | null
  /** RRULE day abbreviation (e.g., 'WE') to auto-select when switching to Weekly with no days */
  defaultDayOfWeek?: string
  onChange: (rrule: string | null, recurrenceMode?: RecurrenceMode) => void
}

export function RecurrencePicker({
  value,
  recurrenceMode: initialRecurrenceMode = 'from_due',
  initialTime,
  defaultDayOfWeek,
  onChange,
}: RecurrencePickerProps) {
  const initial = useMemo(() => parseInitialState(value, initialTime), [value, initialTime])
  const [frequency, setFrequency] = useState<Frequency>(initial.frequency)
  const [interval, setInterval] = useState(initial.interval)
  const [selectedDays, setSelectedDays] = useState<string[]>(initial.selectedDays)
  const [monthDay, setMonthDay] = useState<number | 'last'>(initial.monthDay)
  const [endType, setEndType] = useState<EndType>(initial.endType)
  const [endCount, setEndCount] = useState(initial.endCount)
  const [endDate, setEndDate] = useState(initial.endDate)
  const [hour, setHour] = useState(initial.hour)
  const [minute, setMinute] = useState(initial.minute)
  const [recurrenceMode, setRecurrenceMode] = useState<RecurrenceMode>(initialRecurrenceMode)

  const [prevValue, setPrevValue] = useState(value)
  const [prevInitialTime, setPrevInitialTime] = useState(initialTime)
  if (value !== prevValue || initialTime !== prevInitialTime) {
    setPrevValue(value)
    setPrevInitialTime(initialTime)
    const parsed = parseInitialState(value, initialTime)
    setFrequency(parsed.frequency)
    setInterval(parsed.interval)
    setSelectedDays(parsed.selectedDays)
    setMonthDay(parsed.monthDay)
    setEndType(parsed.endType)
    setEndCount(parsed.endCount)
    setEndDate(parsed.endDate)
    setHour(parsed.hour)
    setMinute(parsed.minute)
  }

  const { rrule, previewText } = useRRuleBuilder(
    frequency,
    interval,
    selectedDays,
    monthDay,
    endType,
    endCount,
    endDate,
    hour,
    minute,
  )

  // Store onChange in a ref so the effect only fires when rrule/recurrenceMode actually
  // change — not when the parent re-renders and passes a new closure reference.
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  // Skip the initial onChange call on mount — the reconstructed rrule represents the
  // same value the parent already has. Without this guard, opening the recurrence panel
  // immediately marks the form dirty even though the user hasn't changed anything.
  const hasMounted = useRef(false)
  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true
      return
    }
    onChangeRef.current(rrule, recurrenceMode)
  }, [rrule, recurrenceMode])

  const toggleDay = (day: string) => {
    setSelectedDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]))
  }

  // Auto-select the task's due date day when switching to Weekly with no days selected
  const handleFrequencyChange = (newFreq: Frequency) => {
    setFrequency(newFreq)
    if (newFreq === 'WEEKLY' && selectedDays.length === 0 && defaultDayOfWeek) {
      setSelectedDays([defaultDayOfWeek])
    }
  }

  // When switching from from_completion back to from_due, auto-populate day if empty
  const handleRecurrenceModeChange = (newMode: RecurrenceMode) => {
    setRecurrenceMode(newMode)
    if (
      newMode === 'from_due' &&
      frequency === 'WEEKLY' &&
      selectedDays.length === 0 &&
      defaultDayOfWeek
    ) {
      setSelectedDays([defaultDayOfWeek])
    }
  }

  return (
    <div className="space-y-4 overflow-hidden">
      <div className="flex flex-wrap items-center gap-4">
        <Select value={frequency} onValueChange={handleFrequencyChange}>
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

      {/* Day-of-week buttons: hidden in from_completion mode since the server schedules
          N weeks from the completion date, ignoring BYDAY. Selected days are preserved in
          state so they reappear if the user switches back to from_due. */}
      {frequency === 'WEEKLY' && recurrenceMode !== 'from_completion' && (
        <div className="flex flex-wrap gap-1">
          {DAYS_OF_WEEK.map((day) => (
            <Button
              key={day.id}
              type="button"
              variant={selectedDays.includes(day.id) ? 'default' : 'outline'}
              size="icon"
              onClick={() => toggleDay(day.id)}
              className="h-8 w-8 text-xs"
              title={day.full}
            >
              {day.label}
            </Button>
          ))}
          {selectedDays.length === 0 && (
            <p className="text-destructive w-full text-xs">Select at least one day</p>
          )}
        </div>
      )}

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

      {/* Time picker - shown when a frequency is selected */}
      {frequency !== 'NONE' && (
        <TimePicker hour={hour} minute={minute} onHourChange={setHour} onMinuteChange={setMinute} />
      )}

      {/* Recurrence mode selector */}
      {frequency !== 'NONE' && (
        <RecurrenceModePicker mode={recurrenceMode} onChange={handleRecurrenceModeChange} />
      )}

      {frequency !== 'NONE' && (
        <EndConditionPicker
          endType={endType}
          setEndType={setEndType}
          endCount={endCount}
          setEndCount={setEndCount}
          endDate={endDate}
          setEndDate={setEndDate}
        />
      )}

      <div className="text-muted-foreground bg-muted rounded p-2 text-sm">
        {previewText}
        {frequency !== 'NONE' && (
          <span className="mt-1 block text-xs opacity-75">
            {recurrenceMode === 'from_completion'
              ? 'Next occurrence schedules from when you complete this task'
              : 'Next occurrence schedules from the due date (fixed schedule)'}
          </span>
        )}
      </div>
    </div>
  )
}

function parseInitialState(value: string | null | undefined, initialTime?: string | null) {
  // Default time: 9:00 AM, or parse from initialTime if provided
  let defaultHour = 9
  let defaultMinute = 0

  if (initialTime) {
    const [h, m] = initialTime.split(':').map(Number)
    if (!isNaN(h) && !isNaN(m)) {
      defaultHour = h
      defaultMinute = m
    }
  }

  const defaults = {
    frequency: 'NONE' as Frequency,
    interval: 1,
    selectedDays: [] as string[],
    monthDay: 1 as number | 'last',
    endType: 'never' as EndType,
    endCount: 10,
    endDate: '',
    hour: defaultHour,
    minute: defaultMinute,
  }

  if (!value) return defaults

  const parts = parseRRule(value)

  // Parse time from RRULE if present, otherwise use defaults
  let hour = defaults.hour
  let minute = defaults.minute
  if (parts.BYHOUR) {
    hour = parseInt(parts.BYHOUR)
  }
  if (parts.BYMINUTE) {
    minute = parseInt(parts.BYMINUTE)
  }

  return {
    frequency: (parts.FREQ as Frequency) || defaults.frequency,
    interval: parts.INTERVAL ? parseInt(parts.INTERVAL) : defaults.interval,
    selectedDays: parts.BYDAY ? parts.BYDAY.split(',') : defaults.selectedDays,
    monthDay: parts.BYMONTHDAY
      ? parseInt(parts.BYMONTHDAY) === -1
        ? 'last'
        : parseInt(parts.BYMONTHDAY)
      : defaults.monthDay,
    endType: parts.COUNT ? 'count' : parts.UNTIL ? 'date' : defaults.endType,
    endCount: parts.COUNT ? parseInt(parts.COUNT) : defaults.endCount,
    endDate: parts.UNTIL
      ? `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`
      : defaults.endDate,
    hour,
    minute,
  }
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
