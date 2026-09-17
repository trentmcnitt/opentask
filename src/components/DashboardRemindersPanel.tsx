'use client'

import { useEffect, useState } from 'react'
import { CheckCheck, ChevronLeft, ChevronRight } from 'lucide-react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { naturalSlotIndex, type TimeSlot } from '@/lib/time-slot-assign'
import { useReminders, type ReminderGroup } from '@/hooks/useReminders'
import type { Task } from '@/types'

/**
 * The dashboard's Reminders panel (approved mockup:
 * https://claude.ai/artifact/ScvDAgfaAw4JinJ7UHyErk) — a compact, live version
 * of `/reminders`' slot treatment, one time slot at a time, sitting above
 * Track in the Tasks page's right column (see `TrackColumn` in
 * `DashboardClient.tsx`, which is why this takes its data dependencies —
 * `timeSlots`, `timezone`, the undo pipeline — as props rather than fetching
 * or deriving its own: they are the SAME ones the dashboard already has, and a
 * second copy of any of them is exactly the kind of drift `isTracked` warns
 * about elsewhere in this file).
 *
 * DELIBERATELY SMALLER than `/reminders`' `RemindersView`:
 * - No press-and-hold selection, no floating action bar, no multi-select. A
 *   circle completes one reminder; that is the only interaction besides
 *   paging and Show more/less. The full gesture set belongs to the real page.
 * - No leaving animation. `useReminders`' `registerRow`/`rowLeft` pair exists
 *   so a row can hold its place on screen while it collapses (so a fast
 *   double-tap doesn't land on whatever slid up under it) — this panel never
 *   calls either, so every id the hook completes is treated as "off screen"
 *   and removed from `groups` at once. That is fine here: a four-row capped
 *   list has nothing to double-tap into by accident.
 * - No confirmation dialog on "Considered all" (the real page's
 *   `ConsiderAllDialog` asks first). The toast's Undo covers a slip, and this
 *   panel's whole design is "glance and tap", not a place to pause and confirm.
 */

/** Default row cap before "Show more" — the mockup's `CAP`. */
const ROW_CAP = 4

const UNSLOTTED_KEY = 'unslotted'

function groupKey(group: ReminderGroup): string {
  return group.slot ? String(group.slot.id) : UNSLOTTED_KEY
}

/** "07:00" → "7:00 AM". Falls back to the raw value if it isn't HH:MM. */
function formatSlotTime(startTime: string): string {
  const parsed = DateTime.fromFormat(startTime, 'HH:mm')
  return parsed.isValid ? parsed.toFormat('h:mm a') : startTime
}

export function DashboardRemindersPanel({
  onUndo,
  onCompleted,
  refreshRef,
  timeSlots,
  timezone,
}: {
  onUndo: () => void
  onCompleted: () => void
  /** Registers this panel's refetch with the dashboard's own refresh chain —
   * see the block comment on `remindersRefreshRef` in `DashboardClient.tsx`
   * for why this has to exist (undo, the sync stream, and a completion made
   * elsewhere all route through it). */
  refreshRef: React.MutableRefObject<(() => void) | null>
  timeSlots: TimeSlot[]
  timezone: string
}) {
  const { groups, complete, completeGroup, refresh } = useReminders({
    onUndo,
    onCompleted,
    timeSlots,
    timezone,
  })

  useEffect(() => {
    refreshRef.current = () => void refresh()
    return () => {
      refreshRef.current = null
    }
  }, [refreshRef, refresh])

  // The chevron override, by slot key rather than index: `groups` can reorder
  // or shrink on a refresh, and a key survives that where an index wouldn't.
  const [overrideKey, setOverrideKey] = useState<string | null>(null)
  // Per-slot uncapped state — a Set so paging away and back remembers it.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())

  // Nothing anywhere today (no reminders waiting, none considered) — nothing
  // to show, the same way `TrackPanel` returns null with no quotas.
  const hasAnything = groups.some((g) => g.reminders.length > 0 || g.considered > 0)
  if (!hasAnything) return null

  // `new Date()` at the call site, not hoisted to a variable: this keeps the
  // call a fresh object identity every render, so the React Compiler cannot
  // memoize it away as "pure in groups/timezone" and skip recomputing purely
  // because the wall clock moved — see the module docblock's "component state
  // that recomputes... on each render is sufficient" assumption.
  const natural = naturalSlotIndex(groups, timezone, new Date())
  const overrideIndex = overrideKey ? groups.findIndex((g) => groupKey(g) === overrideKey) : -1
  const index = overrideIndex >= 0 ? overrideIndex : natural
  const group = groups[index]
  const key = groupKey(group)
  const expanded = expandedKeys.has(key)

  const goTo = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= groups.length) return
    setOverrideKey(groupKey(groups[nextIndex]))
  }
  const setExpanded = (next: boolean) => {
    setExpandedKeys((prev) => {
      const copy = new Set(prev)
      if (next) copy.add(key)
      else copy.delete(key)
      return copy
    })
  }

  const label = group.slot?.label ?? 'Anytime'
  const time = group.slot ? formatSlotTime(group.slot.start_time) : null
  const total = group.reminders.length + group.considered
  const visible = expanded ? group.reminders : group.reminders.slice(0, ROW_CAP)
  const hiddenCount = group.reminders.length - visible.length

  return (
    <section
      aria-label="Reminders"
      data-reminders-panel
      data-reminders-slot={key}
      className="bg-muted/30 mb-6 overflow-hidden rounded-2xl"
    >
      <SlotPagerHeader
        label={label}
        time={time}
        considered={group.considered}
        total={total}
        expanded={expanded}
        canGoPrev={index > 0}
        canGoNext={index < groups.length - 1}
        onPrev={() => goTo(index - 1)}
        onNext={() => goTo(index + 1)}
        onConsiderAll={() => void completeGroup(group)}
      />

      {expanded && (
        <div
          className="bg-muted mx-3 mb-2 h-[3px] overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={group.considered}
          aria-label={`${group.considered} of ${total} considered in ${label}`}
        >
          <div
            className="bg-foreground/50 h-full rounded-full transition-[width] duration-300 ease-out"
            style={{ width: `${total > 0 ? Math.min(1, group.considered / total) * 100 : 0}%` }}
          />
        </div>
      )}

      {group.reminders.length === 0 ? (
        <p className="text-muted-foreground px-3 pb-3 text-sm">Nothing left here</p>
      ) : (
        <ul className="space-y-0.5 px-2 pb-1" aria-label={label}>
          {visible.map((reminder) => (
            <PanelRow
              key={reminder.id}
              reminder={reminder}
              clamped={!expanded}
              onComplete={() => void complete(reminder)}
            />
          ))}
        </ul>
      )}

      {group.reminders.length > ROW_CAP && (
        <RowCountToggle
          expanded={expanded}
          hiddenCount={hiddenCount}
          onToggle={() => setExpanded(!expanded)}
        />
      )}
    </section>
  )
}

/**
 * Prev chevron / slot name + time / count / (Considered all, expanded only) /
 * next chevron — one row, mirroring the widget's own `ChevronPager` header
 * except for the readout: the widget says "N left", this says the mockup's
 * "<considered> of <total>" so the number reads the same way the real
 * Reminders page's slot counter does (climbs, never counts down).
 */
function SlotPagerHeader({
  label,
  time,
  considered,
  total,
  expanded,
  canGoPrev,
  canGoNext,
  onPrev,
  onNext,
  onConsiderAll,
}: {
  label: string
  time: string | null
  considered: number
  total: number
  expanded: boolean
  canGoPrev: boolean
  canGoNext: boolean
  onPrev: () => void
  onNext: () => void
  onConsiderAll: () => void
}) {
  return (
    <div className="flex min-h-11 items-center gap-1.5 px-2 py-1.5">
      <button
        type="button"
        onClick={onPrev}
        disabled={!canGoPrev}
        aria-label="Previous time slot"
        title="Previous time slot"
        className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors disabled:pointer-events-none disabled:opacity-30"
      >
        <ChevronLeft className="size-4" strokeWidth={2} />
      </button>

      <div className="min-w-0 flex-1">
        <span className="text-muted-foreground text-xs font-semibold tracking-wider whitespace-nowrap uppercase">
          {label}
        </span>
        {time && (
          <span className="text-muted-foreground/50 text-xs whitespace-nowrap">
            {' '}
            &middot; {time}
          </span>
        )}
      </div>

      <span
        className="text-xs whitespace-nowrap tabular-nums"
        aria-label={`${considered} of ${total} considered`}
      >
        <span className="text-foreground font-medium">{considered}</span>
        <span className="text-muted-foreground"> of {total}</span>
      </span>

      {expanded && total > 0 && (
        <button
          type="button"
          onClick={onConsiderAll}
          aria-label={`Mark all in ${label} as considered`}
          className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs font-medium transition-colors"
        >
          <CheckCheck className="size-3.5" strokeWidth={2.5} />
          <span className="hidden sm:inline">Considered all</span>
        </button>
      )}

      <button
        type="button"
        onClick={onNext}
        disabled={!canGoNext}
        aria-label="Next time slot"
        title="Next time slot"
        className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors disabled:pointer-events-none disabled:opacity-30"
      >
        <ChevronRight className="size-4" strokeWidth={2} />
      </button>
    </div>
  )
}

/** One reminder: a circle that completes it, and its title. Capped rows clamp
 * their title to one line (the mockup's resting height); an uncapped slot
 * wraps it in full — never ellipsizes — the same as the real Reminders page. */
function PanelRow({
  reminder,
  clamped,
  onComplete,
}: {
  reminder: Task
  clamped: boolean
  onComplete: () => void
}) {
  return (
    <li data-reminder-id={reminder.id} className="flex items-start gap-2.5 rounded-xl px-1 py-1.5">
      <button
        type="button"
        onClick={onComplete}
        aria-label={`Mark "${reminder.title}" as considered`}
        title="Considered"
        className="border-foreground/25 hover:border-foreground/60 hover:bg-foreground/5 mt-0.5 flex size-[19px] shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors"
      />
      <p
        className={cn(
          'min-w-0 flex-1 text-[13.5px] leading-[1.42] text-pretty',
          clamped && 'line-clamp-1',
        )}
      >
        {reminder.title}
      </p>
    </li>
  )
}

/** "Show more N (M more)" / "Show less" below the row list — matches the
 * mockup's single full-width button, one of which can ever be showing since
 * only a capped list needs "more" and only an uncapped one needs "less". */
function RowCountToggle({
  expanded,
  hiddenCount,
  onToggle,
}: {
  expanded: boolean
  hiddenCount: number
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground w-full border-t px-3 py-2 text-center text-xs font-semibold transition-colors"
    >
      {expanded ? 'Show less' : `Show more${hiddenCount > 0 ? ` (${hiddenCount} more)` : ''}`}
    </button>
  )
}
