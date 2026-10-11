'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, CheckCheck, ChevronLeft, ChevronRight, Forward } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatClockTime } from '@/lib/time-utils'
import { slotGroupKey, slotLabel } from '@/lib/reminder-slots'
import { slotHasStarted } from '@/lib/reminders-summary'
import {
  naturalPageIndex,
  naturalSlotIndex,
  pageAfterFinishing,
  type TimeSlot,
} from '@/lib/time-slot-assign'
import { useReminders, type ReminderGroup, type UseRemindersReturn } from '@/hooks/useReminders'
import { useTaskSegments, type SegmentView, type TaskSegmentActions } from '@/hooks/useTaskSegments'
import { useLongPress } from '@/hooks/useLongPress'
import { ReminderDetailModal } from '@/components/ReminderDetailModal'
import { ReminderRowPopover } from '@/components/ReminderRowPopover'
import { ReminderSlotBar } from '@/components/ReminderSlotBar'
import { NotesMarker } from '@/components/NotesMarker'
import { ConsideredPromptRow, usePromptRows } from '@/components/QuotaPromptRow'
import {
  ConsideredSegmentRow,
  SegmentNudge,
  TaskSegmentRow,
  handledRows,
  segmentCounts,
  segmentHint,
  segmentKey,
  segmentLabel,
  waitingRows,
} from '@/components/TaskSegmentRow'
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
 * screens). Wide has its own column beside the day and costs it nothing —
 * so its cap went from 9 to 20 (Trent, 2026-09-28: "let's try to get rid of
 * the 'Show more' and 'Less' for the desktop version … show up to 20 items on
 * the desktop before it shows 'Show more'").
 */
const WIDE_CAP = 20
const NARROW_CAP = 5

/**
 * The row's press-and-hold editor: `ReminderDetailModal`, wired to the exact
 * same writes `RemindersView`'s own Details editor uses for a single
 * reminder — `saveReminderDetail` (same toast, same Undo, same `ai-failed`
 * rule), and `useReminders`'
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
 * One page of the pager: a slot, or a TASK SEGMENT (2026-10-11).
 *
 * Trent: "why isn't tasks segmented like reminders? days, weeks, etc. should
 * be individual segments and behave similarly to the segments for reminders."
 * So each task segment with a row today is a page AFTER the last slot — its
 * own bar in the strip, the same chevrons, the same header and "X of Y" (the
 * tap that shows what was considered, with put-back) — where it used to be a
 * card stacked under the pager. Everything index-based here (the chevrons,
 * the bar, the finishing move, the natural page) walks this one list.
 *
 * `waiting`/`considered`/`total` are a page's numbers as the header and the
 * bar read them. For a task segment "considered" is what was handled today —
 * considered or deferred — the segment's own "X of Y" (`segmentCounts`).
 */
type PanelPage =
  | {
      kind: 'slot'
      key: string
      label: string
      hint: string | null
      group: ReminderGroup
      waiting: number
      considered: number
      total: number
      started: boolean
    }
  | {
      kind: 'tasks'
      key: string
      label: string
      hint: string
      segment: SegmentView
      waiting: number
      considered: number
      total: number
      started: true
    }

/**
 * The pages in pager order: the slots (only when the day has any reminder at
 * all — an empty day of slots is nothing to page through), then each task
 * segment with a row today, in screen order (days → eventually).
 */
function buildPages(
  groups: ReminderGroup[],
  segments: SegmentView[],
  timezone: string,
  now: Date,
): { pages: PanelPage[]; slotCount: number } {
  const hasAnything = groups.some((g) => groupWaiting(g) > 0 || groupConsidered(g) > 0)
  const slots: PanelPage[] = hasAnything
    ? groups.map((group) => {
        const waiting = groupWaiting(group)
        const considered = groupConsidered(group)
        return {
          kind: 'slot' as const,
          key: slotGroupKey(group),
          label: slotLabel(group),
          hint: group.slot ? formatClockTime(group.slot.start_time) : null,
          group,
          waiting,
          considered,
          total: waiting + considered,
          started: slotHasStarted(group.slot, timezone, now),
        }
      })
    : []
  const tasks: PanelPage[] = segments.map((segment) => {
    const { handled, total } = segmentCounts(segment)
    return {
      kind: 'tasks' as const,
      key: segmentKey(segment),
      label: segmentLabel(segment),
      hint: segmentHint(segment),
      segment,
      waiting: segment.waiting,
      considered: handled,
      total,
      started: true as const,
    }
  })
  return { pages: [...slots, ...tasks], slotCount: slots.length }
}

/**
 * What changed about the page on screen since the last render, and whether
 * that was finishing it: the new `seen` to record (null when nothing changed)
 * and the page key to move to, if finishing it means moving on.
 *
 * A finished TASK page with nowhere to go pins itself (`to` = its own key):
 * the natural page can be a task segment (`naturalPageIndex`), and once it is
 * finished the natural page moves back to the slot, which would yank the
 * pager away from the "3 of 3 ✓" just earned. A finished slot needs no pin:
 * the natural slot does not depend on what is waiting.
 */
function afterFinishing(
  seen: { key: string; waiting: number } | null,
  pages: PanelPage[],
  index: number,
  slotCount: number,
  naturalSlot: number,
): { seen: { key: string; waiting: number }; to: string | null } | null {
  const page = pages[index]
  if (seen?.key === page.key && seen.waiting === page.waiting) return null
  const finished = seen?.key === page.key && seen.waiting > 0 && page.waiting === 0
  const target = finished
    ? pageAfterFinishing(
        pages.map((p) => p.waiting),
        slotCount,
        index,
        naturalSlot,
      )
    : null
  const landing = pages[target ?? index]
  const pin = finished && target === null && page.kind === 'tasks'
  return {
    seen: { key: landing.key, waiting: landing.waiting },
    to: target !== null ? landing.key : pin ? page.key : null,
  }
}

/**
 * The pager's state: which page is on screen, which pages are uncapped, and
 * whether the page's considered rows are showing.
 */
function usePanelPager(pages: PanelPage[], slotCount: number, naturalSlot: number) {
  // The chevron override, by page key rather than index: pages can reorder or
  // shrink on a refresh, and a key survives that where an index wouldn't.
  const [overrideKey, setOverrideKey] = useState<string | null>(null)
  // Per-page uncapped state — a Set so paging away and back remembers it.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  // The page on screen and how many were waiting in it at the last render —
  // how finishing it is told apart from paging to one already finished. See
  // `pageAfterFinishing`.
  const [seen, setSeen] = useState<{ key: string; waiting: number } | null>(null)
  // Whether this page's already-considered rows are showing. Per-page, and
  // reset by paging, because "what did I already do here" is a question about
  // one page rather than a mode the panel sits in.
  const [showConsidered, setShowConsidered] = useState(false)
  if (pages.length === 0) return null

  const natural = naturalPageIndex(
    pages.map((p) => p.waiting),
    slotCount,
    naturalSlot,
  )
  const overrideIndex = overrideKey ? pages.findIndex((p) => p.key === overrideKey) : -1
  const index = overrideIndex >= 0 ? overrideIndex : natural
  const page = pages[index]

  // FINISHING A PAGE MOVES THE PAGER TO THE EARLIEST UNDONE ONE (Trent,
  // 2026-09-22, refined 2026-09-23 — see `pageAfterFinishing` for the rule;
  // task segments come after the slots since 2026-10-11). Only a page that
  // went from something waiting to nothing, while on screen, counts: paging
  // to one that was already done leaves you there to look at it. Last
  // check-off, "Considered all" and "Defer all" all qualify. Set during
  // render, not in an effect, so the emptied page is never painted before the
  // move.
  const move = afterFinishing(seen, pages, index, slotCount, naturalSlot)
  if (move) {
    setSeen(move.seen)
    if (move.to) {
      setOverrideKey(move.to)
      if (move.to !== page.key) setShowConsidered(false)
    }
  }

  const goTo = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= pages.length) return
    setOverrideKey(pages[nextIndex].key)
    setShowConsidered(false)
  }
  const expanded = expandedKeys.has(page.key)
  const setExpanded = (next: boolean) => {
    setExpandedKeys((prev) => {
      const copy = new Set(prev)
      if (next) copy.add(page.key)
      else copy.delete(page.key)
      return copy
    })
  }
  return {
    page,
    index,
    goTo,
    expanded,
    setExpanded,
    showConsidered,
    toggleConsidered: () => setShowConsidered((v) => !v),
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
  const { groups, complete, completeGroup, putBack, putBackPrompt, remove, refresh } = reminders
  const segments = useTaskSegments({
    segments: reminders.taskSegments,
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
  const { pages, slotCount } = buildPages(groups, segments.segments, timezone, now)
  const naturalSlot = slotCount > 0 ? naturalSlotIndex(groups, timezone, now) : 0
  const pager = usePanelPager(pages, slotCount, naturalSlot)
  // Nothing anywhere today — no reminder waiting or considered, no task
  // segment — nothing to show, the same way `TrackPanel` returns null with no
  // quotas.
  if (!pager) return null
  const { page, index, expanded, setExpanded, showConsidered } = pager

  return (
    <section
      aria-label="Reminders"
      data-reminders-panel
      data-reminders-slot={page.key}
      data-reminders-page={page.kind}
      data-task-segment={page.kind === 'tasks' ? page.segment.horizon : undefined}
      className="bg-muted/30 mb-6 overflow-hidden rounded-2xl"
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
        sweep={
          expanded ? (
            <PagerSweep
              page={page}
              onConsiderAll={(group) => void completeGroup(group)}
              onDeferAll={(segment) => void segments.deferAll(segment)}
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
          screen and covers every page — the slots, then the task segments —
          so it answers that for the whole day rather than for whichever one
          happens to be open. */}
      <ReminderSlotBar
        items={pages}
        currentIndex={index}
        onJump={(next) => {
          pager.goTo(next)
          setPeekId(null)
        }}
      />

      {page.kind === 'slot' ? (
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
      ) : (
        <TaskPageBody
          segment={page.segment}
          actions={segments}
          timezone={timezone}
          expanded={expanded}
          showConsidered={showConsidered}
          onToggleExpanded={() => setExpanded(!expanded)}
        />
      )}

      {editor.modal}
      {prompts.modal}
    </section>
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

/**
 * A task segment's page: the same body as a slot's, with the segment's rows
 * (circle = consider, Today, horizon chip, done square — the panel row
 * geometry), its considered and deferred rows behind the count with their
 * put-back, and the slot pages' row cap and "Show more".
 */
function TaskPageBody({
  segment,
  actions,
  timezone,
  expanded,
  showConsidered,
  onToggleExpanded,
}: {
  segment: SegmentView
  actions: TaskSegmentActions
  timezone: string
  expanded: boolean
  showConsidered: boolean
  onToggleExpanded: () => void
}) {
  const label = segmentLabel(segment)
  const rows = waitingRows(segment)
  const handled = handledRows(segment)
  const visible = expanded ? rows : rows.slice(0, WIDE_CAP)
  return (
    <>
      <SegmentNudge segment={segment} className="mx-3" />
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-3 pb-3 text-sm">Nothing left here</p>
      ) : (
        <ul className="space-y-0.5 px-2 pb-1" aria-label={label}>
          {visible.map((row, i) => (
            <TaskSegmentRow
              key={row.task.id}
              row={row}
              actions={actions}
              timezone={timezone}
              panel
              segmentHorizon={segment.horizon}
              hiddenWhenNarrow={!expanded && i >= NARROW_CAP}
            />
          ))}
        </ul>
      )}
      {showConsidered && handled.length > 0 && (
        <ul className="space-y-0.5 px-2 pb-1" aria-label={`Considered in ${label}`}>
          {handled.map((row) => (
            <ConsideredSegmentRow
              key={row.task.id}
              row={row}
              panel
              onPutBack={(task) => void actions.restore(task)}
            />
          ))}
        </ul>
      )}
      {rows.length - NARROW_CAP > 0 && (
        <RowCountToggle
          expanded={expanded}
          hiddenWhenNarrow={rows.length - NARROW_CAP}
          hiddenWhenWide={rows.length - WIDE_CAP}
          onToggle={onToggleExpanded}
        />
      )}
    </>
  )
}

/**
 * The header's sweep, in the place a slot has always had it: "Considered all"
 * on a slot, "Defer all" on a task segment (2026-10-11) — the segment's way to
 * clear today's list without considering each row. Only while the page is
 * expanded, like the slot's, and never when there is nothing to sweep.
 */
function PagerSweep({
  page,
  onConsiderAll,
  onDeferAll,
}: {
  page: PanelPage
  onConsiderAll: (group: ReminderGroup) => void
  onDeferAll: (segment: SegmentView) => void
}) {
  const slot = page.kind === 'slot'
  if (slot ? page.total === 0 : page.waiting === 0) return null
  return (
    <button
      type="button"
      onClick={() => (page.kind === 'slot' ? onConsiderAll(page.group) : onDeferAll(page.segment))}
      aria-label={
        slot
          ? `Mark all in ${page.label} as considered`
          : `Defer all ${page.waiting} in ${page.label}`
      }
      title={slot ? undefined : "Take the rest off today's list; they come back tomorrow"}
      className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-xs font-medium transition-colors"
    >
      {slot ? (
        <CheckCheck className="size-3.5" strokeWidth={2.5} />
      ) : (
        <Forward className="size-3.5" strokeWidth={2.5} />
      )}
      <span className="hidden sm:inline">{slot ? 'Considered all' : 'Defer all'}</span>
    </button>
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
 * Prev chevron / page name + time (a task segment: its hint) / count /
 * (Considered all or Defer all, expanded only) / next chevron — one row, mirroring the widget's own `ChevronPager` header
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
  sweep,
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
  /** "Considered all" on a slot, "Defer all" on a task segment (`PagerSweep`). */
  sweep: React.ReactNode
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
        <span className="min-w-0 flex-1 truncate">
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

      {sweep}

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
          className="border-foreground/25 hover:border-foreground/60 hover:bg-foreground/5 flex size-[19px] shrink-0 cursor-pointer items-center justify-center rounded-full border-[1.5px] transition-colors"
        />
        {/* NEVER TRUNCATED. Trent, 2026-09-21: "reminders can't be truncated.
            They have to show the full thing... It needs to line wrap somehow."
            Half a thought prompts nothing — the same reason the iOS widget
            gives its rows two lines instead of one. The cap above still counts
            ITEMS rather than lines, so a slot of long thoughts is simply a
            taller panel; accepted deliberately ("maybe we should just not care
            about it") over a height-based cap, which would make the number of
            visible rows change with the length of their text. */}
        <p className="min-w-0 flex-1 text-[13.5px] leading-[1.42] text-pretty">
          {reminder.title}
          {/* The Reminders surface's own notes mark (2026-09-25): without it
              the only way to learn a thought had a note was to hold it. */}
          {!!reminder.notes?.trim() && <NotesMarker />}
        </p>
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
