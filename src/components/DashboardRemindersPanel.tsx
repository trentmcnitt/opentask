'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatClockTime } from '@/lib/time-utils'
import { slotGroupKey, slotLabel } from '@/lib/reminder-slots'
import { slotHasStarted } from '@/lib/reminders-summary'
import { naturalSlotIndex, orderGroupsByDay, type TimeSlot } from '@/lib/time-slot-assign'
import { useReminders, type ReminderGroup, type UseRemindersReturn } from '@/hooks/useReminders'
import { useTaskSegments } from '@/hooks/useTaskSegments'
import { useDayStart } from '@/components/PreferencesProvider'
import { useLongPress } from '@/hooks/useLongPress'
import { usePanelPager } from '@/hooks/usePanelPager'
import { ReminderDetailModal } from '@/components/ReminderDetailModal'
import { ReminderRowPopover } from '@/components/ReminderRowPopover'
import { ReminderSlotBar } from '@/components/ReminderSlotBar'
import { NotesMarker } from '@/components/NotesMarker'
import { InlinePriorityTab, PriorityEdgeBar } from '@/components/RowCorner'
import { usePriorityRowStyles } from '@/hooks/usePriorityRowStyles'
import { ConsideredPromptRow, usePromptRows } from '@/components/QuotaPromptRow'
import { DashboardTasksPanel } from '@/components/DashboardTasksPanel'
import { SegmentDetailsModal } from '@/components/reminders/TaskSegmentDetails'
import {
  NARROW_CAP,
  PagerSweep,
  RowCountToggle,
  SlotPagerHeader,
  WIDE_CAP,
} from '@/components/reminders/PanelPagerParts'
import { groupConsidered, groupWaiting, promptWaiting, type QuotaPrompt } from '@/lib/quota-prompts'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { saveReminderDetail } from '@/lib/save-reminder-detail'
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
 *   and the bubble is the only way to read a note from this panel (a row
 *   only marks that one exists, with the Reminders page's `NotesMarker`,
 *   since 2026-09-25). The editor remains
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
 * The row's press-and-hold editor: `ReminderDetailModal`, wired to the exact
 * same writes `RemindersView`'s own Details editor uses for a single
 * reminder — `saveReminderDetail` (same toast, same Undo, same `ai-failed`
 * rule), and `useReminders`'
 * own `completeMany`/`remove` for Considered/delete (same soft-delete-with-
 * undo everything else on this dashboard goes through). A local hook, not
 * inline state in `DashboardRemindersPanel`, so the panel's own render stays
 * short — the same reason `useQuotaMutations` is its own file rather than
 * inline in the quota surfaces.
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
    (taskId: number, changes: QuickActionPanelChanges) =>
      saveReminderDetail(taskId, changes, { source: editing, onUndo, onCompleted, refresh }),
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
 * One page of the Reminders card's pager: a slot. Task segments have their
 * own card beneath it since 2026-10-11 (`DashboardTasksPanel`; Trent: "i liked
 * the reminders on top of tasks like it was before"), so this pager walks the
 * slots alone, exactly as it did before they shared it.
 */
interface SlotPage {
  key: string
  label: string
  hint: string | null
  group: ReminderGroup
  waiting: number
  considered: number
  total: number
  started: boolean
}

/** The slot pages: none when the day has no reminder at all. */
function buildSlotPages(
  groups: ReminderGroup[],
  timezone: string,
  now: Date,
  dayStart: string,
): SlotPage[] {
  const hasAnything = groups.some((g) => groupWaiting(g) > 0 || groupConsidered(g) > 0)
  if (!hasAnything) return []
  return groups.map((group) => {
    const waiting = groupWaiting(group)
    const considered = groupConsidered(group)
    return {
      key: slotGroupKey(group),
      label: slotLabel(group),
      hint: group.slot ? formatClockTime(group.slot.start_time) : null,
      group,
      waiting,
      considered,
      total: waiting + considered,
      started: slotHasStarted(group.slot, timezone, now, dayStart),
    }
  })
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
  const dayStart = useDayStart()
  const { groups, complete, completeGroup, putBack, putBackPrompt, remove, refresh } = reminders
  const segments = useTaskSegments({
    segments: reminders.taskSegments,
    payloadSeq: reminders.payloadSeq,
    requestSeq: reminders.requestSeq,
    timezone,
    refresh,
    onUndo,
    onCompleted,
  })
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

  useEffect(() => {
    refreshRef.current = () => void refresh()
    return () => {
      refreshRef.current = null
    }
  }, [refreshRef, refresh])

  // `new Date()` at the call site, not hoisted to a variable: this keeps the
  // call a fresh object identity every render, so the React Compiler cannot
  // memoize it away as "pure in groups/timezone" and skip recomputing purely
  // because the wall clock moved — see the module docblock's "component state
  // that recomputes... on each render is sufficient" assumption.
  const now = new Date()
  // In the day's order, so a slot before the day start is the last page.
  const dayGroups = orderGroupsByDay(groups, dayStart)
  const pages = buildSlotPages(dayGroups, timezone, now, dayStart)
  // The slots alone: the natural page is the clock's slot, and finishing one
  // goes to the earliest slot up to now still waiting (`pageAfterFinishing`
  // with every page a slot is `slotAfterFinishing`).
  const pager = usePanelPager(
    pages,
    pages.length,
    pages.length > 0 ? naturalSlotIndex(dayGroups, timezone, now, dayStart) : 0,
  )
  const tasksCard = (
    <>
      <DashboardTasksPanel actions={segments} timezone={timezone} hydrated={reminders.hydrated} />
      {/* A task-segment row's editor: its peek bubble's Open (task queue PR 3). */}
      <SegmentDetailsModal actions={segments} onUndo={onUndo} onCompleted={onCompleted} />
    </>
  )
  // No reminder waiting or considered today: no Reminders card, the same way
  // `TrackPanel` returns null with no quotas. The Tasks card stands alone.
  if (!pager) return tasksCard
  const { page, index, expanded, setExpanded, showConsidered } = pager

  return (
    <>
      <section
        aria-label="Reminders"
        data-reminders-panel
        data-reminders-slot={page.key}
        // Closer to the Tasks card beneath it, so the two read as a pair.
        className={cn(
          'bg-muted/30 overflow-hidden rounded-2xl',
          segments.segments.length > 0 ? 'mb-3' : 'mb-6',
        )}
      >
        <SlotPagerHeader
          label={page.label}
          time={page.hint}
          considered={page.considered}
          total={page.total}
          expanded={expanded}
          canGoPrev={index > 0}
          canGoNext={index < pages.length - 1}
          onPrev={() => pager.goTo(index - 1)}
          onNext={() => pager.goTo(index + 1)}
          // Only while the slot has something waiting (spec rule 9: Considered
          // all shows only while the panel has waiting rows).
          sweep={
            expanded && page.waiting > 0 ? (
              <PagerSweep
                kind="consider"
                ariaLabel={`Mark all in ${page.label} as considered`}
                onClick={() => void completeGroup(page.group)}
              />
            ) : null
          }
          onToggleExpanded={() => setExpanded(!expanded)}
          showConsidered={showConsidered}
          onToggleConsidered={pager.toggleConsidered}
        />

        {/* Replaces the per-slot hairline this panel used to show only while a
          slot was expanded — which meant a short slot, the common case, showed
          no progress at all (Trent, 2026-09-21: "I don't see any indication of
          progress, which is a little disappointing"). The bar is always on
          screen and covers every slot, so it answers that for the whole day
          rather than for whichever one happens to be open. */}
        <ReminderSlotBar
          items={pages}
          currentIndex={index}
          onJump={(next) => {
            pager.goTo(next)
            setPeekId(null)
          }}
        />

        <SlotPageBody
          group={page.group}
          label={page.label}
          expanded={expanded}
          showConsidered={showConsidered}
          onToggleExpanded={() => setExpanded(!expanded)}
          rowList={(rows) => (
            <PanelRowList
              rows={rows}
              expanded={expanded}
              label={page.label}
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
          onPutBack={(task) => void putBack(task)}
          onPutBackPrompt={(prompt) => void putBackPrompt(prompt)}
        />

        {editor.modal}
        {prompts.modal}
      </section>
      {tasksCard}
    </>
  )
}

/**
 * A slot page's body: its rows (reminders, then waiting quota prompts), what
 * was considered when the count is tapped, and "Show more".
 */
function SlotPageBody({
  group,
  label,
  expanded,
  showConsidered,
  onToggleExpanded,
  rowList,
  onPutBack,
  onPutBackPrompt,
}: {
  group: ReminderGroup
  label: string
  expanded: boolean
  showConsidered: boolean
  onToggleExpanded: () => void
  rowList: (rows: PanelSlotRow[]) => React.ReactNode
  onPutBack: (task: Task) => void
  onPutBackPrompt: (prompt: QuotaPrompt) => void
}) {
  const rows = slotRows(group)
  const count = rows.length
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
  return (
    <>
      {count === 0 ? (
        <p className="text-muted-foreground px-3 pb-3 text-sm">Nothing left here</p>
      ) : (
        rowList(visible)
      )}
      {showConsidered && groupConsidered(group) > 0 && (
        <ConsideredList
          items={group.consideredItems}
          prompts={group.prompts.filter((p) => !promptWaiting(p))}
          label={label}
          onPutBack={onPutBack}
          onPutBackPrompt={onPutBackPrompt}
        />
      )}
      {count - NARROW_CAP > 0 && (
        <RowCountToggle
          expanded={expanded}
          hiddenWhenNarrow={count - NARROW_CAP}
          hiddenWhenWide={count - WIDE_CAP}
          onToggle={onToggleExpanded}
        />
      )}
    </>
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
  // Settings → Priority Display, the task rows' own rule (2026-10-26) — as
  // on the /reminders row (`ReminderRow`), in this card's sizes.
  const pri = usePriorityRowStyles(reminder.priority)

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
          'hover:bg-foreground/5 relative cursor-pointer items-start gap-2.5 rounded-xl border border-transparent px-1 py-1.5 transition-colors select-none',
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
        {/* "Show right border": a bar on the right edge (`PriorityEdgeBar`). */}
        <PriorityEdgeBar bar={pri.bar} panel />
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
          // "Color checkbox": the task row's circle colours (this circle draws
          // no check mark, so only its border and hover).
          className={cn(
            'flex size-[19px] shrink-0 cursor-pointer items-center justify-center rounded-full border-[1.5px] transition-colors',
            pri.check
              ? cn(pri.check.checkbox, pri.check.checkboxHover)
              : 'border-foreground/25 hover:border-foreground/60 hover:bg-foreground/5',
          )}
        />
        {/* NEVER TRUNCATED. Trent, 2026-09-21: "reminders can't be truncated.
            They have to show the full thing... It needs to line wrap somehow."
            Half a thought prompts nothing — the same reason the iOS widget
            gives its rows two lines instead of one. The cap above still counts
            ITEMS rather than lines, so a slot of long thoughts is simply a
            taller panel; accepted deliberately ("maybe we should just not care
            about it") over a height-based cap, which would make the number of
            visible rows change with the length of their text. */}
        <p
          data-row-title
          className={cn('min-w-0 flex-1 text-[13.5px] leading-[1.42] text-pretty', pri.title)}
        >
          {reminder.title}
          {/* "Show priority indicator": the tab, inline (`ReminderRow`). */}
          <InlinePriorityTab tab={pri.tab} />
          {/* The Reminders surface's own notes mark (2026-09-25): without it
              the only way to learn a thought had a note was to hold it. */}
          {!!reminder.notes?.trim() && <NotesMarker />}
        </p>
      </li>
    </ReminderRowPopover>
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
 * back. Handled quota prompts follow the reminders (2026-09-25), their filled
 * dashed circle putting them back the same way (`ConsideredPromptRow`). No press-and-hold, no editor — a considered thought is done with, and
 * the put-back is how you change your mind. (On `/reminders`, where a longer
 * sitting happens, those rows DO reach the editor; this panel is a glance.)
 */
function ConsideredList({
  items,
  prompts,
  label,
  onPutBack,
  onPutBackPrompt,
}: {
  items: Task[]
  prompts: QuotaPrompt[]
  label: string
  onPutBack: (task: Task) => void
  onPutBackPrompt: (prompt: QuotaPrompt) => void
}) {
  return (
    <ul className="space-y-0.5 px-2 pb-1" aria-label={`Considered in ${label}`}>
      {items.map((reminder) => (
        <li
          key={reminder.id}
          data-considered-id={reminder.id}
          className="flex items-start gap-2.5 rounded-xl border border-transparent px-1 py-1.5"
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
      {prompts.map((prompt) => (
        <ConsideredPromptRow
          key={prompt.prompt_key}
          prompt={prompt}
          variant="panel"
          onPutBack={onPutBackPrompt}
        />
      ))}
    </ul>
  )
}
