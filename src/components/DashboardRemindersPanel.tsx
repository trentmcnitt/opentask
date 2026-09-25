'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, CheckCheck, ChevronLeft, ChevronRight } from 'lucide-react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { naturalSlotIndex, slotAfterFinishing, type TimeSlot } from '@/lib/time-slot-assign'
import { useReminders, type ReminderGroup, type UseRemindersReturn } from '@/hooks/useReminders'
import { useLongPress } from '@/hooks/useLongPress'
import { ReminderDetailModal } from '@/components/ReminderDetailModal'
import { ReminderRowPopover } from '@/components/ReminderRowPopover'
import { ReminderSlotBar } from '@/components/ReminderSlotBar'
import { usePromptRows } from '@/components/QuotaPromptRow'
import { groupConsidered, groupWaiting, promptWaiting, type QuotaPrompt } from '@/lib/quota-prompts'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { saveTaskChanges } from '@/lib/save-task-changes'
import { showToast } from '@/lib/toast'
import { log } from '@/lib/logger'
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
 * - No SELECTION mode, no floating action bar, no multi-select, no create
 *   flow. A circle completes one reminder on a tap; press-and-hold opens that
 *   ONE reminder's read-only bubble (`ReminderRowPopover`), and the bubble's
 *   Open is what reaches the `ReminderDetailModal` editor `/reminders` uses —
 *   two steps, exactly as a quota chip has worked since 2026-09-06. Trent
 *   asked for the parity on 2026-09-21 ("the same thing that we do for
 *   quotas... I feel like there are some times I'm going to want notes"),
 *   and the bubble is the only way to read a note from this panel, since a
 *   row carries no note indicator at all. The editor remains
 *   the only place this panel can edit or delete a reminder from. That, a
 *   tap, paging and Show more/less are the whole interaction set; multi-select
 *   and a floating action bar remain the real page's job.
 * - No leaving animation. `useReminders`' `registerRow`/`rowLeft` pair exists
 *   so a row can hold its place on screen while it collapses (so a fast
 *   double-tap doesn't land on whatever slid up under it) — this panel never
 *   calls either, so every id the hook completes is treated as "off screen"
 *   and removed from `groups` at once. The accepted cost is that a fast
 *   double-tap on one circle can consider the row that slides up into its
 *   place; the toast's Undo is the recovery. `/reminders` is the surface that
 *   pays for the animation, because it is where a long sitting is done.
 * - No confirmation dialog on "Considered all" (the real page's
 *   `ConsiderAllDialog` asks first). The toast's Undo covers a slip, and this
 *   panel's whole design is "glance and tap", not a place to pause and confirm.
 */

/**
 * How many rows a slot shows before "Show more" (Trent, 2026-09-21).
 *
 * ONE number per width, serving as both the cap and the threshold: at or under
 * it every row shows, past it you get exactly this many and a button. An
 * earlier cut tried two numbers — show all up to 13, then drop to 9 — and
 * Trent rejected it for the discontinuity that creates ("I don't like how it
 * jumps around"): a slot of 14 showed FEWER rows than a slot of 13. With one
 * number, adding a reminder never subtracts a visible row.
 *
 * Narrow gets the smaller cap because that is where the panel competes: it
 * sits inline above Track and the day, so 9 rows of thoughts put the first
 * task a full screen down (measured: 657px of panel, first task at 1.28
 * screens). Wide has its own column beside the day and costs it nothing.
 */
const WIDE_CAP = 9
const NARROW_CAP = 5

const UNSLOTTED_KEY = 'unslotted'

function groupKey(group: ReminderGroup): string {
  return group.slot ? String(group.slot.id) : UNSLOTTED_KEY
}

/** "07:00" → "7:00 AM". Falls back to the raw value if it isn't HH:MM. */
function formatSlotTime(startTime: string): string {
  const parsed = DateTime.fromFormat(startTime, 'HH:mm')
  return parsed.isValid ? parsed.toFormat('h:mm a') : startTime
}

/**
 * The row's press-and-hold editor: `ReminderDetailModal`, wired to the exact
 * same writes `RemindersView`'s own Details editor uses for a single
 * reminder — `saveTaskChanges` (same toast, same Undo), and `useReminders`'
 * own `completeMany`/`remove` for Considered/delete (same soft-delete-with-
 * undo everything else on this dashboard goes through). A local hook, not
 * inline state in `DashboardRemindersPanel`, so the panel's own render stays
 * short — the same reason `useQuotaMutations` is its own file rather than
 * inline in `QuotasView`.
 */
function useRowEditor({
  timeSlots,
  onUndo,
  onCompleted,
  reminders,
}: {
  timeSlots: TimeSlot[]
  onUndo: () => void
  onCompleted: () => void
  reminders: Pick<UseRemindersReturn, 'refresh' | 'completeMany' | 'remove'>
}) {
  const { refresh, completeMany, remove } = reminders
  const router = useRouter()
  const [editing, setEditing] = useState<Task[]>([])
  const open = useCallback((task: Task) => setEditing([task]), [])

  const saveDetail = useCallback(
    async (taskId: number, changes: QuickActionPanelChanges) => {
      try {
        // A schedule set by hand makes an earlier AI failure moot — the same
        // rule RemindersView's own saveDetail applies (see its comment there
        // for the "why"); duplicated here, in a few lines, rather than lifted
        // out of that file, which this branch is not otherwise touching.
        const failed = editing.find((t) => t.id === taskId)?.labels.includes('ai-failed')
        const { description } = await saveTaskChanges(
          taskId,
          failed
            ? { ...changes, labels_remove: [...(changes.labels_remove ?? []), 'ai-failed'] }
            : changes,
        )
        showToast({
          message: description || 'Reminder updated',
          type: 'success',
          action: { label: 'Undo', onClick: onUndo },
        })
        onCompleted()
        void refresh()
      } catch (err) {
        showToast({
          message: err instanceof Error && err.message ? err.message : 'Save failed',
          type: 'error',
        })
        throw err
      }
    },
    [editing, onUndo, onCompleted, refresh],
  )

  const modal = (
    <ReminderDetailModal
      tasks={editing}
      open={editing.length > 0}
      timeSlots={timeSlots}
      onClose={() => setEditing([])}
      onSaveAll={saveDetail}
      // Never reached: this panel always opens the modal with exactly one
      // reminder (no multi-select — see the module docblock) and never passes
      // `create`, so the editor's bulk-save and new-reminder paths never
      // mount. Logged rather than left empty in case that assumption is ever
      // broken by a future change.
      onSaveMany={async () => log.error('ui', 'DashboardRemindersPanel: unexpected bulk save')}
      onCreate={async () => log.error('ui', 'DashboardRemindersPanel: unexpected create')}
      onConsidered={(tasks) => void completeMany(tasks)}
      onDelete={(tasks) => void remove(tasks)}
      onOpenPage={(id) => router.push(`/tasks/${id}`)}
    />
  )

  return { open, modal }
}

/**
 * What changed about the slot on screen since the last render, and whether
 * that was finishing it: the new `seen` to record (null when nothing changed)
 * and the slot key to move to, if finishing a past slot means moving on.
 */
function afterFinishing(
  seen: { key: string; waiting: number } | null,
  groups: ReminderGroup[],
  index: number,
  natural: number,
): { seen: { key: string; waiting: number }; to: string | null } | null {
  const key = groupKey(groups[index])
  const waiting = groupWaiting(groups[index])
  if (seen?.key === key && seen.waiting === waiting) return null
  const finished = seen?.key === key && seen.waiting > 0 && waiting === 0
  const target = finished ? slotAfterFinishing(groups, index, natural) : null
  const landing = groups[target ?? index]
  return {
    seen: { key: groupKey(landing), waiting: groupWaiting(landing) },
    to: target === null ? null : groupKey(landing),
  }
}

interface DashboardRemindersPanelProps {
  onUndo: () => void
  onCompleted: () => void
  /** Registers this panel's refetch with the dashboard's own refresh chain —
   * see the block comment on `remindersRefreshRef` in `DashboardClient.tsx`
   * for why this has to exist (undo, the sync stream, and a completion made
   * elsewhere all route through it). */
  refreshRef: React.MutableRefObject<(() => void) | null>
  timeSlots: TimeSlot[]
  timezone: string
}

export function DashboardRemindersPanel({
  onUndo,
  onCompleted,
  refreshRef,
  timeSlots,
  timezone,
}: DashboardRemindersPanelProps) {
  const reminders = useReminders({ onUndo, onCompleted, timeSlots, timezone })
  const { groups, complete, completeGroup, putBack, remove, refresh } = reminders
  const editor = useRowEditor({ timeSlots, onUndo, onCompleted, reminders })
  // Quota prompts (2026-09-24): the /reminders surface's own rows, compact.
  // No leaving animation here, like the reminder rows (see the docblock).
  const { considerPrompt, didPrompt, movePrompt } = reminders
  const prompts = usePromptRows({
    considerPrompt,
    didPrompt,
    movePrompt,
    refresh,
    onUndo,
    onCompleted,
    variant: 'panel',
  })
  // Which row's read-only bubble is open, if any. One id rather than a flag
  // per row: only ever one bubble at a time, the same way `TrackPanel` holds
  // a single `detailId` for its chips.
  const [peekId, setPeekId] = useState<number | null>(null)
  // Whether this slot's already-considered thoughts are showing. Per-slot, and
  // reset by paging, because "what did I already do here" is a question about
  // one slot rather than a mode the panel sits in.
  const [showConsidered, setShowConsidered] = useState(false)

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
  // The slot on screen and how many were waiting in it at the last render —
  // how finishing it is told apart from paging to one already finished. See
  // `slotAfterFinishing`.
  const [seen, setSeen] = useState<{ key: string; waiting: number } | null>(null)

  // Nothing anywhere today (no reminders waiting, none considered) — nothing
  // to show, the same way `TrackPanel` returns null with no quotas.
  const hasAnything = groups.some((g) => groupWaiting(g) > 0 || groupConsidered(g) > 0)
  if (!hasAnything) return null

  // `new Date()` at the call site, not hoisted to a variable: this keeps the
  // call a fresh object identity every render, so the React Compiler cannot
  // memoize it away as "pure in groups/timezone" and skip recomputing purely
  // because the wall clock moved — see the module docblock's "component state
  // that recomputes... on each render is sufficient" assumption.
  const now = new Date()
  const natural = naturalSlotIndex(groups, timezone, now)
  const overrideIndex = overrideKey ? groups.findIndex((g) => groupKey(g) === overrideKey) : -1
  const index = overrideIndex >= 0 ? overrideIndex : natural
  const group = groups[index]
  const key = groupKey(group)
  const expanded = expandedKeys.has(key)
  const rows = slotRows(group)
  const count = rows.length
  const considered = groupConsidered(group)

  // FINISHING A SLOT MOVES THE PAGER TO THE EARLIEST UNDONE ONE (Trent,
  // 2026-09-22, refined 2026-09-23 — see `slotAfterFinishing` for the rule). Only a slot that went from something
  // waiting to nothing, while on screen, counts: paging to a slot that was
  // already done leaves you there to look at it. Last check-off and
  // "Considered all" both qualify. Set during render, not in an effect, so the
  // emptied slot is never painted before the move.
  const move = afterFinishing(seen, groups, index, natural)
  if (move) {
    setSeen(move.seen)
    if (move.to) {
      setOverrideKey(move.to)
      setShowConsidered(false)
    }
  }

  const goTo = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= groups.length) return
    setOverrideKey(groupKey(groups[nextIndex]))
    setShowConsidered(false)
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
  const total = count + considered
  // WHICH ROWS ARE ON SCREEN IS DECIDED IN CSS, NOT HERE.
  //
  // The cap is per-width, and reading the width in JS is the one thing this
  // codebase has already learned not to do on this page: `useIsMobile` only
  // answers after an effect runs, so a phone would paint nine rows and then
  // collapse to five a frame later — the same lurch `useResponsiveFold`'s
  // docblock exists to explain. So render up to the WIDE cap and let a media
  // query drop the overflow below `xl`, which is correct in the very first
  // paint with no JS at all.
  //
  // `xl` is deliberately the same breakpoint the two-column layout uses (see
  // `mainClass` in DashboardClient.tsx): it is exactly the width at which this
  // panel stops sharing vertical space with the day and gets a column of its
  // own, which is the whole reason the narrow cap is tighter.
  const visible = expanded ? rows : rows.slice(0, WIDE_CAP)
  const hiddenWhenNarrow = count - NARROW_CAP
  const hiddenWhenWide = count - WIDE_CAP

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
        considered={considered}
        total={total}
        expanded={expanded}
        canGoPrev={index > 0}
        canGoNext={index < groups.length - 1}
        onPrev={() => goTo(index - 1)}
        onNext={() => goTo(index + 1)}
        onConsiderAll={() => void completeGroup(group)}
        onToggleExpanded={() => setExpanded(!expanded)}
        showConsidered={showConsidered}
        onToggleConsidered={() => setShowConsidered((v) => !v)}
      />

      {/* Replaces the per-slot hairline this panel used to show only while a
          slot was expanded — which meant a short slot, the common case, showed
          no progress at all (Trent, 2026-09-21: "I don't see any indication of
          progress, which is a little disappointing"). The bar is always on
          screen and covers every slot, so it answers that for the whole day
          rather than for whichever one happens to be open. */}
      <ReminderSlotBar
        groups={groups}
        currentIndex={index}
        timezone={timezone}
        now={now}
        onJump={(next) => {
          setOverrideKey(groupKey(groups[next]))
          setPeekId(null)
          setShowConsidered(false)
        }}
      />

      {count === 0 ? (
        <p className="text-muted-foreground px-3 pb-3 text-sm">Nothing left here</p>
      ) : (
        <PanelRowList
          rows={visible}
          expanded={expanded}
          label={label}
          peekId={peekId}
          setPeekId={setPeekId}
          onComplete={(reminder) => void complete(reminder)}
          onRemove={(task) => void remove([task])}
          onOpenEditor={editor.open}
          renderPrompt={prompts.renderPrompt}
          timeSlots={timeSlots}
          timezone={timezone}
        />
      )}

      {showConsidered && group.consideredItems.length > 0 && (
        <ConsideredList
          items={group.consideredItems}
          label={label}
          onPutBack={(task) => void putBack(task)}
        />
      )}

      {hiddenWhenNarrow > 0 && (
        <RowCountToggle
          expanded={expanded}
          hiddenWhenNarrow={hiddenWhenNarrow}
          hiddenWhenWide={hiddenWhenWide}
          onToggle={() => setExpanded(!expanded)}
        />
      )}

      {editor.modal}
      {prompts.modal}
    </section>
  )
}

/** One row of the slot on screen: a reminder, or a waiting quota prompt. */
type PanelSlotRow = { kind: 'reminder'; reminder: Task } | { kind: 'prompt'; prompt: QuotaPrompt }

/**
 * The slot's rows, reminders first, then its waiting quota prompts
 * (2026-09-24). The cap counts ITEMS across both — a prompt is a row like any
 * other — so the one `hiddenWhenNarrow` rule covers them all.
 */
function slotRows(group: ReminderGroup): PanelSlotRow[] {
  return [
    ...group.reminders.map((reminder) => ({ kind: 'reminder' as const, reminder })),
    ...group.prompts.filter(promptWaiting).map((prompt) => ({ kind: 'prompt' as const, prompt })),
  ]
}

function PanelRowList({
  rows,
  expanded,
  label,
  peekId,
  setPeekId,
  onComplete,
  onRemove,
  onOpenEditor,
  renderPrompt,
  timeSlots,
  timezone,
}: {
  rows: PanelSlotRow[]
  expanded: boolean
  label: string
  peekId: number | null
  setPeekId: (id: number | null) => void
  onComplete: (reminder: Task) => void
  onRemove: (reminder: Task) => void
  onOpenEditor: (reminder: Task) => void
  renderPrompt: (prompt: QuotaPrompt, extra: { hiddenWhenNarrow?: boolean }) => React.ReactNode
  timeSlots: TimeSlot[]
  timezone: string
}) {
  return (
    <ul className="space-y-0.5 px-2 pb-1" aria-label={label}>
      {rows.map((row, i) => {
        // Rendered, but not on screen until there is a column to spare.
        const hiddenWhenNarrow = !expanded && i >= NARROW_CAP
        if (row.kind === 'prompt') return renderPrompt(row.prompt, { hiddenWhenNarrow })
        const reminder = row.reminder
        return (
          <PanelRow
            key={reminder.id}
            reminder={reminder}
            hiddenWhenNarrow={hiddenWhenNarrow}
            onComplete={() => onComplete(reminder)}
            onPeek={() => setPeekId(reminder.id)}
            peekOpen={peekId === reminder.id}
            onPeekChange={(next) => setPeekId(next ? reminder.id : null)}
            onDelete={(task) => {
              setPeekId(null)
              onRemove(task)
            }}
            onOpenEditor={(task) => {
              // The bubble is done the moment the editor takes over —
              // leaving it open would stack a popover behind a dialog.
              setPeekId(null)
              onOpenEditor(task)
            }}
            timeSlots={timeSlots}
            timezone={timezone}
          />
        )
      })}
    </ul>
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
  onToggleExpanded,
  showConsidered,
  onToggleConsidered,
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
  /** Tapping the bar between the chevrons opens and shuts the slot. */
  onToggleExpanded: () => void
  showConsidered: boolean
  onToggleConsidered: () => void
}) {
  // Same numbers the slot bar fills with — no parallel notion of "finished".
  // `total > 0` matters here: an empty slot reading "0 of 0" is not complete,
  // it's empty, and gets no check mark (no chrome for something that isn't
  // there).
  const complete = total > 0 && considered >= total
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

      {/* The whole bar between the chevrons toggles the slot open and shut.
          Trent, 2026-09-21: "If you tap anywhere in there that's not on one of
          the carrots, it'd be nice if that expanded and collapsed the
          section." The chevrons page between slots and keep their own hit
          areas; everything between them is one target.

          It toggles even when no rows are held back, and that is deliberate:
          a slot under the cap has no "Show more" button at all, so before this
          there was no way to unclamp its titles or reach "Considered all". */}
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        data-slot-header-toggle
        className="hover:bg-foreground/5 flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 py-1 text-left transition-colors"
      >
        <span className="min-w-0 flex-1">
          <span className="text-muted-foreground text-xs font-semibold tracking-wider whitespace-nowrap uppercase">
            {label}
          </span>
          {time && (
            <span className="text-muted-foreground/50 text-xs whitespace-nowrap">
              {' '}
              &middot; {time}
            </span>
          )}
        </span>
      </button>

      {/* The count IS the considered count, so tapping it is how you see what
          those were (Trent, 2026-09-21, choosing this over a second full-width
          bar in the footer: "Show Considered stacked on Show More looks like a
          big UX no-no"). A button only when there is something behind it —
          otherwise it is a plain readout and must not look pressable. */}
      {considered > 0 ? (
        <button
          type="button"
          onClick={onToggleConsidered}
          aria-expanded={showConsidered}
          data-considered-toggle
          aria-label={`${considered} of ${total} considered — show what was considered`}
          className={cn(
            'hover:bg-foreground/5 flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs whitespace-nowrap tabular-nums transition-colors',
            // THE BOX IS THE WHOLE SIGNAL. Trent, 2026-09-21: "when you
            // highlight it there's a little box around the text. When the
            // considered stuff is open there should still be a gray box
            // around the X of Y text." A bolding was tried alongside it and
            // cut the same day — "Don't bold the text... I like the box
            // around it though" — so the text never changes weight and the
            // held box says everything. It reuses the affordance the pointer
            // already reveals rather than adding a new one.
            showConsidered && 'bg-foreground/5',
          )}
        >
          {/* ONE COLOUR ACROSS THE WHOLE COUNT, AND NO WEIGHT CHANGE. The
              considered number sat a shade darker than "of N" for no reason
              anyone could name — Trent, 2026-09-21: "Why is 1 darker than the
              19?" It also briefly went bold while open, which he cut the same
              day: "Don't bold the text... I like the box around it though."
              So the box is the state and the text merely lifts out of muted. */}
          <span className={cn(showConsidered ? 'text-foreground' : 'text-muted-foreground')}>
            {considered} of {total}
          </span>
          {/* THE CHECK REPORTS STATUS, NOT AN AFFORDANCE — unlike the caret
              and the bolding cut from this same element (2026-09-21), this
              earns its place: it is the only thing on the panel that answers
              "is this slot actually finished?" without asking the reader to
              compare a fill's length to the end of its track. Small, quiet,
              and only ever present when true — never a greyed-out
              placeholder for "not yet". */}
          {complete && (
            <Check
              className="size-3.5 text-green-700 dark:text-green-400"
              strokeWidth={2.5}
              aria-hidden="true"
            />
          )}
        </button>
      ) : (
        <span
          className="px-1.5 text-xs whitespace-nowrap tabular-nums"
          aria-label={`${considered} of ${total} considered`}
        >
          <span className="text-muted-foreground">
            {considered} of {total}
          </span>
        </span>
      )}

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

/**
 * One reminder: a circle that completes it, and its title. Capped rows clamp
 * their title to one line (the mockup's resting height); an uncapped slot
 * wraps it in full — never ellipsizes — the same as the real Reminders page.
 *
 * Press-and-hold anywhere on the row opens `ReminderDetailModal` for this one
 * reminder — the same `useLongPress` at the same 400ms `RemindersView`'s own
 * rows use (see `useReminderRowGestures` there). CRITICAL: the circle is
 * "complete this reminder" on a plain tap, and a hold must not ALSO complete
 * it. `ReminderRow`'s marker solves this with `onPointerDown={(e) =>
 * e.stopPropagation()}` on the circle, so the row's own long-press timer
 * never starts for a press that began there — the same fix, here, rather
 * than `didFire()`: this row (unlike that one) has no OTHER click handler for
 * a trailing click to collide with, so there is nothing for `didFire()` to
 * guard.
 */
function PanelRow({
  reminder,
  hiddenWhenNarrow = false,
  onComplete,
  onPeek,
  peekOpen,
  onPeekChange,
  onOpenEditor,
  onDelete,
  timeSlots,
  timezone,
}: {
  reminder: Task
  /** Past the narrow cap: in the DOM, but only on screen from `xl` up. */
  hiddenWhenNarrow?: boolean
  onComplete: () => void
  /** A hold opens the row's own read-only bubble — NOT the editor. Open, in
   *  there, is what reaches the editor (Trent, 2026-09-21). */
  onPeek: () => void
  /** Whether THIS row's bubble is the open one. */
  peekOpen: boolean
  onPeekChange: (open: boolean) => void
  /** The bubble's Open was pressed. */
  onOpenEditor: (reminder: Task) => void
  /** The bubble's trash can. Soft delete, with an Undo toast. */
  onDelete: (reminder: Task) => void
  timeSlots: TimeSlot[]
  timezone: string
}) {
  const press = useLongPress({ onLongPress: onPeek })

  return (
    <ReminderRowPopover
      reminder={reminder}
      timeSlots={timeSlots}
      timezone={timezone}
      open={peekOpen}
      onOpenChange={onPeekChange}
      onOpen={onOpenEditor}
      onDelete={onDelete}
    >
      {/* THE WHOLE ROW CONSIDERS, not just the circle (Trent, 2026-09-22:
          "we need to be able to tap the actual text to finish the reminder
          (like is already the case on the reminders tab). It's annoying having
          to tap the little circle."). The same rule as the Reminders surface's
          row: a tap considers, the click a hold leaves behind is swallowed
          (the hold opened the bubble), and the circle keeps its own click so
          it is not counted twice. The circle stays the keyboard's way in. */}
      <li
        data-reminder-id={reminder.id}
        className={cn(
          'hover:bg-foreground/5 cursor-pointer items-start gap-2.5 rounded-xl px-1 py-1.5 transition-colors select-none',
          hiddenWhenNarrow ? 'hidden xl:flex' : 'flex',
        )}
        onClick={(e) => {
          if (press.didFire()) {
            e.preventDefault()
            return
          }
          if ((e.target as HTMLElement).closest('button')) return
          onComplete()
        }}
        onPointerDown={press.onPointerDown}
        onPointerUp={press.onPointerUp}
        onPointerMove={press.onPointerMove}
        onPointerLeave={press.onPointerLeave}
        onPointerCancel={press.onPointerUp}
      >
        <button
          type="button"
          onClick={onComplete}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={`Mark "${reminder.title}" as considered`}
          title="Considered"
          // No top margin: the 19px circle and the 19.2px first line share a
          // centre on their own. The `mt-0.5` this used to carry pushed the
          // circle ~2px below it — Trent, 2026-09-21: "the text is a little
          // higher than the center line of the circle."
          className="border-foreground/25 hover:border-foreground/60 hover:bg-foreground/5 flex size-[19px] shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors"
        />
        {/* NEVER TRUNCATED. Trent, 2026-09-21: "reminders can't be truncated.
            They have to show the full thing... It needs to line wrap somehow."
            Half a thought prompts nothing — the same reason the iOS widget
            gives its rows two lines instead of one. The cap above still counts
            ITEMS rather than lines, so a slot of long thoughts is simply a
            taller panel; accepted deliberately ("maybe we should just not care
            about it") over a height-based cap, which would make the number of
            visible rows change with the length of their text. */}
        <p className="min-w-0 flex-1 text-[13.5px] leading-[1.42] text-pretty">{reminder.title}</p>
      </li>
    </ReminderRowPopover>
  )
}

/**
 * "Show more (N more)" / "Show less" below the row list.
 *
 * Two counts, because the cap is per-width and the width is not known here
 * (see the block comment on `visible`). Both are rendered and a media query
 * picks one, so the number is right in the first paint. The button ITSELF is
 * hidden below nothing and above `xl` when the wide cap hides nothing — a slot
 * of 7 has two rows held back on a phone but is complete on a desktop, so
 * there is nothing to press for there.
 */
function RowCountToggle({
  expanded,
  hiddenWhenNarrow,
  hiddenWhenWide,
  onToggle,
}: {
  expanded: boolean
  hiddenWhenNarrow: number
  hiddenWhenWide: number
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'text-muted-foreground hover:bg-foreground/5 hover:text-foreground w-full border-t px-3 py-2 text-center text-xs font-semibold transition-colors',
        !expanded && hiddenWhenWide <= 0 && 'xl:hidden',
      )}
    >
      {expanded ? (
        'Show less'
      ) : (
        <>
          <span className="xl:hidden">Show more ({hiddenWhenNarrow} more)</span>
          <span className="hidden xl:inline">
            Show more{hiddenWhenWide > 0 ? ` (${hiddenWhenWide} more)` : ''}
          </span>
        </>
      )}
    </button>
  )
}

/**
 * What has already been considered in this slot.
 *
 * Trent, 2026-09-21: "I can't see the items that I considered for that day so
 * we want to be able to see what's considered." It opens from the header's
 * count rather than a footer button — the count already says how many were
 * considered, so it is the natural thing to press, and a second full-width bar
 * stacked under "Show more" was the thing he rejected ("a big UX no-no").
 *
 * A row here is checked, dim, and does ONE thing: its circle puts the thought
 * back. No press-and-hold, no editor — a considered thought is done with, and
 * the put-back is how you change your mind. (On `/reminders`, where a longer
 * sitting happens, those rows DO reach the editor; this panel is a glance.)
 */
function ConsideredList({
  items,
  label,
  onPutBack,
}: {
  items: Task[]
  label: string
  onPutBack: (task: Task) => void
}) {
  return (
    <ul className="space-y-0.5 px-2 pb-1" aria-label={`Considered in ${label}`}>
      {items.map((reminder) => (
        <li
          key={reminder.id}
          data-considered-id={reminder.id}
          className="flex items-start gap-2.5 rounded-xl px-1 py-1.5"
        >
          <button
            type="button"
            onClick={() => onPutBack(reminder)}
            aria-label={`Put back "${reminder.title}"`}
            title="Put back"
            className="flex size-[19px] shrink-0 items-center justify-center rounded-full bg-green-600 text-white transition-colors hover:bg-green-600/50"
          >
            <Check className="size-3" strokeWidth={3} />
          </button>
          <p className="text-muted-foreground min-w-0 flex-1 text-[13.5px] leading-[1.42] text-pretty">
            {reminder.title}
          </p>
        </li>
      ))}
    </ul>
  )
}
