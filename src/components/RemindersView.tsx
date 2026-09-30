'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Lightbulb } from 'lucide-react'
import { slotGroupKey, UNSLOTTED_LABEL } from '@/lib/reminder-slots'
import { parseHHMM } from '@/lib/time-slot-assign'
import { summarizeReminders } from '@/lib/reminders-summary'
import { groupConsidered, groupWaiting } from '@/lib/quota-prompts'
import { slotAtMinutes } from '@/lib/reminder-rule'
import { saveReminderDetail } from '@/lib/save-reminder-detail'
import { matchesTaskSearch, normalizeTaskSearch } from '@/lib/task-search'
import { showToast } from '@/lib/toast'
import { useReminders, type ReminderCreateInput } from '@/hooks/useReminders'
import { useSelectionMode } from '@/hooks/useSelectionMode'
import { useTimeSlots } from '@/hooks/useTimeSlots'
import { useTimezone } from '@/hooks/useTimezone'
import { useSyncStream } from '@/hooks/useSyncStream'
import { useReminderActions, useRenderedSelection } from '@/hooks/useReminderSelection'
import { usePromptDeepLink } from '@/hooks/useRemindersDeepLinks'
import { ReminderSelectionBar } from '@/components/ReminderSelectionBar'
import { usePromptRows } from '@/components/QuotaPromptRow'
import { ReminderDetailModal } from '@/components/ReminderDetailModal'
import type { ReminderRowHandlers } from '@/components/reminders/ReminderRow'
import {
  hasConsideredRows,
  ReminderSlotGroup,
  useSlotDisclosure,
} from '@/components/reminders/ReminderSlotGroup'
import { RemindersHeadline } from '@/components/reminders/RemindersHeadline'
import { SearchResults } from '@/components/reminders/SearchResults'
import { NotTodayFold } from '@/components/reminders/NotTodayFold'
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
 * 2. **Each time slot is a container** with its own "Considered all". Every
 *    slot starts open (2026-09-06, see `useSlotDisclosure`); a slot still
 *    ahead in the day is drawn fainter and its header counts "N later".
 * 3. **Inside an open slot: everything if the slot has started, else the first
 *    five then "Show all N".**
 * 4. **Progress fills, it never scolds.** A bar per slot and one for the day
 *    show what has been considered so far today (his add: "satisfying to get
 *    through all the reminders"). It only ever counts what he did — a bar that
 *    filled with misses would read intent from absence (L1).
 *
 * Touching a row considers it (Trent, 2026-09-11: "I should be able to just
 * tap reminders pretty much anywhere to mark them done"). Selection is behind a
 * press-and-hold, the same 400ms gesture the dashboard's TaskRow uses, and the
 * same floating bar appears with the verbs that apply — including Details,
 * which is now the deliberate way in to a reminder's editor ("we just tap and
 * hold and then click Details with the item checked"). A mouse keeps its
 * shortcuts into a selection: shift-click a range, cmd/ctrl-click to add.
 * Escape clears. A row click never navigates.
 *
 * Completed items leave immediately, and a slot that never had anything today
 * is not shown (on this surface there is no day to read, only thoughts still
 * waiting) — but a slot that has been fully considered stays as a full bar,
 * because that is the satisfying part.
 *
 * This file is the surface's state and wiring, including the `?reminder=` and
 * `?slot=` deep links. The pieces it draws live in `src/components/reminders/`
 * (the row, the slot group, the headline, the search view, the Not today
 * fold); the selection's universe and verbs in `useReminderSelection`, and
 * the `?prompt=` deep link in `useRemindersDeepLinks`.
 */

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

export function RemindersView({
  onUndo,
  onCompleted,
  refreshRef,
  searchQuery,
}: RemindersViewProps) {
  const timezone = useTimezone()
  // Held for the details editor's slot chips (so opening one never waits on a
  // fetch) and for placing a new reminder in its slot at once.
  const { timeSlots, refresh: refreshTimeSlots } = useTimeSlots()
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
    considerPrompt,
    didPrompt,
    movePrompt,
    rowLeft,
    registerRow,
    hydrated,
    putBack,
    putBackPrompt,
    remove,
    refresh,
    notToday,
    create,
  } = useReminders({ onUndo, onCompleted, timeSlots, timezone })
  const router = useRouter()
  // Reminder ids and quota prompt keys (strings — see `QuotaPromptRow`).
  const selection = useSelectionMode<number | string>()
  const { selectedIds, clear, selectAll } = selection

  // Searching narrows what is rendered; it deliberately does NOT touch which
  // slots the user has open. Both `defaultOpenKey` and `useSlotDisclosure`
  // derive from `visibleGroups`, so filtering upstream would rearrange the
  // user's disclosure state and leave it rearranged after the search cleared.
  // Instead every slot holding a match renders open and whole for the duration
  // of the query, and the moment it clears the surface is exactly as it was.
  const query = normalizeTaskSearch(searchQuery)
  const searching = query.length > 0
  const matchesQuery = useCallback(
    // Title and notes, case-insensitive substring — the Tasks page's semantics,
    // shared with the Quotas page through `matchesTaskSearch`.
    (task: Task) => matchesTaskSearch(task, query),
    [query],
  )
  const searchGroups = useMemo(() => {
    if (!searching) return []
    return groups
      .map((group) => ({
        ...group,
        reminders: group.reminders.filter(matchesQuery),
        consideredItems: group.consideredItems.filter(matchesQuery),
        // A prompt matches on its title — a waiting one as a row, a handled
        // one in the considered list with its put-back, as a reminder does.
        prompts: group.prompts.filter((p) => p.title.toLowerCase().includes(query)),
      }))
      .filter(
        (group) =>
          group.reminders.length > 0 ||
          group.consideredItems.length > 0 ||
          group.prompts.length > 0,
      )
  }, [groups, searching, matchesQuery, query])
  const searchNotToday = useMemo(
    () => (searching ? notToday.filter(matchesQuery) : []),
    [notToday, searching, matchesQuery],
  )
  const searchSummary = useMemo(
    () => summarizeReminders(searchGroups, timezone),
    [searchGroups, timezone],
  )
  const resultCount =
    searchGroups.reduce(
      (n, g) => n + g.reminders.length + g.consideredItems.length + g.prompts.length,
      0,
    ) + searchNotToday.length

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
    // Slots too: a Settings edit to a reminder period emits a sync event.
    onSync: () => {
      void refresh()
      void refreshTimeSlots()
    },
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
    () => groups.filter((g) => groupWaiting(g) > 0 || groupConsidered(g) > 0),
    [groups],
  )
  const summary = useMemo(
    () => summarizeReminders(visibleGroups, timezone),
    [visibleGroups, timezone],
  )

  const { isOpen, toggleOpen, expandedKeys, setOpen, setExpanded } = useSlotDisclosure()

  /**
   * `?reminder=<id>` — the deep link the iOS widget opens.
   *
   * The row is brought on screen and flashed once; nothing is opened. The
   * widget's user tapped a thought to SEE it, and an editor over the top of the
   * surface would hide the five thoughts around it that are the reason they
   * looked. (The dashboard's widget-tapped `?task=<id>&highlight=1` does the
   * same thing for tasks — see `DashboardClient.tsx`'s `?task=` effect. The
   * bare `?task=<id>` is a notification tap: it also selects the row, and for
   * a reminder it forwards here with `&select=1`, handled below.) A quota
   * PROMPT row's link is `?prompt=<key>` — `usePromptDeepLink` (`useRemindersDeepLinks.ts`), the
   * same move keyed by `prompt_key`.
   *
   * The id is looked up once the fetch has resolved. Found or not, that answer
   * is definitive — unlike the dashboard's list, an empty payload here is a
   * real "no reminders" — so the param is consumed either way. An error is the
   * one case that waits: a retry may still find it.
   */
  const [highlightId, setHighlightId] = useState<number | null>(null)
  const [openNotToday, setOpenNotToday] = useState(false)
  // Once the flash has played it is spent. Without this the row would flash —
  // and drag the viewport back to itself — every time it remounted, which a
  // fold, a search, or a slot re-render does minutes after the link was used.
  const clearHighlight = useCallback(() => setHighlightId(null), [])
  const deepLinkDone = useRef(false)
  useEffect(() => {
    // `hydrated`, not `loading`: the module cache paints the surface instantly
    // on a client-side visit, so `loading` is already false over data that may
    // predate the reminder being linked to. Consuming the param then would
    // spend it on a list that simply had not been fetched yet — the same trap
    // the dashboard's `?task=` avoids by refusing to resolve against an empty
    // list.
    if (deepLinkDone.current || !hydrated || error) return
    // Read the URL directly rather than through useSearchParams: the param is
    // stripped below with a raw history rewrite (same reason as the dashboard's
    // — a router.replace issues an RSC fetch that can remount this surface),
    // which the hook does not observe anyway, and reading window.location keeps
    // this component out of a Suspense boundary it otherwise would need.
    const params = new URLSearchParams(window.location.search)
    const raw = params.get('reminder')
    if (!raw) {
      deepLinkDone.current = true
      return
    }
    deepLinkDone.current = true
    const id = Number.parseInt(raw, 10)
    const group = Number.isNaN(id)
      ? undefined
      : groups.find((g) => g.reminders.some((r) => r.id === id))
    if (group) {
      // A slot the user folded, or one still ahead in the day showing only its
      // first few, would leave the linked row unrendered. Open and uncap it.
      const key = slotGroupKey(group)
      setOpen(key, true)
      setExpanded(key, true)
      setHighlightId(id)
      // `&select=1`: a NOTIFICATION tap on a reminder (the dashboard's
      // `?task=` effect forwards one here — the "AI finished" push for a new
      // reminder). As on the dashboard, a notification tap also selects the
      // row, so the action bar is up for it; the widget's link doesn't.
      if (params.get('select') === '1') selectAll([id])
    } else if (!Number.isNaN(id) && notToday.some((t) => t.id === id)) {
      setOpenNotToday(true)
      setHighlightId(id)
    }
    window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [hydrated, error, groups, notToday, setOpen, setExpanded, selectAll])

  // NO SCROLL ON LOAD (Trent, 2026-09-22). The surface used to scroll to the
  // slot the day was in, so the afternoon did not open on breakfast — but at
  // night that is the last slot, and he read the jump to the bottom as a bug:
  // "when I tap on Reminders, it scrolls me to the bottom." Offered the
  // earliest unfinished slot as the landing instead, he chose the top, always.
  // A `?reminder=<id>` deep link still brings its row into view (the row's own
  // `scrollRowIntoView` ref).

  /**
   * `?slot=<slotId>` — the widget's per-slot header deep link (a Time Slot's
   * numeric `id`, or the literal `"unslotted"` for Anytime — same identity
   * `slotGroupKey` gives every slot group). Brings that slot's whole SECTION into
   * view, opening it if folded — the same shape as `?reminder=<id>` above,
   * but for a section rather than a single row: the widget's slot header
   * links here, and there is no one row to highlight.
   *
   * Every slot starts open by default already (see `useSlotDisclosure`'s doc
   * comment — a 2026-09-06 change), so `setOpen`/`setExpanded` are usually a
   * no-op on a fresh visit; they still run for the rare case a slot was
   * folded earlier in the same session before this link was used.
   *
   * Deletes only its own `slot` param (not the whole query string) when
   * consuming it — unlike a full-path `replaceState`, this can't clobber an
   * unrelated param a future caller adds alongside it.
   *
   * `goToSlot` is the whole move — open, show everything, scroll — and the
   * headline's day bar calls it too (2026-09-25): tapping a segment goes to
   * that period's section, the way the dashboard card's slot bar pages to it.
   *
   * The request is ONE-SHOT. It carries a sequence number, so tapping the
   * same segment again (after scrolling away) is a new request, and the slot
   * group reports it served (`slotScrollServed`), which clears it. Left
   * standing, a request would replay whenever the slot list remounts — a
   * search typed and cleared, say — and yank the page back to a slot nobody
   * asked for; the row highlight clears itself for the same reason.
   */
  const [slotScroll, setSlotScroll] = useState<{ key: string; seq: number } | null>(null)
  const goToSlot = useCallback(
    (key: string) => {
      setOpen(key, true)
      setExpanded(key, true)
      setSlotScroll((prev) => ({ key, seq: (prev?.seq ?? 0) + 1 }))
    },
    [setOpen, setExpanded],
  )
  const slotScrollServed = useCallback((seq: number) => {
    setSlotScroll((prev) => (prev?.seq === seq ? null : prev))
  }, [])
  const slotDeepLinkDone = useRef(false)
  useEffect(() => {
    if (slotDeepLinkDone.current || !hydrated || error) return
    const params = new URLSearchParams(window.location.search)
    const raw = params.get('slot')
    if (!raw) {
      slotDeepLinkDone.current = true
      return
    }
    slotDeepLinkDone.current = true
    // Among the slots on screen: an empty slot has no section to go to.
    const group = visibleGroups.find((g) => slotGroupKey(g) === raw)
    if (group) goToSlot(slotGroupKey(group))
    params.delete('slot')
    const query = params.toString()
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + (query ? `?${query}` : ''),
    )
  }, [hydrated, error, visibleGroups, goToSlot])

  const { highlightPromptKey, clearPromptHighlight } = usePromptDeepLink({
    hydrated,
    error,
    groups,
    setOpen,
    setExpanded,
    goToSlot,
  })

  const { orderedIds, selectedTasks, selectedPrompts } = useRenderedSelection({
    searching,
    // In the order the slot cards are DRAWN (started, then later — which puts
    // Anytime among the started), not the payload's, or a Shift-click range
    // would span a different run of rows than the one on screen.
    searchGroups: [...searchSummary.started, ...searchSummary.later],
    visibleGroups: [...summary.started, ...summary.later],
    started: summary.started,
    isOpen,
    expandedKeys,
    selectedIds,
  })

  const actions = useReminderActions({
    selection,
    orderedIds,
    selectedTasks,
    selectedPrompts,
    startedGroups: summary.started,
    complete,
    completeMany,
    completeGroup,
    considerPrompt,
    didPrompt,
    remove,
  })
  // Quota prompts: their rows (a hold opens the quota's own bubble and
  // editor), drawn by the slot groups through `rowHandlers.renderPrompt`.
  const prompts = usePromptRows({
    completingIds,
    isSelectionMode: actions.isSelectionMode,
    selectedIds,
    onSelect: actions.selectPrompt,
    onRangeSelect: actions.rangeSelectPrompt,
    considerPrompt: actions.considerPrompt,
    didPrompt: actions.didPrompt,
    movePrompt,
    rowLeft,
    registerRow,
    onUndo,
    onCompleted,
    refresh,
    highlightKey: highlightPromptKey,
    onHighlightDone: clearPromptHighlight,
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
   * Creating: the quick add sends only the text, and the SERVER makes it a
   * daily thought in the user's default reminder slot (Settings → Reminder
   * periods → Default period; `defaultReminderRule` in createTask) — the same
   * path an Apple Shortcut's title-only POST takes (Trent, 2026-09-28: "adding
   * a reminder should be just like adding a task"). It is on screen the moment
   * the server answers. Until 2026-09-28 this box used the slot current right
   * now; the quick add is one box for the whole surface, not a per-slot add,
   * so "unspecified" means the default. That default is also a fallback — the
   * quick add sets `enrich`, so the text goes to AI enrichment, which reads any
   * cadence or time of day the user actually said ("every Friday evening") and
   * rewrites the schedule, snapping it to one of their slots; with no time cue
   * it stays in the default slot. The form does not enrich: there the user
   * picked the schedule by hand. Undo is the ordinary one.
   */
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
    async (title: string) => createReminder({ title, enrich: true }),
    [createReminder],
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
    (taskId: number, changes: QuickActionPanelChanges) =>
      saveReminderDetail(taskId, changes, { source: detailTasks, onUndo, onCompleted, refresh }),
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

  const rowHandlers: ReminderRowHandlers = useMemo(
    () => ({
      onSelect: actions.selectRow,
      onRangeSelect: actions.rangeSelectRow,
      onOpen: openDetail,
      onComplete: actions.complete,
      onRetry: retryEnrichment,
      onLeft: rowLeft,
      onHighlightDone: clearHighlight,
      onRegister: registerRow,
      renderPrompt: prompts.renderPrompt,
      onPutBackPrompt: putBackPrompt,
    }),
    [
      actions.selectRow,
      actions.rangeSelectRow,
      openDetail,
      actions.complete,
      retryEnrichment,
      rowLeft,
      clearHighlight,
      registerRow,
      prompts.renderPrompt,
      putBackPrompt,
    ],
  )

  return (
    // Clearance below the last row for the floating selection bar, so the
    // end of the list can always be scrolled out from under it.
    <section aria-label="Reminders" className="w-full pb-24">
      {/* Creating lives here, on the surface, not on the task form: a thought
          typed and entered is a daily reminder in the default slot, on screen
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
          isSelectionMode={actions.isSelectionMode}
          rowHandlers={rowHandlers}
          onPutBack={putBack}
          onOpenDetail={openDetail}
        />
      ) : visibleGroups.length === 0 ? (
        <RemindersEmptyState allClear={consideredAny || hasAny} headingLevel={1} />
      ) : (
        <>
          <RemindersHeadline
            summary={summary}
            allWaitingDone={total === 0}
            onConsiderSoFar={() => considerAll.askSoFar(summary)}
            onGoToSlot={goToSlot}
          />
          {/* The slot cards stay once the day is clear (Trent, 2026-09-05:
              "once everything is clear there's no way to expand it… in case I
              need to undo"). Each finished slot still opens to its considered
              items and their put-back; the headline and the green bar are the
              all-clear. */}
          {
            <div className="space-y-3">
              {[...summary.started, ...summary.later].map((group) => {
                const key = slotGroupKey(group)
                return (
                  <ReminderSlotGroup
                    key={key}
                    slotKey={key}
                    scrollRequest={slotScroll?.key === key ? slotScroll.seq : undefined}
                    onScrollServed={slotScrollServed}
                    group={group}
                    started={summary.started.includes(group)}
                    open={isOpen(key) && (groupWaiting(group) > 0 || hasConsideredRows(group))}
                    expanded={expandedKeys.has(key)}
                    onToggle={() => toggleOpen(key)}
                    onExpand={(expanded) => setExpanded(key, expanded)}
                    completingIds={completingIds}
                    selectedIds={selectedIds}
                    isSelectionMode={actions.isSelectionMode}
                    highlightId={highlightId}
                    rowHandlers={rowHandlers}
                    onCompleteGroup={considerAll.askSlot}
                    onPutBack={putBack}
                    onOpenDetail={openDetail}
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
      {!loading && notToday.length > 0 && (
        <NotTodayFold
          items={notToday}
          onOpen={openDetail}
          requestOpen={openNotToday}
          highlightId={highlightId}
          onHighlightDone={clearHighlight}
        />
      )}

      <ReminderSelectionBar
        // Counted from the rows on screen, like the two counts below it: a key
        // whose row has gone (handled on another device, a merged daily row)
        // must neither inflate "N selected" nor, as a prompt, hide Trash wrongly.
        selectedCount={selectedTasks.length + selectedPrompts.length}
        reminderCount={selectedTasks.length}
        promptCount={selectedPrompts.length}
        onConsidered={actions.considerSelection}
        onDelete={actions.deleteSelection}
        onDetails={() =>
          selectedPrompts.length > 0
            ? void prompts.openQuotas(selectedPrompts)
            : setDetailTasks(selectedTasks)
        }
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
      {prompts.modal}
    </section>
  )
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
