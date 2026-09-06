'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, CheckCheck, ChevronDown, ChevronRight, Lightbulb, StickyNote } from 'lucide-react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { currentSlot, parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import { summarizeReminders, type RemindersSummary } from '@/lib/reminders-summary'
import { cadenceMark, slotAtMinutes } from '@/lib/reminder-rule'
import { saveTaskChanges } from '@/lib/save-task-changes'
import { showToast } from '@/lib/toast'
import { useReminders, type ReminderCreateInput, type ReminderGroup } from '@/hooks/useReminders'
import { useSelectionMode } from '@/hooks/useSelectionMode'
import { useTimeSlots } from '@/hooks/useTimeSlots'
import { useTimezone } from '@/hooks/useTimezone'
import { useSyncStream } from '@/hooks/useSyncStream'
import { ReminderSelectionBar } from '@/components/ReminderSelectionBar'
import { ReminderDetailModal } from '@/components/ReminderDetailModal'
import { QuickAdd } from '@/components/QuickAdd'
import type { ReminderBulkChanges, ReminderCreateDraft } from '@/components/ReminderDetail'
import { ConsiderAllDialog, useConsiderAll } from '@/components/ConsiderAllDialog'
import type { QuickActionPanelChanges } from '@/components/QuickActionPanel'
import type { Task } from '@/types'

/**
 * The Reminders surface (REDESIGN-V03 §6).
 *
 * Prompted thoughts — principles and considerations, "thoughts to have at the
 * right moment". They are not tasks, and this surface exists so they do not
 * LOOK like tasks: no due chip, no overdue styling, no snooze affordance. A row
 * is a circle and a sentence.
 *
 * How the screen stays "a handful" at any corpus size (the founding constraint:
 * the harness adapts to the scale, the user does not prune):
 *
 * 1. **The headline is "waiting so far", not the pile.** Trent's definition
 *    (2026-09-04): everything still waiting in a slot that has already
 *    started today, plus Anytime. The same number sits on the nav badge, and
 *    one tap — "Considered all so far" — clears exactly it. Later slots are
 *    named, not counted against him.
 * 2. **Each time slot is a container** with its own "Considered all"; only the
 *    current slot opens by default, the rest fold to a header with a badge:
 *    accent while the slot has started and holds something, muted "later"
 *    before its time.
 * 3. **Inside an open slot: the first five, then "Show all N".**
 * 4. **Progress fills, it never scolds.** A bar per slot and one for the day
 *    show what has been considered so far today (his add: "satisfying to get
 *    through all the reminders"). It only ever counts what he did — a bar that
 *    filled with misses would read intent from absence (L1).
 *
 * Selection works exactly as it does on the dashboard, on purpose: plain click
 * selects, shift-click a range, cmd/ctrl-click adds, Escape clears; the same
 * floating bar appears with the verbs that apply. A row click never navigates.
 *
 * Completed items leave immediately, and a slot that never had anything today
 * is not shown (on this surface there is no day to read, only thoughts still
 * waiting) — but a slot that has been fully considered stays as a full bar,
 * because that is the satisfying part.
 */

/** Un-slotted reminders (no anchor_time and no due time) group under this label. */
const UNSLOTTED_LABEL = 'Anytime'

/** How many rows an open slot shows before "Show all" — matches the dashboard (§7.3). */
const SLOT_PREVIEW_COUNT = 5

interface RemindersViewProps {
  /** Undo the last action — wired to the completion toast. */
  onUndo: () => void
  /** Called after a completion, so the page can keep its own undo counter in step. */
  onCompleted?: () => void
  /**
   * Registers this surface's refetch with the page, so an event that changes
   * reminders elsewhere (the sync stream, an undo) can refresh it. Without it an
   * undone completion would stay invisible until a reload.
   */
  refreshRef?: React.MutableRefObject<(() => void) | null>
  /**
   * Narrow the surface to thoughts matching this text. Filtering happens here,
   * on data the surface already holds, rather than through the API the Tasks
   * page uses: every active reminder is already on the client (today's slots,
   * what has been considered today, and the Not today fold together are all of
   * them), so results appear as fast as the user types.
   */
  searchQuery?: string
}

/** Stable identity for a group across refetches — slot id, or the un-slotted bucket. */
function groupKey(group: ReminderGroup): string {
  return group.slot ? String(group.slot.id) : 'unslotted'
}

export function RemindersView({
  onUndo,
  onCompleted,
  refreshRef,
  searchQuery,
}: RemindersViewProps) {
  const timezone = useTimezone()
  // Held for the details editor's slot chips (so opening one never waits on a
  // fetch) and for placing a new reminder in its slot at once.
  const { timeSlots } = useTimeSlots()
  const {
    groups,
    total,
    hasAny,
    loading,
    error,
    completingIds,
    consideredAny,
    complete,
    completeMany,
    completeGroup,
    putBack,
    remove,
    refresh,
    notToday,
    create,
  } = useReminders({ onUndo, onCompleted, timeSlots, timezone })
  const router = useRouter()
  const selection = useSelectionMode()
  const { selectedIds, clear } = selection

  // Searching narrows what is rendered; it deliberately does NOT touch which
  // slots the user has open. Both `defaultOpenKey` and `useSlotDisclosure`
  // derive from `visibleGroups`, so filtering upstream would rearrange the
  // user's disclosure state and leave it rearranged after the search cleared.
  // Instead every slot holding a match renders open and whole for the duration
  // of the query, and the moment it clears the surface is exactly as it was.
  const query = (searchQuery ?? '').trim().toLowerCase()
  const searching = query.length > 0
  const matchesQuery = useCallback(
    // Title and notes, case-insensitive substring — the same fields and the
    // same semantics as the Tasks page's search, so the two agree about what
    // "matches" means.
    (task: Task) =>
      task.title.toLowerCase().includes(query) || (task.notes ?? '').toLowerCase().includes(query),
    [query],
  )
  const searchGroups = useMemo(() => {
    if (!searching) return []
    return groups
      .map((group) => ({
        ...group,
        reminders: group.reminders.filter(matchesQuery),
        consideredItems: group.consideredItems.filter(matchesQuery),
      }))
      .filter((group) => group.reminders.length > 0 || group.consideredItems.length > 0)
  }, [groups, searching, matchesQuery])
  const searchNotToday = useMemo(
    () => (searching ? notToday.filter(matchesQuery) : []),
    [notToday, searching, matchesQuery],
  )
  const searchSummary = useMemo(
    () => summarizeReminders(searchGroups, timezone),
    [searchGroups, timezone],
  )
  const resultCount =
    searchGroups.reduce((n, g) => n + g.reminders.length + g.consideredItems.length, 0) +
    searchNotToday.length

  // A selection made before the query no longer corresponds to what is on
  // screen, exactly as on the Tasks page.
  useEffect(() => {
    clear()
  }, [query, clear])

  // The surface listens for enrichment finishing because the quick add hands
  // what was typed to the AI: a thought added to Afternoon can legitimately
  // move to Evening a second or two later, and a row that relocates with no
  // explanation reads as a bug. The toast is the explanation.
  // Reminders this surface just handed to enrichment, mapped to the words the
  // user typed. The sync stream carries every enrichment for the user, including
  // tasks added on another device, and a toast about one of those here would be
  // about something not on this screen. The original text is kept so a rewrite
  // of the wording can be announced when the schedule did not move.
  const awaitingEnrichment = useRef<Map<number, string>>(new Map())

  useSyncStream({
    onSync: () => void refresh(),
    onEnrichmentComplete: (data) => {
      void refresh()
      const typed = awaitingEnrichment.current.get(data.taskId)
      if (typed === undefined) return
      awaitingEnrichment.current.delete(data.taskId)
      // What to say is what changed. A moved schedule is the description; if the
      // schedule held and only the wording was cleaned up, the new wording is
      // the news. When neither moved there is nothing to report, and a toast
      // would be noise about a change the user cannot see.
      //
      // "Cleaned up" is compared loosely on purpose: the model capitalizes the
      // first letter of almost everything, so a strict comparison would
      // announce a rewrite on nearly every add.
      const reworded =
        data.title !== undefined && normalizeWording(data.title) !== normalizeWording(typed)
      const message = data.description ?? (reworded ? `Reworded: ${data.title}` : null)
      if (!message) return
      showToast({
        message,
        type: 'success',
        action: { label: 'Undo', onClick: onUndo },
        id: `reminder-created-${data.taskId}`,
      })
    },
  })

  useEffect(() => {
    if (!refreshRef) return
    refreshRef.current = () => void refresh()
    return () => {
      refreshRef.current = null
    }
  }, [refreshRef, refresh])

  // A slot shows while it has something waiting OR something considered today
  // (a full bar is worth seeing); a slot with neither is noise.
  const visibleGroups = useMemo(
    () => groups.filter((g) => g.reminders.length > 0 || g.considered > 0),
    [groups],
  )
  const summary = useMemo(
    () => summarizeReminders(visibleGroups, timezone),
    [visibleGroups, timezone],
  )

  // Which slot opens by default: the current one if it has anything waiting,
  // otherwise the first with something waiting.
  const defaultOpenKey = useMemo(() => {
    const withWaiting = visibleGroups.filter((g) => g.reminders.length > 0)
    const slots = withWaiting.flatMap((g) => (g.slot ? [g.slot] : []))
    const now = currentSlot(slots, timezone)
    if (now) return String(now.id)
    return withWaiting.length > 0 ? groupKey(withWaiting[0]) : null
  }, [visibleGroups, timezone])

  const { isOpen, toggleOpen, expandedKeys, setExpanded } = useSlotDisclosure(defaultOpenKey)

  // Rows actually rendered, in DOM order — the universe for range selection.
  const renderedRows = useMemo(() => {
    // While searching every match is on screen, so range selection spans all
    // of them rather than the usual open-and-expanded subset.
    if (searching) return searchGroups.flatMap((group) => group.reminders)
    return visibleGroups.flatMap((group) => {
      const key = groupKey(group)
      if (!isOpen(key)) return []
      return expandedKeys.has(key) ? group.reminders : group.reminders.slice(0, SLOT_PREVIEW_COUNT)
    })
  }, [searching, searchGroups, visibleGroups, isOpen, expandedKeys])
  const orderedIds = useMemo(() => renderedRows.map((r) => r.id), [renderedRows])
  const selectedTasks = useMemo(
    () => renderedRows.filter((r) => selectedIds.has(r.id)),
    [renderedRows, selectedIds],
  )

  const actions = useReminderActions({
    selection,
    orderedIds,
    selectedTasks,
    startedGroups: summary.started,
    complete,
    completeMany,
    completeGroup,
    remove,
  })
  // Both sweep buttons confirm first (Trent, 2026-09-05); single and selected
  // considerations do not.
  const considerAll = useConsiderAll(actions, UNSLOTTED_LABEL)

  // Details opens the reminder's own editor in a dialog (a sheet on a phone)
  // rather than leaving for the task page; several selected edit their
  // schedule together. The tasks are snapshotted here at open time — see
  // ReminderDetailModal for why they must not track the groups.
  const [detailTasks, setDetailTasks] = useState<Task[]>([])
  const [createDraft, setCreateDraft] = useState<ReminderCreateDraft | null>(null)
  const openDetail = useCallback((task: Task) => setDetailTasks([task]), [])
  const openCreate = useCallback((title = '') => {
    setDetailTasks([])
    setCreateDraft({ title })
  }, [])
  const closeDetail = useCallback(() => {
    setDetailTasks([])
    setCreateDraft(null)
  }, [])

  // The sidebar's Add Reminder and the phone's plus (AppLayout) ask this
  // surface to open its own form, rather than leaving for the task form.
  useEffect(() => {
    const handler = () => openCreate('')
    window.addEventListener('open-add-reminder', handler)
    return () => window.removeEventListener('open-add-reminder', handler)
  }, [openCreate])

  /**
   * Creating: the quick add makes a daily thought in the slot that is current
   * right now (else the first slot), and it is on screen the moment the server
   * answers. That default is also a fallback — the quick add sets `enrich`, so
   * the text goes to AI enrichment, which reads any cadence or time of day the
   * user actually said ("every Friday evening") and rewrites the schedule,
   * snapping it to one of their slots. The form does not enrich: there the user
   * picked the schedule by hand. Undo is the ordinary one.
   */
  const dailyIn = useCallback(
    (slots: TimeSlot[]): string => {
      const slot = currentSlot(slots, timezone) ?? slots[0]
      const minutes = (slot ? parseHHMM(slot.start_time) : null) ?? 9 * 60
      return `FREQ=DAILY;BYHOUR=${Math.floor(minutes / 60)};BYMINUTE=${minutes % 60}`
    },
    [timezone],
  )
  const createReminder = useCallback(
    async (input: ReminderCreateInput) => {
      try {
        const task = await create(input)
        if (input.enrich) awaitingEnrichment.current.set(task.id, input.title)
        const slot = task.anchor_time ? slotAtMinutes(parseHHMM(task.anchor_time), timeSlots) : null
        showToast({
          message: slot ? `Added to ${slot.label}` : `Added \u201c${task.title}\u201d`,
          type: 'success',
          action: { label: 'Undo', onClick: onUndo },
          // Shared with the enrichment toast below: when the AI moves a
          // just-added thought to another slot, that news REPLACES "Added to
          // Afternoon" instead of stacking a second toast that contradicts it.
          id: `reminder-created-${task.id}`,
        })
      } catch (err) {
        showToast({
          message: err instanceof Error && err.message ? err.message : 'Could not add the reminder',
          type: 'error',
        })
        throw err
      }
    },
    [create, timeSlots, onUndo],
  )
  const quickAdd = useCallback(
    async (title: string) => {
      // The slots arrive on their own fetch, and this box is live before it
      // lands — typing that fast is rare but reachable on a cold load. Guessing
      // a time of day with the slots unknown would drop the thought at 9am,
      // which may not even be a slot this user has, so wait for them instead.
      const slots = timeSlots.length > 0 ? timeSlots : await fetchTimeSlots()
      return createReminder({ title, rrule: dailyIn(slots), enrich: true })
    },
    [createReminder, dailyIn, timeSlots],
  )
  /**
   * Retry the AI on a reminder it gave up on: the server swaps `ai-failed`
   * back to `ai-to-process` and runs enrichment again. The row is remembered
   * with its current wording so the outcome is announced like a fresh add.
   */
  const retryEnrichment = useCallback(
    async (task: Task) => {
      awaitingEnrichment.current.set(task.id, task.title)
      try {
        const res = await fetch(`/api/tasks/${task.id}/reprocess`, { method: 'POST' })
        if (!res.ok) throw new Error('Could not retry')
        showToast({ message: 'Asking the AI again\u2026', id: `reminder-created-${task.id}` })
        void refresh()
      } catch {
        awaitingEnrichment.current.delete(task.id)
        showToast({ message: 'Could not retry the AI', type: 'error' })
      }
    },
    [refresh],
  )
  const saveDetail = useCallback(
    async (taskId: number, changes: QuickActionPanelChanges) => {
      try {
        // A schedule set by hand makes an earlier AI failure moot: the mark
        // says "until you edit it", so editing it takes the mark off.
        const failed = detailTasks.find((t) => t.id === taskId)?.labels.includes('ai-failed')
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
        onCompleted?.()
        void refresh()
      } catch (err) {
        showToast({
          message: err instanceof Error && err.message ? err.message : 'Save failed',
          type: 'error',
        })
        throw err
      }
    },
    [detailTasks, onUndo, onCompleted, refresh],
  )
  // Several at once: each reminder's own new rule in ONE bulk edit, so the
  // toast's Undo puts every one of them back.
  const saveDetailMany = useCallback(
    async ({ ids, rules, priority }: ReminderBulkChanges) => {
      try {
        // A shared priority goes to every id; a rule change only to the ids
        // whose rule moved. Both in one request, one Undo.
        const targets = priority !== undefined ? ids : rules.map((r) => r.id)
        const res = await fetch('/api/tasks/bulk/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ids: targets,
            changes: priority !== undefined ? { priority } : {},
            per_task: Object.fromEntries(rules.map((c) => [c.id, { rrule: c.rrule }])),
          }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          throw new Error(body?.error || 'Failed to update reminders')
        }
        showToast({
          message: `Updated ${targets.length} reminders`,
          type: 'success',
          action: { label: 'Undo', onClick: onUndo },
        })
        onCompleted?.()
        void refresh()
      } catch (err) {
        showToast({
          message: err instanceof Error && err.message ? err.message : 'Save failed',
          type: 'error',
        })
        throw err
      }
    },
    [onUndo, onCompleted, refresh],
  )

  return (
    // Clearance below the last row for the floating selection bar, so the
    // end of the list can always be scrolled out from under it.
    <section aria-label="Reminders" className="w-full pb-24">
      {/* Creating lives here, on the surface, not on the task form: a thought
          typed and entered is a daily reminder in the current slot, on screen
          at once; the plus opens the editor for anything more. */}
      <div className="mb-4">
        <QuickAdd
          placeholder="Add a reminder…"
          ariaLabel="Add a reminder"
          onAdd={quickAdd}
          onOpenAddForm={openCreate}
        />
      </div>
      {loading ? (
        <RemindersSkeleton />
      ) : error ? (
        <p className="text-muted-foreground py-16 text-center text-sm">{error}</p>
      ) : searching ? (
        <SearchResults
          count={resultCount}
          query={searchQuery?.trim() ?? ''}
          groups={[...searchSummary.started, ...searchSummary.later]}
          notToday={searchNotToday}
          completingIds={completingIds}
          selectedIds={selectedIds}
          onRowClick={actions.rowClick}
          onRowOpen={openDetail}
          onComplete={actions.complete}
          onRetry={retryEnrichment}
          onPutBack={putBack}
        />
      ) : visibleGroups.length === 0 ? (
        <RemindersEmptyState allClear={consideredAny || hasAny} headingLevel={1} />
      ) : (
        <>
          <RemindersHeadline
            summary={summary}
            allWaitingDone={total === 0}
            onConsiderSoFar={() => considerAll.askSoFar(summary)}
          />
          {/* The slot cards stay once the day is clear (Trent, 2026-09-05:
              "once everything is clear there's no way to expand it… in case I
              need to undo"). Each finished slot still opens to its considered
              items and their put-back; the headline and the green bar are the
              all-clear. */}
          {
            <div className="space-y-3">
              {[...summary.started, ...summary.later].map((group) => {
                const key = groupKey(group)
                return (
                  <ReminderSlotGroup
                    key={key}
                    group={group}
                    started={summary.started.includes(group)}
                    open={
                      isOpen(key) &&
                      (group.reminders.length > 0 || group.consideredItems.length > 0)
                    }
                    expanded={expandedKeys.has(key)}
                    onToggle={() => toggleOpen(key)}
                    onExpand={(expanded) => setExpanded(key, expanded)}
                    completingIds={completingIds}
                    selectedIds={selectedIds}
                    onRowClick={actions.rowClick}
                    onRowOpen={openDetail}
                    onComplete={actions.complete}
                    onRetry={retryEnrichment}
                    onCompleteGroup={considerAll.askSlot}
                    onPutBack={putBack}
                  />
                )
              })}
            </div>
          }
        </>
      )}

      {/* Reminders with no occurrence today, so a weekly thought is reachable
          on its off days (Trent, 2026-09-05). Never counted; a row opens its
          editor, since there is nothing to consider today. */}
      {!loading && notToday.length > 0 && <NotTodayFold items={notToday} onOpen={openDetail} />}

      <ReminderSelectionBar
        selectedCount={selectedIds.size}
        onConsidered={actions.considerSelection}
        onDelete={actions.deleteSelection}
        onDetails={selectedTasks.length > 0 ? () => setDetailTasks(selectedTasks) : undefined}
        onClear={clear}
      />
      <ConsiderAllDialog
        request={considerAll.request}
        onConfirm={considerAll.confirm}
        onCancel={considerAll.cancel}
      />
      <ReminderDetailModal
        tasks={detailTasks}
        create={createDraft}
        open={detailTasks.length > 0 || createDraft !== null}
        timeSlots={timeSlots}
        onClose={closeDetail}
        onSaveAll={saveDetail}
        onSaveMany={saveDetailMany}
        onCreate={createReminder}
        onConsidered={actions.considerMany}
        onDelete={actions.deleteMany}
        onOpenPage={(id) => router.push(`/tasks/${id}`)}
      />
    </section>
  )
}

/**
 * The surface's verbs, wired to the selection so a row that leaves the screen
 * leaves the selection too, whichever path took it. Escape clears a selection,
 * as it does on the dashboard.
 */
function useReminderActions({
  selection,
  orderedIds,
  selectedTasks,
  startedGroups,
  complete,
  completeMany,
  completeGroup,
  remove,
}: {
  selection: ReturnType<typeof useSelectionMode>
  orderedIds: number[]
  selectedTasks: Task[]
  startedGroups: ReminderGroup[]
  complete: (task: Task) => Promise<void>
  completeMany: (tasks: Task[]) => Promise<void>
  completeGroup: (group: ReminderGroup) => Promise<void>
  remove: (tasks: Task[]) => Promise<void>
}) {
  const { isSelectionMode, toggle, rangeSelect, selectOnly, removeAll, clear } = selection

  useEffect(() => {
    if (!isSelectionMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isSelectionMode, clear])

  const rowClick = useCallback(
    (task: Task, e: React.MouseEvent) => {
      if (e.shiftKey) rangeSelect(task.id, orderedIds)
      else if (e.metaKey || e.ctrlKey) toggle(task.id)
      else selectOnly(task.id)
    },
    [rangeSelect, toggle, selectOnly, orderedIds],
  )
  const completeOne = useCallback(
    (task: Task) => {
      removeAll([task.id])
      void complete(task)
    },
    [removeAll, complete],
  )
  const completeSlot = useCallback(
    (group: ReminderGroup) => {
      removeAll(group.reminders.map((r) => r.id))
      void completeGroup(group)
    },
    [removeAll, completeGroup],
  )
  const considerSelection = useCallback(() => {
    const tasks = selectedTasks
    clear()
    void completeMany(tasks)
  }, [selectedTasks, clear, completeMany])
  const considerSoFar = useCallback(() => {
    const tasks = startedGroups.flatMap((g) => g.reminders)
    clear()
    void completeMany(tasks)
  }, [startedGroups, clear, completeMany])
  const deleteSelection = useCallback(() => {
    const tasks = selectedTasks
    clear()
    void remove(tasks)
  }, [selectedTasks, clear, remove])
  // The details editor's verbs: the reminder(s) it holds, whether or not
  // they are the selection.
  const considerMany = useCallback(
    (tasks: Task[]) => {
      removeAll(tasks.map((t) => t.id))
      void completeMany(tasks)
    },
    [removeAll, completeMany],
  )
  const deleteMany = useCallback(
    (tasks: Task[]) => {
      removeAll(tasks.map((t) => t.id))
      void remove(tasks)
    },
    [removeAll, remove],
  )

  return {
    rowClick,
    complete: completeOne,
    completeGroup: completeSlot,
    considerSelection,
    considerSoFar,
    deleteSelection,
    considerMany,
    deleteMany,
  }
}

/**
 * The headline: one short line for "what now" (never a breakdown — the slot
 * headers below ARE the breakdown, one per line), the one-tap "Considered all
 * so far", and the day's bar.
 *
 * The bar is segmented, one segment per slot in the same order as the groups
 * below and sized by how much each slot held today, so the shape of the day
 * is readable at a glance and every considered thought visibly moves it.
 * Slots that haven't started yet are drawn fainter: "not yet" must not read
 * as "not done". A segment turns green when its slot is finished — a small
 * win each time — and the number goes green when the day is.
 */
function RemindersHeadline({
  summary,
  allWaitingDone,
  onConsiderSoFar,
}: {
  summary: RemindersSummary<ReminderGroup>
  allWaitingDone: boolean
  onConsiderSoFar: () => void
}) {
  let line: React.ReactNode
  if (allWaitingDone) {
    line = <span className="text-foreground font-medium">All clear for today</span>
  } else if (summary.waitingSoFar === 0 && summary.nextUp) {
    line = (
      <>
        <span className="text-foreground font-medium">
          Caught up until {summary.nextUp.slot.label}
        </span>
        <span className="text-muted-foreground">
          {' '}
          &middot; {formatSlotTime(summary.nextUp.slot.start_time)}
        </span>
      </>
    )
  } else {
    line = (
      <span className="text-foreground font-medium" data-waiting-so-far={summary.waitingSoFar}>
        {summary.waitingSoFar} waiting so far
      </span>
    )
  }

  const segments = [...summary.started, ...summary.later]
  const dayDone = summary.dayTotal > 0 && summary.consideredTotal >= summary.dayTotal

  return (
    <div className="mb-4 px-2" data-reminders-headline>
      <div className="flex items-center justify-between gap-3">
        <h1 className="min-w-0 text-sm">{line}</h1>
        {summary.waitingSoFar > 0 && (
          <button
            type="button"
            onClick={onConsiderSoFar}
            aria-label={`Mark all ${summary.waitingSoFar} waiting so far as considered`}
            className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
          >
            <CheckCheck className="size-3.5" strokeWidth={2.5} />
            <span className="hidden sm:inline">Considered all so far</span>
            <span className="sm:hidden">All so far</span>
          </button>
        )}
      </div>

      <div className="mt-3 flex items-center">
        <div
          className="flex h-2 w-full items-stretch gap-[3px]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={summary.dayTotal}
          aria-valuenow={summary.consideredTotal}
          aria-label={`${summary.consideredTotal} of ${summary.dayTotal} considered today`}
        >
          {segments.map((g) => {
            const slotTotal = g.reminders.length + g.considered
            const done = slotTotal > 0 && g.considered >= slotTotal
            const label = g.slot?.label ?? UNSLOTTED_LABEL
            const started = summary.started.includes(g)
            return (
              <div
                key={groupKey(g)}
                aria-hidden="true"
                title={`${label} · ${g.considered} of ${slotTotal} considered`}
                style={{ flexGrow: slotTotal }}
                className={cn(
                  'relative min-w-[6px] overflow-hidden rounded-full',
                  started ? 'bg-muted' : 'bg-muted/50',
                )}
              >
                <div
                  className={cn(
                    'h-full rounded-full transition-[width,background-color] duration-500 ease-out',
                    done ? 'bg-green-600' : 'bg-foreground/50',
                  )}
                  style={{ width: `${slotTotal > 0 ? (g.considered / slotTotal) * 100 : 0}%` }}
                />
              </div>
            )
          })}
        </div>
        <span className="ml-3 shrink-0 text-xs tabular-nums">
          {dayDone ? (
            <span className="text-green-700 dark:text-green-400">
              All {summary.dayTotal} considered today
            </span>
          ) : (
            <>
              <span className="text-foreground font-medium">{summary.consideredTotal}</span>
              <span className="text-muted-foreground hidden sm:inline">
                {' '}
                of {summary.dayTotal} considered
              </span>
              <span className="text-muted-foreground sm:hidden"> / {summary.dayTotal}</span>
            </>
          )}
        </span>
      </div>
    </div>
  )
}

/**
 * Which slots are open and which are showing all their rows.
 *
 * The user's explicit open/close choices are layered over the default (the
 * current slot) as overrides rather than a plain "open set", so the default
 * can be computed from data that arrives after first render without a timing
 * dance. "Show all" is tracked here too, so the view knows exactly which rows
 * are on screen — shift-click ranges must never sweep up rows the user cannot
 * see. Reopening a slot resets its "show all": it reads as a fresh glance, not
 * a resumed deep scroll.
 */
function useSlotDisclosure(defaultOpenKey: string | null) {
  const [openOverrides, setOpenOverrides] = useState<Map<string, boolean>>(new Map())
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const isOpen = useCallback(
    (key: string) => openOverrides.get(key) ?? key === defaultOpenKey,
    [openOverrides, defaultOpenKey],
  )
  const toggleOpen = useCallback(
    (key: string) => {
      const nextOpen = !isOpen(key)
      setOpenOverrides((prev) => new Map(prev).set(key, nextOpen))
      setExpandedKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    },
    [isOpen],
  )
  const setExpanded = useCallback((key: string, expanded: boolean) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (expanded) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  return { isOpen, toggleOpen, expandedKeys, setExpanded }
}

function ReminderSlotGroup({
  group,
  started,
  open,
  expanded,
  locked = false,
  onToggle,
  onExpand,
  completingIds,
  selectedIds,
  onRowClick,
  onRowOpen,
  onComplete,
  onRetry,
  onCompleteGroup,
  onPutBack,
}: {
  group: ReminderGroup
  started: boolean
  open: boolean
  expanded: boolean
  /** Search results: the slot cannot be folded and offers no sweep. */
  locked?: boolean
  onToggle: () => void
  onExpand: (expanded: boolean) => void
  completingIds: Set<number>
  selectedIds: Set<number>
  onRowClick: (task: Task, e: React.MouseEvent) => void
  onRowOpen: (task: Task) => void
  onComplete: (task: Task) => void
  onRetry: (task: Task) => void
  onCompleteGroup: (group: ReminderGroup) => void
  onPutBack: (task: Task) => void
}) {
  const label = group.slot?.label ?? UNSLOTTED_LABEL
  const time = group.slot ? formatSlotTime(group.slot.start_time) : null
  const count = group.reminders.length
  const slotTotal = count + group.considered
  // A slot with nothing waiting can still open: its considered items live
  // behind the counter, and one of them may need putting back.
  const canOpen = !locked && (count > 0 || group.consideredItems.length > 0)
  const visible = expanded ? group.reminders : group.reminders.slice(0, SLOT_PREVIEW_COUNT)
  const hiddenCount = count - visible.length

  const headerRow = (
    <SlotHeaderRow
      label={label}
      time={time}
      count={count}
      considered={group.considered}
      open={open}
      started={started}
    />
  )

  return (
    <div
      className={cn(
        // Bottom padding in every state, so the hairline sits inside the card
        // rather than flush with its edge when folded.
        'bg-muted/30 rounded-2xl pb-1 transition-colors',
        open && 'pb-2',
        !started && 'opacity-70',
      )}
      data-slot-group={label}
      data-slot-started={started}
    >
      <div className="flex min-h-11 items-center gap-2 px-3">
        {!canOpen ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 py-2">{headerRow}</div>
        ) : (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="hover:text-foreground flex min-w-0 flex-1 items-center gap-2 rounded-lg py-2 text-left transition-colors"
          >
            {headerRow}
          </button>
        )}
        {open && count > 0 && !locked && (
          <button
            type="button"
            onClick={() => onCompleteGroup(group)}
            aria-label={`Mark all ${count} in ${label} as considered`}
            className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
          >
            <CheckCheck className="size-3.5" strokeWidth={2.5} />
            <span className="hidden sm:inline">Considered all</span>
          </button>
        )}
      </div>

      <SlotHairline label={label} considered={group.considered} total={slotTotal} />

      {open && (
        <>
          {visible.length > 0 && (
            <ul
              className="space-y-0.5 px-1"
              role="listbox"
              aria-multiselectable="true"
              aria-label={label}
            >
              {visible.map((reminder) => (
                <ReminderRow
                  key={reminder.id}
                  reminder={reminder}
                  completing={completingIds.has(reminder.id)}
                  selected={selectedIds.has(reminder.id)}
                  onClick={onRowClick}
                  onOpen={onRowOpen}
                  onComplete={onComplete}
                  onRetry={onRetry}
                />
              ))}
            </ul>
          )}
          {hiddenCount > 0 && !locked && (
            <button
              type="button"
              onClick={() => onExpand(true)}
              className="text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground w-full rounded-lg py-2 pl-11 text-left text-xs font-medium transition-colors"
            >
              Show all {count}
              <span className="text-muted-foreground/60"> ({hiddenCount} more)</span>
            </button>
          )}
          {expanded && count > SLOT_PREVIEW_COUNT && !locked && (
            <button
              type="button"
              onClick={() => onExpand(false)}
              className="text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground w-full rounded-lg py-2 pl-11 text-left text-xs font-medium transition-colors"
            >
              Show less
            </button>
          )}
          {group.consideredItems.length > 0 && (
            <ConsideredDisclosure
              items={group.consideredItems}
              label={label}
              onPutBack={onPutBack}
            />
          )}
        </>
      )}
    </div>
  )
}

/**
 * The slot header's row: one shape whether the slot is open, folded, finished,
 * or not yet started — chevron box (so the label lands on the rows' x), label,
 * time, spacer, count. The count reads the same open or folded; a later slot
 * says "later"; a finished slot says so in green. Never a pill that changes
 * colour when the section folds.
 */
function SlotHeaderRow({
  label,
  time,
  count,
  considered,
  open,
  started,
}: {
  label: string
  time: string | null
  count: number
  considered: number
  open: boolean
  started: boolean
}) {
  const total = count + considered
  const finished = count === 0 && considered > 0
  // Trent (2026-09-05): the number must not count down as thoughts are
  // considered ("26, 25, 24" felt wrong under a progress bar). It reads
  // "1 of 26, 2 of 26" — the slot's size stays put and the considered
  // count climbs, the same framing as the day number by the bar. A slot
  // that hasn't started and has nothing considered yet just says how many
  // are ahead.
  const counter = finished ? (
    <span className="text-xs whitespace-nowrap text-green-700 tabular-nums dark:text-green-400">
      {considered} of {total}
    </span>
  ) : !started && considered === 0 ? (
    <span className="text-muted-foreground text-xs whitespace-nowrap tabular-nums">
      {count} later
    </span>
  ) : (
    <span className="text-xs whitespace-nowrap tabular-nums">
      <span className="text-foreground font-medium">{considered}</span>
      <span className="text-muted-foreground"> of {total}</span>
    </span>
  )
  return (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center">
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'text-muted-foreground/60 size-3.5 transition-transform duration-200',
            !open && '-rotate-90',
            count === 0 && considered === 0 && 'invisible',
          )}
        />
      </span>
      <span className="text-muted-foreground text-xs font-semibold tracking-wider whitespace-nowrap uppercase">
        {label}
      </span>
      {time && (
        <span className="text-muted-foreground/50 text-xs whitespace-nowrap">&middot; {time}</span>
      )}
      <span className="flex-1" />
      <span
        aria-label={
          !started && considered === 0
            ? `${count} later`
            : `${considered} of ${total} considered, ${count} waiting`
        }
      >
        {counter}
      </span>
    </>
  )
}

/** Full-width hairline under a slot header: considered over what the slot held today. Long enough that one thought visibly moves it. */
function SlotHairline({
  label,
  considered,
  total,
}: {
  label: string
  considered: number
  total: number
}) {
  const fraction = total > 0 ? considered / total : 0
  return (
    <div
      className="bg-muted mx-3 mb-2 h-1 overflow-hidden rounded-full"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={considered}
      aria-label={`${considered} of ${total} considered in ${label}`}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width,background-color] duration-500 ease-out',
          fraction >= 1 ? 'bg-green-600' : 'bg-foreground/50',
        )}
        style={{ width: `${Math.min(1, fraction) * 100}%` }}
      />
    </div>
  )
}

/**
 * The slot's considered items, folded behind one line so the list of what is
 * still waiting stays short. Each row is checked and dim; its circle puts the
 * thought back (Trent, 2026-09-05: "if I accidentally press it, undo is not
 * quite enough"). Rows here are not selectable — there is one thing to do
 * with them, and it is on the circle.
 */
function ConsideredDisclosure({
  items,
  label,
  onPutBack,
}: {
  items: Task[]
  label: string
  onPutBack: (task: Task) => void
}) {
  const [shown, setShown] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-expanded={shown}
        className="text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground w-full rounded-lg py-2 pl-11 text-left text-xs font-medium transition-colors"
      >
        {shown ? 'Hide' : 'Show'} {items.length} considered
      </button>
      {shown && (
        <ul className="space-y-0.5 px-1" aria-label={`Considered in ${label}`}>
          {items.map((reminder) => (
            <li
              key={reminder.id}
              data-considered-id={reminder.id}
              className="flex items-start gap-3 rounded-xl px-2 py-2.5"
            >
              <button
                type="button"
                onClick={() => onPutBack(reminder)}
                aria-label={`Put back "${reminder.title}"`}
                title="Put back"
                className="mt-[3px] flex size-6 shrink-0 items-center justify-center rounded-full bg-green-600 text-white transition-colors hover:bg-green-600/50"
              >
                <Check className="size-3.5" strokeWidth={3} />
              </button>
              <p className="text-muted-foreground min-w-0 flex-1 text-[16px] leading-6">
                <span className="text-pretty">{reminder.title}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function ReminderRow({
  reminder,
  completing,
  selected,
  onClick,
  onOpen,
  onComplete,
  onRetry,
}: {
  reminder: Task
  completing: boolean
  selected: boolean
  onClick: (task: Task, e: React.MouseEvent) => void
  onOpen: (task: Task) => void
  onComplete: (task: Task) => void
  onRetry: (task: Task) => void
}) {
  const hasNotes = !!reminder.notes?.trim()
  const mark = cadenceMark(reminder.rrule)
  // The AI's processing state, carried on the same labels a task uses. The
  // surface shows no labels, so the two states that matter get their own
  // marks: the pulse the task row wears while the AI is reading, and a line
  // under the title when it gave up. The second one is the important one —
  // the quick add already put this thought in a slot with a plausible daily
  // rule, so without a mark a failure would look exactly like success.
  const aiProcessing = reminder.labels.includes('ai-to-process')
  const aiFailed = reminder.labels.includes('ai-failed')

  return (
    <li
      data-reminder-id={reminder.id}
      role="option"
      aria-selected={selected}
      onClick={(e) => onClick(reminder, e)}
      // Double-click opens the reminder's details, as it opens a task's quick
      // panel on the dashboard (Trent, 2026-09-05: "why doesn't double-clicking
      // bring up the modal"). Its two clicks select and then deselect the row
      // (a lone selection toggles), so afterwards nothing is selected — the
      // dashboard's double-click leaves the same state.
      onDoubleClick={() => onOpen(reminder)}
      className={cn(
        // The border is always there, transparent, so the processing pulse has
        // something to color without the row shifting by a pixel.
        'group flex cursor-pointer items-start gap-3 rounded-xl border border-transparent px-2 py-2.5 transition-all duration-200 ease-out select-none',
        selected ? 'ring-ring bg-accent ring-2' : 'hover:bg-foreground/[0.04]',
        completing && 'pointer-events-none translate-x-2 opacity-0',
        aiProcessing && 'animate-ai-processing',
      )}
      data-ai-state={aiProcessing ? 'processing' : aiFailed ? 'failed' : undefined}
    >
      {/* The circle considers this one item directly and never touches the
          selection, so it stops the row's click from reaching the handler. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onComplete(reminder)
        }}
        aria-label={`Mark "${reminder.title}" as considered`}
        title="Considered"
        className="border-foreground/20 hover:border-foreground/60 hover:bg-foreground/5 mt-[3px] flex size-6 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors"
      >
        <Check
          className="group-hover:text-foreground/40 size-3.5 text-transparent transition-colors"
          strokeWidth={3}
        />
      </button>
      {/* The notes marker sits inline after the title rather than pinned to
          the right edge: on a wide screen a lone icon across the row reads as
          an unrelated control, and this one is only ever a footnote. */}
      <p className="min-w-0 flex-1 text-[16px] leading-6">
        <span className={cn('text-pretty', prominenceClasses(reminder.priority))}>
          {reminder.title}
        </span>
        {/* Not every day: the day codes, "Monthly", "Once". Daily wears nothing. */}
        {mark && (
          <span
            className="text-muted-foreground/60 ml-2 text-xs whitespace-nowrap"
            title={mark.full}
            data-cadence-mark
          >
            {mark.short}
          </span>
        )}
        {hasNotes && (
          <span className="text-muted-foreground/50 ml-1.5 inline-flex align-[-2px]">
            <StickyNote className="size-3.5" aria-label="Has notes" />
          </span>
        )}
        {aiFailed && (
          <span className="text-muted-foreground mt-0.5 block text-xs" data-ai-failed>
            The AI didn&rsquo;t read this. It&rsquo;s daily in this slot until you edit it.
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onRetry(reminder)
              }}
              className="text-foreground/80 hover:text-foreground ml-1.5 underline underline-offset-2"
            >
              Retry
            </button>
          </span>
        )}
      </p>
    </li>
  )
}

/**
 * The surface while a search is active.
 *
 * Results are results: the headline and the day bar describe today as a whole,
 * not the matches, so they step aside for a count line — the same move the
 * Tasks page makes with its Track panel. Every slot holding a match renders
 * open and whole, with no "Show all" fold and no caret to collapse it, because
 * a folded result is a result the user cannot see. Clearing the search restores
 * the surface exactly as they left it, since none of this touched the
 * disclosure state.
 */
function SearchResults({
  count,
  query,
  groups,
  notToday,
  completingIds,
  selectedIds,
  onRowClick,
  onRowOpen,
  onComplete,
  onRetry,
  onPutBack,
}: {
  count: number
  query: string
  groups: ReminderGroup[]
  notToday: Task[]
  completingIds: Set<number>
  selectedIds: Set<number>
  onRowClick: (task: Task, e: React.MouseEvent) => void
  onRowOpen: (task: Task) => void
  onComplete: (task: Task) => void
  onRetry: (task: Task) => void
  onPutBack: (task: Task) => void
}) {
  return (
    <>
      <div className="text-muted-foreground mb-4 px-2 text-sm" data-search-count={count}>
        {count} result{count !== 1 ? 's' : ''} for &ldquo;{query}&rdquo;
      </div>
      {count === 0 ? (
        <p className="text-muted-foreground py-12 text-center text-sm">
          No thought here says that.
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <ReminderSlotGroup
              key={groupKey(group)}
              group={group}
              started
              open
              expanded
              locked
              onToggle={NO_OP}
              onExpand={NO_OP}
              completingIds={completingIds}
              selectedIds={selectedIds}
              onRowClick={onRowClick}
              onRowOpen={onRowOpen}
              onComplete={onComplete}
              onRetry={onRetry}
              onCompleteGroup={NO_OP}
              onPutBack={onPutBack}
            />
          ))}
          {notToday.length > 0 && <NotTodayFold items={notToday} onOpen={onRowOpen} forceOpen />}
        </div>
      )}
    </>
  )
}

/** Handlers the search view deliberately does nothing with. */
const NO_OP = () => {}

/**
 * The reminders that are not today's — a weekly thought on its off day, a
 * monthly one mid-month — folded at the bottom, so every thought stays
 * reachable from its own surface. Rows carry their cadence mark (the reason
 * they are not today's) and open the editor on click; there is no circle,
 * because there is nothing to consider today.
 */
function NotTodayFold({
  items,
  onOpen,
  forceOpen = false,
}: {
  items: Task[]
  onOpen: (task: Task) => void
  /** Search results are shown, never folded away. */
  forceOpen?: boolean
}) {
  const [userOpen, setUserOpen] = useState(false)
  const open = forceOpen || userOpen
  const setOpen = forceOpen ? NO_OP : setUserOpen
  return (
    <div className="bg-muted/30 mt-3 rounded-2xl pb-1" data-not-today>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="hover:text-foreground flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors"
      >
        <span className="text-muted-foreground flex size-6 shrink-0 items-center justify-center">
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </span>
        <span className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          Not today
        </span>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">{items.length}</span>
      </button>
      {open && (
        <ul className="space-y-0.5 px-1">
          {items.map((task) => {
            const mark = cadenceMark(task.rrule)
            return (
              <li key={task.id} data-not-today-id={task.id}>
                <button
                  type="button"
                  onClick={() => onOpen(task)}
                  className="hover:bg-foreground/[0.04] flex w-full items-start gap-3 rounded-xl px-2 py-2.5 text-left transition-colors"
                >
                  <span className="mt-[3px] size-6 shrink-0" aria-hidden />
                  <p className="text-foreground/70 min-w-0 flex-1 text-[16px] leading-6">
                    <span className="text-pretty">{task.title}</span>
                    {mark && (
                      <span
                        className="text-muted-foreground/60 ml-2 text-xs whitespace-nowrap"
                        title={mark.full}
                        data-cadence-mark
                      >
                        {mark.short}
                      </span>
                    )}
                  </p>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * §6: priority is expressed as weight and contrast, never as alarm.
 *
 * The scale is deliberately shallow — three steps across five priorities — so
 * the top of a slot reads as "start here", not as "this one is shouting".
 */
function prominenceClasses(priority: number): string {
  if (priority >= 3) return 'text-foreground font-medium'
  if (priority === 2) return 'text-foreground'
  return 'text-foreground/70'
}

/** "07:00" → "7:00 AM". Falls back to the raw value if it isn't HH:MM. */
function formatSlotTime(startTime: string): string {
  const parsed = DateTime.fromFormat(startTime, 'HH:mm')
  return parsed.isValid ? parsed.toFormat('h:mm a') : startTime
}

/**
 * The page's h1 is the headline ("34 waiting so far") when there is one. When
 * the empty state stands alone it takes the h1 itself, so the page always has
 * exactly one — the top bar shows the logo, not a title.
 */
function RemindersEmptyState({
  allClear,
  headingLevel = 2,
}: {
  allClear: boolean
  headingLevel?: 1 | 2
}) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2'
  if (allClear) {
    return (
      <div className="flex flex-col items-center gap-2 py-20 text-center">
        <div className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-full">
          <Check className="size-5" strokeWidth={2.5} />
        </div>
        <Heading className="text-foreground text-base font-medium">All clear</Heading>
        <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
          Nothing left to consider today. Anything that recurs comes back at its own time.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <div className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-full">
        <Lightbulb className="size-5" />
      </div>
      <Heading className="text-foreground text-base font-medium">
        Reminders are thoughts, not tasks
      </Heading>
      <p className="text-muted-foreground max-w-sm text-sm leading-relaxed">
        Principles and considerations you want in mind at a certain time of day. They never go
        overdue, never reach the badge, and completing one only means you considered it.
      </p>
      <p className="text-muted-foreground/70 max-w-sm text-xs leading-relaxed">
        Open any task, then turn on <span className="text-foreground/80">Reminder</span> in its
        &ldquo;More options&rdquo; menu. Give it a time of day and it lands in that slot.
      </p>
    </div>
  )
}

/**
 * Reduce a reminder's wording to what a person would call "the same words":
 * case, surrounding space, runs of space and trailing punctuation all go. Used
 * only to decide whether the AI's rewrite is worth mentioning.
 */
function normalizeWording(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?\s]+$/, '')
    .trim()
}

/**
 * The user's slots, for the one caller that needs them before `useTimeSlots`
 * has finished. Returns an empty list on any failure — the caller has a
 * fallback, and a thrown error here would lose what the user just typed.
 */
async function fetchTimeSlots(): Promise<TimeSlot[]> {
  try {
    const res = await fetch('/api/time-slots')
    if (!res.ok) return []
    const json = await res.json()
    return (json?.data?.time_slots ?? []) as TimeSlot[]
  } catch {
    return []
  }
}

/** Quiet placeholder while the first fetch is in flight — no spinner, no jump. */
function RemindersSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      {[0, 1].map((group) => (
        <div key={group} className="px-2">
          <div className="bg-muted/70 mb-3 h-3 w-28 rounded" />
          <div className="space-y-2.5">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-3">
                <div className="bg-muted/70 size-6 shrink-0 rounded-full" />
                <div className="bg-muted/70 h-3.5 flex-1 rounded" style={{ maxWidth: '70%' }} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
