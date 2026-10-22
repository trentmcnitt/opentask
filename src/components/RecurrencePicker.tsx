'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import {
  DAYS_OF_WEEK,
  buildRule,
  defaultRuleDraft,
  describeRuleDraft,
  monthWeekdayLabel,
  parseRule,
  parseRuleTime,
  type MonthlyWeekday,
  type RuleDraft,
  type RuleEndType,
  type RuleFrequency,
} from '@/lib/rrule-draft'
import { TARGET_WORD } from '@/lib/task-model-words'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/** The picker's own "None" choice wraps the shared `RuleDraft` (src/lib/rrule-draft.ts). */
type Frequency = 'NONE' | RuleFrequency
type EndType = RuleEndType
export type RecurrenceMode = 'from_due' | 'from_completion'

// Generate hour options (1-12)
const HOUR_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1)
// Generate minute options (0-59), with common presets bolded
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => i)
const PRESET_MINUTES = new Set([0, 15, 30, 45])

// A monthly rule on a weekday of the month ("the 1st Saturday": BYDAY=1SA, or
// BYDAY=FR;BYSETPOS=-1) is carried through untouched until a day of the month
// is picked (`MonthlyWeekday`, src/lib/rrule-draft.ts).

/**
 * The monthly "On day" select: 1–31, Last day, and — only while the rule is
 * on a weekday of the month (`MonthlyWeekday`) — that rule's own choice
 * ("1st Sat"), shown selected. Picking a day of the month replaces it.
 */
function MonthDaySelect({
  monthDay,
  monthWeekday,
  onMonthDay,
}: {
  monthDay: number | 'last'
  monthWeekday: MonthlyWeekday | null
  onMonthDay: (day: number | 'last') => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-sm">On day</span>
      <Select
        value={monthWeekday ? 'weekday' : monthDay.toString()}
        onValueChange={(v) => {
          if (v !== 'weekday') onMonthDay(v === 'last' ? 'last' : parseInt(v))
        }}
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
          {monthWeekday && (
            <SelectItem value="weekday">{monthWeekdayLabel(monthWeekday, false)}</SelectItem>
          )}
        </SelectContent>
      </Select>
    </div>
  )
}

/** The picker's state as the shared draft (null while "None" is chosen). */
function toDraft(frequency: Frequency, fields: Omit<RuleDraft, 'freq'>): RuleDraft | null {
  return frequency === 'NONE' ? null : { freq: frequency, ...fields }
}

function useRRuleBuilder(draft: RuleDraft | null, hour: number, minute: number) {
  const rrule = useMemo(
    () => (draft ? buildRule(draft, { hour, minute }) : null),
    [draft, hour, minute],
  )
  const previewText = useMemo(
    () => (draft ? describeRuleDraft(draft, { hour, minute }) : 'No repeat'),
    [draft, hour, minute],
  )
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
  label,
}: {
  label: string
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
      {/* The rule's time of day IS each occurrence's target (2026-10-12) — or,
          on a deadline-anchored repeat (2026-10-21), its DEADLINE, the target
          derived from it (`occurrenceDates`): the caller says which (`timeLabel`). */}
      <span data-recurrence-time-label className="text-muted-foreground text-sm whitespace-nowrap">
        {label}
      </span>
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
              <span className={PRESET_MINUTES.has(m) ? 'font-semibold' : ''}>
                {m.toString().padStart(2, '0')}
              </span>
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
          {/* UI word only: the code mode stays `from_due` (2026-10-12, Trent). */}
          <SelectItem value="from_due">{TARGET_WORD}</SelectItem>
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
  /**
   * Initial time in HH:MM format for defaulting the time picker. Callers pass
   * the task's anchor_time, else the user's Morning time; 9:00 is only the
   * last resort when neither is known.
   */
  initialTime?: string | null
  /** RRULE day abbreviation (e.g., 'WE') to auto-select when switching to Weekly with no days */
  defaultDayOfWeek?: string
  /**
   * What the rule's time IS (2026-10-21): the target (default) — or, on a
   * deadline-anchored repeat, the deadline (`DEADLINE_WORD`).
   */
  timeLabel: string
  onChange: (rrule: string | null, recurrenceMode?: RecurrenceMode) => void
}

export function RecurrencePicker({
  value,
  recurrenceMode: initialRecurrenceMode = 'from_due',
  initialTime,
  defaultDayOfWeek,
  timeLabel,
  onChange,
}: RecurrencePickerProps) {
  const initial = useMemo(() => parseInitialState(value, initialTime), [value, initialTime])
  const [frequency, setFrequency] = useState<Frequency>(initial.frequency)
  const [interval, setInterval] = useState(initial.interval)
  const [selectedDays, setSelectedDays] = useState<string[]>(initial.selectedDays)
  const [monthDay, setMonthDay] = useState<number | 'last'>(initial.monthDay)
  const [monthWeekday, setMonthWeekday] = useState<MonthlyWeekday | null>(initial.monthWeekday)
  const [yearDate, setYearDate] = useState<string | null>(initial.yearDate)
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
    setMonthWeekday(parsed.monthWeekday)
    setYearDate(parsed.yearDate)
    setEndType(parsed.endType)
    setEndCount(parsed.endCount)
    setEndDate(parsed.endDate)
    setHour(parsed.hour)
    setMinute(parsed.minute)
  }

  const draft = useMemo(
    () =>
      toDraft(frequency, {
        interval,
        days: selectedDays,
        monthDay,
        monthWeekday,
        yearDate,
        endType,
        endCount,
        endDate,
      }),
    [
      frequency,
      interval,
      selectedDays,
      monthDay,
      monthWeekday,
      yearDate,
      endType,
      endCount,
      endDate,
    ],
  )
  const { rrule, previewText } = useRRuleBuilder(draft, hour, minute)

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
        <MonthDaySelect
          monthDay={monthDay}
          monthWeekday={monthWeekday}
          onMonthDay={(day) => {
            setMonthWeekday(null)
            setMonthDay(day)
          }}
        />
      )}

      {/* Time picker - shown when a frequency is selected */}
      {frequency !== 'NONE' && (
        <TimePicker
          label={timeLabel}
          hour={hour}
          minute={minute}
          onHourChange={setHour}
          onMinuteChange={setMinute}
        />
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
              : 'Next occurrence schedules from the target (fixed schedule)'}
          </span>
        )}
      </div>
    </div>
  )
}

/** The picker's starting state: the shared parse (`parseRule`), "None" for no rule. */
function parseInitialState(value: string | null | undefined, initialTime?: string | null) {
  const { hour, minute } = parseRuleTime(value, initialTime)
  const draft = parseRule(value)
  const { freq, ...fields } = draft ?? defaultRuleDraft()
  return {
    frequency: (draft ? freq : 'NONE') as Frequency,
    interval: fields.interval,
    selectedDays: fields.days,
    monthDay: fields.monthDay,
    monthWeekday: fields.monthWeekday,
    yearDate: fields.yearDate,
    endType: fields.endType,
    endCount: fields.endCount,
    endDate: fields.endDate,
    hour,
    minute,
  }
}
