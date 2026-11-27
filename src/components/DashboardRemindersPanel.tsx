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
import { usePagerClock } from '@/hooks/usePagerClock'
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
import { saveReminderDetail, saveReminderDetailMany } from '@/lib/save-reminder-detail'
import { QueueSelectToggle } from '@/components/QueueSelect'
import { Checkbox } from '@/components/ui/checkbox'
import {
  useReminderCardSelection,
  useReminderCardSelectionState,
} from '@/components/ReminderCardSelection'
import { log } from '@/lib/logger'
import type { Task } from '@/types'
import type { PeekTextChanges } from '@/components/PeekText'
import { retapOrder } from '@/lib/retap-walk'
import {
  liftFirst,
  liftPageIndex,
  liftedId,
  resolvePromptKey,
  type PanelLift,
} from '@/lib/panel-lift'

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
 * - No create flow. (No SELECTION either until 2026-11-27, when Trent asked
 *   for it: a "Select" pill in the header now turns the page's rows into
 *   checkboxes, with /reminders' own bar — `ReminderCardSelection.tsx`.) A circle completes one reminder on a tap; press-and-hold opens that
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
 * - No leaving animation, and no ghost. A considered row leaves the list at
 *   once, here as on /reminders (2026-11-20: rows that held their place while
 *   they collapsed swallowed the taps of a fast run), so the row below is
 *   under the finger straight away. The accepted cost is that a fast
 *   double-tap on one circle can consider the row that slides up into its
 *   place; the toast's Undo is the recovery. /reminders also fades a ghost
 *   of the row over the spot (`src/lib/row-ghost.ts`); this card, made for a
 *   glance, does not.
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
/**
 * A stop of the Dashboard tab's re-tap walk while a period that has come
 * round still waits — the pager's own order (`retapOrder`).
 */
function periodNeedsYou(pages: { waiting: number }[], naturalSlot: number): boolean {
  return (
    retapOrder(
      pages.map((p) => p.waiting),
      pages.length,
      naturalSlot,
    ).length > 0
  )
}

/** The Tasks card under the Reminders card, with a segment row's editor (its peek's Open). */
function PanelTasksCard({
  segments,
  timezone,
  hydrated,
  onUndo,
  onCompleted,
}: {
  segments: ReturnType<typeof useTaskSegments>
  timezone: string
  hydrated: boolean
  onUndo: () => void
  onCompleted: () => void
}) {
  return (
    <>
      <DashboardTasksPanel
        actions={segments}
        timezone={timezone}
        hydrated={hydrated}
        onUndo={onUndo}
      />
      <SegmentDetailsModal actions={segments} onUndo={onUndo} onCompleted={onCompleted} />
    </>
  )
}

/**
 * Quota prompts (2026-09-24): the /reminders surface's own rows, compact. No
 * leaving animation here, like the reminder rows (see the docblock). In
 * select mode they are checkable like the reminder rows (2026-11-27).
 */
function usePanelPromptRows({
  reminders,
  select,
  liftState,
  onUndo,
  onCompleted,
}: {
  reminders: UseRemindersReturn
  select: ReturnType<typeof useReminderCardSelectionState>
  liftState: ReturnType<typeof usePanelLift>
  onUndo: () => void
  onCompleted: () => void
}) {
  const { considerPrompt, didPrompt, movePrompt, refresh } = reminders
  return usePromptRows({
    isSelectionMode: select.selecting,
    selectedIds: select.selectedIds,
    onSelect: (prompt) => select.pick(prompt.prompt_key),
    considerPrompt,
    didPrompt,
    movePrompt,
    refresh,
    onUndo,
    onCompleted,
    variant: 'panel',
    highlightKey: typeof liftState.flashId === 'string' ? liftState.flashId : null,
    onHighlightDone: liftState.clearFlash,
  })
}

/** The dashboard's handle on this card's refresh, while the card is mounted. */
function useRefreshRef(
  refreshRef: DashboardRemindersPanelProps['refreshRef'],
  refresh: () => Promise<void>,
) {
  useEffect(() => {
    refreshRef.current = () => void refresh()
    return () => {
      refreshRef.current = null
    }
  }, [refreshRef, refresh])
}

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
  // Details from the card's selection (2026-11-27): one or several.
  const openMany = useCallback((tasks: Task[]) => setEditing(tasks), [])

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
      // Several reminders from the card's selection: /reminders' bulk save.
      onSaveMany={(changes) => saveReminderDetailMany(changes, { onUndo, onCompleted, refresh })}
      // Never reached: this panel never passes `create`, so the new-reminder
      // path never mounts. Logged in case a future change breaks that.
      onCreate={async () => log.error('ui', 'DashboardRemindersPanel: unexpected create')}
      onConsidered={(tasks) => void completeMany(tasks)}
      onDelete={(tasks) => void remove(tasks)}
      onOpenPage={(id) => router.push(`/tasks/${id}`)}
    />
  )

  // The row bubble's title or note, edited in place (2026-11-22): the
  // editor's own write, its toast and Undo.
  const editText = useCallback(
    (task: Task, changes: PeekTextChanges) =>
      saveReminderDetail(task.id, changes, { source: [task], onUndo, onCompleted, refresh }),
    [onUndo, onCompleted, refresh],
  )

  return { open, openMany, modal, isOpen: editing.length > 0, editText }
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

/**
 * The Reminders card's pages and pager: the periods in the day's order, the
 * clock's period, and the card's state (`usePanelPager`).
 */
function useSlotPager({
  groups,
  timeSlots,
  timezone,
  blocked,
}: {
  groups: ReminderGroup[]
  timeSlots: TimeSlot[]
  timezone: string
  blocked: boolean
}) {
  const dayStart = useDayStart()
  // The card's clock (`usePagerClock`): React state that moves when a period
  // opens, the day turns or the app comes back. State, not `new Date()` in
  // the render: the React Compiler memoizes the pages on what they are made
  // from, and a wall clock read during render is not something it sees
  // change, so the card used to follow the clock only when its data changed.
  const { now, day, basis } = usePagerClock(
    timeSlots.map((s) => s.start_time),
    timezone,
    dayStart,
  )
  // In the day's order, so a slot before the day start is the last page.
  const dayGroups = orderGroupsByDay(groups, dayStart)
  const pages = buildSlotPages(dayGroups, timezone, now, dayStart)
  // The slots alone: the natural page is the clock's slot, and finishing one
  // goes to the earliest slot up to now still waiting (`pageAfterFinishing`
  // with every page a slot is `slotAfterFinishing`).
  const naturalSlot = pages.length > 0 ? naturalSlotIndex(dayGroups, timezone, now, dayStart) : 0
  const pager = usePanelPager(pages, pages.length, naturalSlot, {
    day,
    basis,
    blocked,
  })
  return { pages, naturalSlot, pager }
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
  /** A notification tap's lift (`src/lib/panel-lift.ts`); `seq` makes a second tap a new one. */
  lift?: { value: PanelLift; seq: number } | null
  /** Called once the lift is applied (`usePanelLiftLink`'s `consume`). */
  onLiftApplied?: (seq: number) => void
}

export function DashboardRemindersPanel({
  onUndo,
  onCompleted,
  refreshRef,
  timeSlots,
  timezone,
  lift = null,
  onLiftApplied,
}: DashboardRemindersPanelProps) {
  const reminders = useReminders({ onUndo, onCompleted, timeSlots, timezone })
  const { groups, complete, completeGroup, putBack, putBackPrompt, remove, refresh } = reminders
  const { moveForToday } = reminders
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
  const select = useReminderCardSelectionState()
  // A notification tap's row (src/lib/panel-lift.ts): first in its period
  // while it waits, and flashed once.
  const liftState = usePanelLift(lift, onLiftApplied)
  const prompts = usePanelPromptRows({ reminders, select, liftState, onUndo, onCompleted })
  // Which row's read-only bubble is open, if any. One id rather than a flag
  // per row: only ever one bubble at a time, the same way `TrackPanel` holds
  // a single `detailId` for its chips.
  const [peekId, setPeekId] = useState<number | null>(null)

  useRefreshRef(refreshRef, refresh)

  // A row's bubble, its editor, a prompt's bubble or editor, select mode: the card is held.
  const blocked = peekId !== null || editor.isOpen || prompts.busy || select.selecting
  const { pages, naturalSlot, pager } = useSlotPager({ groups, timeSlots, timezone, blocked })
  liftState.apply({ hydrated: reminders.hydrated, pages, pager })
  const selectBar = useReminderCardSelection({
    state: select,
    group: pager?.page.group ?? null,
    pageKey: pager?.page.key ?? null,
    reminders,
    timeSlots,
    timezone,
    openReminders: editor.openMany,
    openQuotas: (rows) => void prompts.openQuotas(rows),
  })
  const { lifted, flashId } = liftState
  const needsYou = periodNeedsYou(pages, naturalSlot)
  const tasksCard = (
    <PanelTasksCard
      segments={segments}
      timezone={timezone}
      hydrated={reminders.hydrated}
      onUndo={onUndo}
      onCompleted={onCompleted}
    />
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
        data-retap-stop
        data-needs-you={needsYou ? '' : undefined}
        {...pager.cardProps}
        // Closer to the Tasks card beneath it, so the two read as a pair.
        className={cn(
          'bg-muted/30 scroll-below-header overflow-hidden rounded-2xl',
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
          // all shows only while the panel has waiting rows) — the card open
          // or not (Trent, 2026-11-12).
          // Select sits on the actions line, left of Consider all (2026-11-27,
          // the design session): in the header row on a wide card, on the line
          // under it on a narrow one, so the header stays one line at a phone;
          // with nothing waiting the line, and Select, are gone.
          sweep={
            select.selecting ? (
              // Selecting: Select alone, to turn it off (the bar has the verbs),
              // as on the Task queue card.
              <QueueSelectToggle on onToggle={select.toggleMode} />
            ) : page.waiting > 0 ? (
              <>
                <span className="mr-1 flex items-center">
                  <QueueSelectToggle on={false} onToggle={select.toggleMode} />
                </span>
                <PagerSweep
                  kind="consider"
                  ariaLabel={`Consider all in ${page.label}`}
                  onClick={() => void completeGroup(page.group)}
                />
              </>
            ) : null
          }
          // The gaps give way so "EARLY MORNING · 7:00 AM" stays on one line
          // at a 402 phone and the app's 119% text (Trent, 2026-10-31; the
          // TASK QUEUE header's fix).
          compact
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
          lifted={lifted}
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
              flashId={flashId}
              onFlashDone={liftState.clearFlash}
              onComplete={(reminder) => void complete(reminder)}
              onRemove={(task) => void remove([task])}
              onOpenEditor={editor.open}
              onEditText={editor.editText}
              selecting={select.selecting}
              selectedIds={select.selectedIds}
              onPick={select.pick}
              renderPrompt={prompts.renderPrompt}
              slot={page.group.slot}
              onMoveForToday={(task, to) => void moveForToday([task], [], to)}
              timeSlots={timeSlots}
              timezone={timezone}
            />
          )}
          onPutBack={(task) => void putBack(task)}
          onPutBackPrompt={(prompt) => void putBackPrompt(prompt)}
        />

        {editor.modal}
        {prompts.modal}
        {selectBar.bar}
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
  lifted,
  label,
  expanded,
  showConsidered,
  onToggleExpanded,
  rowList,
  onPutBack,
  onPutBackPrompt,
}: {
  group: ReminderGroup
  /** A notification tap's row: drawn first while it waits (`liftFirst`). */
  lifted: number | string | null
  label: string
  expanded: boolean
  showConsidered: boolean
  onToggleExpanded: () => void
  rowList: (rows: PanelSlotRow[]) => React.ReactNode
  onPutBack: (task: Task) => void
  onPutBackPrompt: (prompt: QuotaPrompt) => void
}) {
  const rows = liftFirst(slotRows(group), lifted)
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
  flashId,
  onFlashDone,
  onComplete,
  onRemove,
  onOpenEditor,
  onEditText,
  selecting,
  selectedIds,
  onPick,
  renderPrompt,
  slot,
  onMoveForToday,
  timeSlots,
  timezone,
}: {
  rows: PanelSlotRow[]
  expanded: boolean
  label: string
  peekId: number | null
  setPeekId: (id: number | null) => void
  /** The reminder a notification tap flashes (a prompt's flash is `usePromptRows`'). */
  flashId: number | string | null
  onFlashDone: () => void
  onComplete: (reminder: Task) => void
  onRemove: (reminder: Task) => void
  onOpenEditor: (reminder: Task) => void
  /** A bubble's title or note edited in place. */
  onEditText: (reminder: Task, changes: PeekTextChanges) => Promise<unknown>
  /** Select mode (`ReminderCardSelection.tsx`): rows are checkboxes. */
  selecting: boolean
  selectedIds: Set<number | string>
  onPick: (id: number) => void
  renderPrompt: (prompt: QuotaPrompt, extra: { hiddenWhenNarrow?: boolean }) => React.ReactNode
  /** The slot on screen — where its reminders are today (a moved one included). */
  slot: TimeSlot | null
  /** A bubble's Today chip (`useReminders().moveForToday`). */
  onMoveForToday: (reminder: Task, to: TimeSlot) => void
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
            highlighted={flashId === reminder.id}
            onHighlightDone={onFlashDone}
            onComplete={() => onComplete(reminder)}
            onPeek={() => setPeekId(reminder.id)}
            peekOpen={peekId === reminder.id}
            onPeekChange={(next) => setPeekId(next ? reminder.id : null)}
            onDelete={(task) => {
              setPeekId(null)
              onRemove(task)
            }}
            onEditText={onEditText}
            selection={
              selecting
                ? { selected: selectedIds.has(reminder.id), onToggle: () => onPick(reminder.id) }
                : null
            }
            onOpenEditor={(task) => {
              // The bubble is done the moment the editor takes over —
              // leaving it open would stack a popover behind a dialog.
              setPeekId(null)
              onOpenEditor(task)
            }}
            slot={slot}
            onMove={(task, to) => {
              // The row leaves this slot: its bubble goes first.
              setPeekId(null)
              onMoveForToday(task, to)
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
  highlighted = false,
  onHighlightDone,
  onComplete,
  onPeek,
  peekOpen,
  onPeekChange,
  onOpenEditor,
  onDelete,
  onEditText,
  selection,
  slot,
  onMove,
  timeSlots,
  timezone,
}: {
  reminder: Task
  /** Select mode: a tap or the box picks the row; no consider, no bubble. */
  selection: { selected: boolean; onToggle: () => void } | null
  /** Past the narrow cap: in the DOM, but only on screen from `xl` up. */
  hiddenWhenNarrow?: boolean
  /** A notification tap's row: flashes once (`.animate-row-highlight`). */
  highlighted?: boolean
  onHighlightDone?: () => void
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
  /** The bubble's title or note, edited in place. */
  onEditText: (reminder: Task, changes: PeekTextChanges) => Promise<unknown>
  /** The period the row is in today, and the bubble's Today chips. */
  slot: TimeSlot | null
  onMove: (reminder: Task, to: TimeSlot) => void
  timeSlots: TimeSlot[]
  timezone: string
}) {
  // In select mode a hold opens nothing: the tap picks the row.
  const press = useLongPress({ onLongPress: selection ? () => {} : onPeek })
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
      onEdit={onEditText}
      slot={slot}
      onMove={onMove}
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
        data-reminder-highlight={highlighted ? '' : undefined}
        // Select mode: an option of the page's list, as a prompt row is.
        role={selection ? 'option' : undefined}
        aria-selected={selection ? selection.selected : undefined}
        className={cn(
          'hover:bg-foreground/5 relative cursor-pointer items-start gap-2.5 rounded-xl border border-transparent px-1 py-1.5 transition-colors select-none',
          hiddenWhenNarrow ? 'hidden xl:flex' : 'flex',
          highlighted && 'animate-row-highlight',
          selection?.selected && 'bg-foreground/[0.07] border-foreground/15',
        )}
        onAnimationEnd={(e) => {
          // The flash has played: spend it, so a re-render can't replay it.
          if (highlighted && e.target === e.currentTarget) onHighlightDone?.()
        }}
        onClick={(e) => {
          if (press.didFire()) {
            e.preventDefault()
            return
          }
          if ((e.target as HTMLElement).closest('button')) return
          if (selection) selection.onToggle()
          else onComplete()
        }}
        onPointerDown={press.onPointerDown}
        onPointerUp={press.onPointerUp}
        onPointerMove={press.onPointerMove}
        onPointerLeave={press.onPointerLeave}
        onPointerCancel={press.onPointerUp}
      >
        {/* "Show right border": a bar on the right edge (`PriorityEdgeBar`). */}
        <PriorityEdgeBar bar={pri.bar} panel />
        {selection ? (
          <Checkbox
            checked={selection.selected}
            onCheckedChange={selection.onToggle}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={`Select "${reminder.title}"`}
            className="size-[19px] shrink-0 cursor-pointer"
          />
        ) : (
          <button
            type="button"
            onClick={onComplete}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={`Mark "${reminder.title}" as considered`}
            title="Consider"
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
        )}
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

/** Whether a group still has this row waiting: a reminder's id or a waiting prompt's key. */
function isWaitingIn(group: ReminderGroup, id: number | string): boolean {
  if (typeof id === 'number') return group.reminders.some((r) => r.id === id)
  return group.prompts.some((p) => p.prompt_key === id && promptWaiting(p))
}

/**
 * A notification tap's lift (src/lib/panel-lift.ts), applied once the card's
 * data is in: page to its period, and (a reminder or a prompt) lift and flash
 * its row. Each tap is applied once (`seq`), so a refresh can't page the card
 * back after the user paged away. A row that no longer waits (handled since
 * the push) still pages to its period when the period holds it handled, with
 * nothing lifted. Returns the lifted row's id (a reminder id or a prompt key).
 * Applied during render, not in an effect, so the card never paints the
 * natural page first and then jumps.
 *
 * The lift ends when its row stops waiting (considered, done, deleted): it is
 * back in its own place, and an Undo that brings it back doesn't lift it
 * again. Adjusted during render, as `usePanelPager` moves its page, so the
 * row never paints first after it has gone.
 */
function usePanelLift(
  lift: { value: PanelLift; seq: number } | null,
  onApplied?: (seq: number) => void,
) {
  const [lifted, setLifted] = useState<number | string | null>(null)
  const [flashId, setFlashId] = useState<number | string | null>(null)
  const [appliedSeq, setAppliedSeq] = useState<number | null>(null)
  // Tell the link it's spent (a module store: not during render).
  useEffect(() => {
    if (appliedSeq !== null) onApplied?.(appliedSeq)
  }, [appliedSeq, onApplied])
  /** Called during render, once the card's pages and pager are known. */
  const apply = ({
    hydrated,
    pages,
    pager,
  }: {
    hydrated: boolean
    pages: SlotPage[]
    pager: { goTo: (index: number) => void } | null
  }) => {
    if (lifted !== null && hydrated && !pages.some((p) => isWaitingIn(p.group, lifted))) {
      setLifted(null)
    }
    if (!lift || !hydrated || !pager || appliedSeq === lift.seq) return
    setAppliedSeq(lift.seq)
    // A prompt key from another day names today's row (`resolvePromptKey`).
    const value: PanelLift =
      lift.value.kind === 'prompt'
        ? {
            kind: 'prompt',
            key:
              resolvePromptKey(
                pages.map((p) => p.group),
                lift.value.key,
                promptWaiting,
              ) ?? lift.value.key,
          }
        : lift.value
    const at = liftPageIndex(pages, value, promptWaiting)
    const id = liftedId(value)
    if (at >= 0) {
      pager.goTo(at)
      setLifted(id)
      setFlashId(id)
      return
    }
    // Handled since the push: its period, nothing lifted.
    const handledAt = pages.findIndex((p) =>
      typeof id === 'number'
        ? p.group.consideredItems.some((r) => r.id === id)
        : p.group.prompts.some((x) => x.prompt_key === id),
    )
    if (id !== null && handledAt >= 0) pager.goTo(handledAt)
  }
  return { apply, lifted, flashId, clearFlash: () => setFlashId(null) }
}
