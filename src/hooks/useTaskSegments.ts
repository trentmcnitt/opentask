'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DateTime } from 'luxon'
import { showToast } from '@/lib/toast'
import {
  openTaskToday,
  effectiveHorizon,
  type HorizonValue,
  type SegmentKind,
  type SegmentLeft,
  type SegmentState,
  type UpcomingSection,
} from '@/lib/task-segments'
import { HORIZON_LABELS, NOT_TODAY, SEGMENT_TITLES } from '@/lib/task-model-words'
import { growStep } from '@/lib/aged-out'
import type { TaskSegmentPayload } from '@/hooks/useReminders'
import { deckErrorMessage, deckToastMessage, sendDeck } from '@/lib/deck-request'
import type { Task } from '@/types'
import { useDayStart } from '@/components/PreferencesProvider'
import { openTaskDaysBetween } from '@/lib/opentask-day'
import {
  activePending,
  addPending,
  dropPending,
  nextPendingToken,
  settlePending,
  type PendingMap,
} from '@/lib/pending-overlay'

/**
 * The task segments' actions (2026-10-10, docs/TASK-MODEL.md § Task segments).
 *
 * OPTIMISTIC: a tap changes the row at once (perf is Trent's top irritation),
 * then the request goes out and the surface refreshes. The overlay is a map of
 * task id → what the tap made of it; a failure takes the entry back out and
 * says so. An entry is drawn until a payload requested AFTER its write
 * answered is on screen (`src/lib/pending-overlay.ts`, 2026-10-26): never
 * dropped against an older payload, which brought a burst's rows back for a
 * moment and moved the next tap onto the wrong row. Every write has an Undo on its toast — a misfire is undone with the
 * standard Undo (spec §3), never a confirm.
 *
 * - circle → consider: "I saw it", never a completion
 * - checkbox → done (`POST /api/tasks/{id}/done`, the same as a dashboard tick)
 * - Target today → a deliberate target today; the row leaves the segment
 * - Target at… (hold or right-click on Today, 2026-10-12) → the same request
 *   with the picked moment (`at`). The row leaves, whatever the day: today it
 *   is over target, a later day makes it quiet until then (spec §1 — a
 *   targeted one-off is in no horizon segment, and set today it has no
 *   heads-up today)
 * - Remove target (Upcoming's one-off rows, 2026-10-12) →
 *   `PATCH { target_at: null }`; the task goes back to its horizon segment —
 *   or, with a deadline (2026-10-22, it replaced "Back to auto"), onto the
 *   deadlines page from its lead day (quiet before it, rule 3)
 * - Repeating Upcoming rows have Today and its picker too (§6: moving the
 *   target leaves the occurrence where it was), but no target reset
 * - Defer All → everything still waiting in that segment, back tomorrow
 * - Considered all (task queue PR 3, spec rule 9) → every row still waiting
 *   in that segment considered in ONE call to /api/task-segments/consider —
 *   one undo entry, Undo on the toast. A queued one-off leaves the queue for
 *   its horizon segment (ticked there today); a waiting repeating task stays
 * - a HOLD on the row (or right-click, or Cmd/Ctrl+Enter; 2026-10-20 — it
 *   replaced the pencil) → `openPeek`: the row's read-only bubble
 *   (`RowPeekPopover`, the reminder rows' own). Its Open → `openDetails`: the
 *   Quick panel for that task (`SegmentDetailsModal`, which each surface
 *   renders); its trash can → `remove`: a soft delete, Undo on the toast
 * - On deck tomorrow (2026-10-20) → `deck(task, deckTomorrowDay(...))`: one
 *   tap, the hold menu's Tomorrow
 * - On deck (D2, 2026-10-20) → `POST /api/tasks/deck`: a tap decks it for
 *   today, or takes a today's deck off (A10); a hold picks the day. The row
 *   leaves at once, like Today: today's deck is in the dashboard's On deck
 *   section, a later one in Upcoming (on its heads-up days), an un-decked one
 *   back in its horizon segment. A refusal (A1) comes back as a 200 with
 *   nothing changed: the row comes back and the toast says why
 *   (`src/lib/deck-request.ts`)
 * - horizon chip → a new horizon (the row may change segment on refresh; the
 *   toast then says "Moved to <panel title>", e.g. "Moved to Months")
 *
 * THE DEADLINES PAGE (2026-10-22, docs/TASK-MODEL.md § The deadlines page):
 * - circle → consider, as anywhere — except in the SAFETY NET (from the day
 *   before the deadline), where seeing never silences: the row stays,
 *   waiting, marked seen (`{ seen: true }`), its circle a ring
 * - Defer → `deferLead(task, day)`: `POST /api/task-segments/defer-lead`,
 *   this instance's lead day moved to `day` (tomorrow … D−2); the row leaves,
 *   counted as handled ("· deferred to Thu"). A per-task refusal comes back as
 *   a 200 with nothing moved: the row comes back and the toast says why
 * - On deck → the row STAYS on the page with its deck day, unless the deck
 *   is for today outside the safety net (then the On deck section holds it —
 *   plan §4's de-duplication)
 */

/**
 * What a tap made of a row until the refresh. `{ left }` (the day roster,
 * 2026-10-22): the row LEFT the segment handled — decked, targeted or done —
 * so it is listed as considered, counted in N and M, as the server will send
 * it (`segment_left`). 'gone': it left unhandled (trashed), out of M.
 */
type Overlay =
  | SegmentState
  | 'gone'
  /**
   * `left`: as above. `seen` (the deadlines page's safety net): considered
   * but still waiting. `patch`: fields the tap changed on a row that stays
   * (a deck day on the deadlines page; the lead day a Defer moved).
   */
  | { left?: SegmentLeft; seen?: boolean; patch?: Partial<Task> }

export interface SegmentRow {
  task: Task
  state: SegmentState
  /** A repeating task's occurrence (Upcoming): circle and done only. */
  recurring: boolean
  /**
   * How a row that LEFT the segment today was handled (the day roster,
   * src/core/tasks/segment-roster.ts): considered, with no put-back.
   */
  left?: SegmentLeft
  /**
   * The deadlines page (2026-10-22): the safety net holds it — from the day
   * before the deadline seeing does not silence it (the row stays waiting;
   * no Defer).
   */
  safetyNet?: boolean
  /** The deadlines page: seen (considered) this OpenTask day. */
  seen?: boolean
  /**
   * Upcoming's section (2026-10-25, the Upcoming split): 'tomorrow' (the day
   * before its anchor) or 'later'. Only on Upcoming rows; a row the server
   * sent without one (it always sends it) reads as Later.
   */
  section?: UpcomingSection
  /**
   * PULLED (2026-10-29, `mergePulled`): which of the queue's two panels the
   * row came from — Today's pulls or the earlier ones. Only on the merged
   * Pulled view's rows; the row acts as its own kind.
   */
  pulled?: PulledSection
}

export type PulledSection = 'today' | 'earlier'

export interface SegmentView {
  horizon: SegmentKind
  rows: SegmentRow[]
  waiting: number
  considered: number
  deferred: number
  nudge: boolean
  /** The merged Pulled view (`mergePulled`): Today's and earlier pulls as one. */
  pulled?: true
}

interface UseTaskSegmentsOptions {
  segments: TaskSegmentPayload[]
  /** The request seq of the `segments` payload (`useReminders().payloadSeq`). */
  payloadSeq: number
  /** The reminders fetch's latest request seq now (`useReminders().requestSeq`). */
  requestSeq: () => number
  /** The user's timezone, for the Today menu's toast. */
  timezone: string
  refresh: () => Promise<void>
  /** Undo the last action (the toast's Undo); awaited when it returns a promise. */
  onUndo: () => void | Promise<unknown>
  onCompleted?: () => void
}

/**
 * One of this surface's own writes, by the undo entry it wrote: its rows, and
 * whether its toast's Undo has already put them back (the token of that
 * overlay) — `useUndoRestore`.
 */
interface OwnWrite {
  ids: number[]
  restored: number | null
}
/** How many of this surface's own writes an `undone_id` can name. */
const OWN_WRITES_KEPT = 20

async function post(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as { error?: string; data?: unknown } | null
  if (!res.ok) throw new Error(json?.error || 'Request failed')
  return json?.data
}

export function useTaskSegments({
  segments,
  payloadSeq,
  requestSeq,
  timezone,
  refresh,
  onUndo,
  onCompleted,
}: UseTaskSegmentsOptions) {
  const [pending, setPending] = useState<PendingMap<number, Overlay>>(new Map())
  const ops = usePendingOps(setPending, requestSeq)
  // Undo puts a write's rows back at once (`useUndoRestore`).
  const undos = useUndoRestore(ops, refresh)
  // Each tap's change, until the payload on screen was requested after its
  // write answered (`src/lib/pending-overlay.ts`).
  const overlay = useMemo(() => activePending(pending, payloadSeq), [pending, payloadSeq])
  const view = useMemo(
    () => listedSegments(mergePulled(segmentViews(segments, overlay))),
    [segments, overlay],
  )
  // Which rows are the deadlines page's, and which of those its safety net
  // holds — what a consider or a deck does to a row depends on it. Read
  // through a ref, so the actions keep one identity across refreshes.
  // (Updated after each commit: a tap only ever comes after one.)
  const pageRows = useRef(new Map<number, { safetyNet: boolean }>())
  const pageRowMap = useMemo(() => deadlinePageRows(segments), [segments])
  useEffect(() => {
    pageRows.current = pageRowMap
  }, [pageRowMap])

  const run = useCallback(
    async (
      ids: number[],
      to: Overlay | ((id: number) => Overlay),
      send: () => Promise<unknown>,
      message: string,
    ) => {
      const wasWaiting = waitingIds(view, ids)
      const token = ops.add(ids, to)
      try {
        const data = await send()
        ops.settle(ids, token)
        undoToast(message, wasWaiting ? data : null, ids, undos, onUndo)
        onCompleted?.()
      } catch (err) {
        ops.drop(ids, token)
        showToast({
          message: err instanceof Error && err.message ? err.message : 'Something went wrong',
          type: 'error',
        })
      } finally {
        void refresh()
      }
    },
    [ops, onUndo, onCompleted, refresh, view, undos],
  )

  // In the safety net a consider marks the row seen and keeps it waiting.
  const considered = useCallback(
    (id: number): Overlay => (pageRows.current.get(id)?.safetyNet ? { seen: true } : 'considered'),
    [],
  )
  const consider = useCallback(
    (task: Task) =>
      run(
        [task.id],
        considered,
        () => post('/api/task-segments/consider', { ids: [task.id] }),
        'Considered',
      ),
    [run, considered],
  )
  const { keep, grow } = useAgedOutActions(run)
  const done = useCallback(
    (task: Task) =>
      run(
        [task.id],
        { left: 'done' },
        () => post(`/api/tasks/${task.id}/done`, {}),
        `Done: “${task.title}”`,
      ),
    [run],
  )
  const targetToday = useCallback(
    (task: Task) =>
      run(
        [task.id],
        { left: 'target' },
        () => post('/api/task-segments/target-today', { ids: [task.id] }),
        // Says what did NOT happen: Today sits beside Done, and a mis-tap
        // read as a check-off until the toast (2026-10-12).
        `Targeted for today, not done: “${task.title}”`,
      ),
    [run],
  )
  const picker = useTargetPicker(run, timezone)
  const deferAll = useCallback(
    (segment: SegmentView) => {
      const ids = segment.rows.filter((r) => r.state === 'waiting').map((r) => r.task.id)
      if (ids.length === 0) return
      return run(
        ids,
        'deferred',
        () => post('/api/task-segments/defer', { ids }),
        `${NOT_TODAY}: ${nTasks(ids.length)}, back tomorrow`,
      )
    },
    [run],
  )
  const setHorizon = useSetHorizon(onUndo, refresh, onCompleted)

  // Put back (2026-10-11): a considered or deferred row from "Show N
  // considered" waits again — the slots' put-back.
  const restore = useCallback(
    (task: Task) =>
      run(
        [task.id],
        'waiting',
        () => post('/api/task-segments/restore', { ids: [task.id] }),
        `Put back: “${task.title}”`,
      ),
    [run],
  )

  const considerAll = useConsiderAll(run, considered)
  const deferLead = useDeferLead(ops, onUndo, refresh, onCompleted)
  // The peek bubble's Open: the Quick panel, which task is open
  // (`SegmentDetailsModal`).
  const [detailsTask, setDetailsTask] = useState<Task | null>(null)
  const peek = useRowPeek()
  const remove = useRemoveTask(run)

  const removeTarget = useRemoveTarget(run)
  const deck = useDeck(ops, timezone, onUndo, refresh, onCompleted, pageRows)
  const bulk = useBulkSegmentActions(run, considered)
  const actions = {
    ...bulk,
    deck,
    deferLead,
    consider,
    considerAll,
    keep,
    grow,
    done,
    targetToday,
    deferAll,
    setHorizon,
    restore,
    removeTarget,
    remove,
  }
  return {
    segments: view,
    ...actions,
    ...picker,
    detailsTask,
    openDetails: setDetailsTask as (task: Task) => void,
    closeDetails: () => setDetailsTask(null),
    ...peek,
    refresh,
    /** The undo pipeline's `undone_id` (`useUndoRedo`'s `onUndone`). */
    applyUndone: undos.applyUndone,
  }
}

/**
 * Whether every one of `ids` is waiting now (read before a tap): only those go
 * back to waiting on an undo — a consider, done, Today, Defer all, the Target
 * menu all take waiting rows off their list.
 */
function waitingIds(view: SegmentView[], ids: number[]): boolean {
  const waiting = new Set(
    view.flatMap((s) => s.rows.filter((r) => r.state === 'waiting').map((r) => r.task.id)),
  )
  return ids.every((id) => waiting.has(id))
}

/**
 * A write's toast. When the write answered with the undo entry it wrote
 * (`data.undo_id`) and its rows were waiting, its Undo puts them back at once
 * (`useUndoRestore`); otherwise it is the plain undo.
 */
function undoToast(
  message: string,
  data: unknown,
  ids: number[],
  undos: UndoRestore,
  onUndo: () => void | Promise<unknown>,
): void {
  const undoId = (data as { undo_id?: unknown } | null)?.undo_id
  if (typeof undoId === 'number') undos.remember(undoId, ids)
  const onClick =
    typeof undoId === 'number' ? () => void undos.undoFromToast(undoId, onUndo) : onUndo
  showToast({ message, type: 'success', action: { label: 'Undo', onClick } })
}

/**
 * UNDO PUTS A SEGMENT ROW BACK AT ONCE (Trent, 2026-10-29: "undoing is quite
 * laggy when I consider one of the heads-up items"; the reminder rows' twin
 * is `src/lib/reminder-undo.ts`). A write that took waiting rows off their
 * list records the undo entry it wrote (`remember`). Then:
 * - the toast's Undo draws them waiting again before any request
 *   (`undoFromToast`): an overlay of its own, replacing the write's;
 * - an undo that names the entry — the toast's own, or the header's — keeps
 *   that overlay (or draws it, for the header) until a payload requested after
 *   the undo answered (`applyUndone`: settled at the guard's mark then, just
 *   before the pipeline's refresh goes out — `src/lib/pending-overlay.ts`);
 * - a toast Undo the answer did not name (it undid something else, or
 *   nothing) settles at the current mark and refreshes: the server's state
 *   shows, whatever it is.
 */
type UndoRestore = ReturnType<typeof useUndoRestore>

function useUndoRestore(ops: PendingOps, refresh: () => Promise<void>) {
  const own = useRef(new Map<number, OwnWrite>())
  return useMemo(() => {
    const putBack = (write: OwnWrite) => {
      write.restored ??= ops.add(write.ids, 'waiting')
      return write.restored
    }
    return {
      remember(undoId: number, ids: number[]) {
        own.current.set(undoId, { ids, restored: null })
        if (own.current.size > OWN_WRITES_KEPT) {
          own.current.delete(own.current.keys().next().value as number)
        }
      },
      async undoFromToast(undoId: number, onUndo: () => void | Promise<unknown>) {
        const write = own.current.get(undoId)
        if (!write) return void (await onUndo())
        const token = putBack(write)
        await onUndo()
        // Still remembered: the undo's answer did not name this write.
        if (own.current.get(undoId) === write) {
          own.current.delete(undoId)
          ops.settle(write.ids, token)
          void refresh()
        }
      },
      applyUndone(undoneId: number) {
        const write = own.current.get(undoneId)
        if (!write) return
        own.current.delete(undoneId)
        ops.settle(write.ids, putBack(write))
      },
    }
  }, [ops, refresh])
}

/**
 * The segments as drawn: the payload with each tap's overlay over its row. A
 * `{ left }` overlay is a considered row that left the segment handled (the
 * day roster); 'gone' drops the row. A segment with no rows is dropped by the caller.
 */
function segmentViews(
  segments: TaskSegmentPayload[],
  overlay: Map<number, Overlay>,
): SegmentView[] {
  // AN EMPTY SEGMENT IS HIDDEN (Trent, 2026-10-30, reversing 10-24's "always
  // show every queue segment, every day"): the server still sends every kind
  // (`?fill=1`), and `useTaskSegments` drops — after Pulled's merge — one
  // with no rows today, none waiting and none considered. Its place stays
  // fixed (`SEGMENT_ORDER`); only its presence changes. A segment finished
  // today keeps its rows (considered, deferred, or left handled — the day
  // roster), so it stays, green, until the rollover. Trent: "people that
  // really don't use deadlines will just never see a deadline section".
  return segments.map((seg) => {
    const rows = seg.tasks
      .map((t) => {
        const o = overlay.get(t.id)
        const obj = typeof o === 'object' ? o : null
        const left = obj ? obj.left : o === undefined ? t.segment_left : undefined
        const state = obj ? (obj.left ? 'considered' : t.segment_state) : (o ?? t.segment_state)
        return {
          task: (obj?.patch ? { ...t, ...obj.patch } : t) as Task,
          state,
          recurring: t.recurring ?? t.rrule !== null,
          ...(left ? { left } : {}),
          ...(t.safety_net ? { safetyNet: true } : {}),
          ...(obj?.seen || t.seen ? { seen: true } : {}),
          ...(seg.horizon === 'upcoming' ? { section: t.upcoming_section ?? 'later' } : {}),
        }
      })
      .filter((r): r is SegmentRow => r.state !== 'gone')
    const count = (s: SegmentState) => rows.filter((r) => r.state === s).length
    return {
      horizon: seg.horizon,
      rows,
      waiting: count('waiting'),
      considered: count('considered'),
      deferred: count('deferred'),
      nudge: seg.nudge,
    }
  })
}

/**
 * RULE SEG-PULLED-MERGE: The web merges queue_today and queue_previous into one view in
 *   queue_today's place. Rows are tagged today or earlier and the counts are summed. The server's
 *   two kinds and the native caches are unchanged.
 * Why: One strip bar, one page and one "N of M" for the pulls; the server's kinds and the native
 *   apps are unchanged.
 * Ruling: Trent 2026-10-29 ('just have pulls … Today … Earlier', src/hooks/useTaskSegments.ts:487).
 */
/**
 * PULLED, ONE SEGMENT (Trent, 2026-10-29: "just have pulls and then the
 * first thing is Today and the other section is Earlier"): the queue's two
 * panels — Today's pulls, Previous pulls — drawn as ONE segment in the web
 * (one strip bar, one page, one "N of M"), each row tagged with the panel it
 * came from (`pulled`) for its section heading. Only the view merges: the
 * server's two kinds, their order and the native apps are unchanged, and each
 * row still acts as its own kind (Try Tomorrow's mark is a Today's pull's).
 * The merged view takes Today's pulls' place and kind (`queue_today`).
 */
export function mergePulled(views: SegmentView[]): SegmentView[] {
  const today = views.find((v) => v.horizon === 'queue_today')
  const earlier = views.find((v) => v.horizon === 'queue_previous')
  if (!today && !earlier) return views
  const parts: [SegmentView | undefined, PulledSection][] = [
    [today, 'today'],
    [earlier, 'earlier'],
  ]
  const merged: SegmentView = {
    horizon: 'queue_today',
    pulled: true,
    rows: parts.flatMap(([v, pulled]) => (v ? v.rows.map((r) => ({ ...r, pulled })) : [])),
    waiting: (today?.waiting ?? 0) + (earlier?.waiting ?? 0),
    considered: (today?.considered ?? 0) + (earlier?.considered ?? 0),
    deferred: (today?.deferred ?? 0) + (earlier?.deferred ?? 0),
    nudge: !!today?.nudge || !!earlier?.nudge,
  }
  const at = views.findIndex((v) => v === today || v === earlier)
  const rest = views.filter((v) => v !== today && v !== earlier)
  return [...rest.slice(0, at), merged, ...rest.slice(at)]
}

/**
 * RULE SEG-VISIBLE-WEB: The client drops a segment kind that has no rows today, waiting or
 *   considered, after Pulled's merge. A segment finished today keeps its rows. The order stays
 *   fixed.
 * Why: People who never use a kind never see its section ("people that really don't use
 *   deadlines will just never see a deadline section").
 * Ruling: Trent 2026-10-30: 'people that really don't use deadlines will just never see a
 *   deadline section'.
 */
/**
 * The segments the web lists (2026-10-30): every one that holds a row today —
 * waiting, considered or left — in the order given. The server's `fill`
 * (`?fill=1`) still sends every kind; only the display drops the empty ones.
 */
export function listedSegments(views: SegmentView[]): SegmentView[] {
  return views.filter((v) => v.rows.length > 0)
}

/**
 * The rows a consider still changes: waiting ones — but not a deadlines-page
 * row its safety net holds that was already seen today (it stays waiting
 * whatever is done to it but a target or done). "Considered all" offers
 * itself, counts and acts on these.
 */
export function toConsider(segment: SegmentView): SegmentRow[] {
  return segment.rows.filter((r) => r.state === 'waiting' && !(r.safetyNet && r.seen))
}

/** The deadlines page's rows, by id, with whether its safety net holds each. */
function deadlinePageRows(segments: TaskSegmentPayload[]): Map<number, { safetyNet: boolean }> {
  const rows = new Map<number, { safetyNet: boolean }>()
  for (const seg of segments) {
    if (seg.horizon !== 'deadlines') continue
    for (const t of seg.tasks) rows.set(t.id, { safetyNet: !!t.safety_net })
  }
  return rows
}

/**
 * Which row's PEEK BUBBLE is open, if any (2026-10-20) — one id rather than a
 * flag per row: only ever one bubble at a time (the reminder panel's
 * `peekId`). `viaKeyboard`: opened with Cmd/Ctrl+Enter, so focus moves in.
 */
function useRowPeek() {
  const [peek, setPeek] = useState<{ id: number; viaKeyboard: boolean } | null>(null)
  const openPeek = useCallback(
    (task: Task, viaKeyboard = false) => setPeek({ id: task.id, viaKeyboard }),
    [],
  )
  const closePeek = useCallback(() => setPeek(null), [])
  return { peek, openPeek, closePeek }
}

/**
 * The peek bubble's trash can: the reminder bubble's own delete (bulk delete,
 * soft), optimistic — the row leaves — with Undo on the toast.
 */
function useRemoveTask(run: RunSegmentAction) {
  return useCallback(
    (task: Task) =>
      run(
        [task.id],
        'gone',
        () => post('/api/tasks/bulk/delete', { ids: [task.id] }),
        `Moved “${task.title}” to Trash`,
      ),
    [run],
  )
}

/**
 * The horizon dot's menu (switch off) — a PATCH of `horizon`, with Undo. Not
 * through `run`: the row stays where it is until the refresh says otherwise.
 */
function useSetHorizon(onUndo: () => void, refresh: () => Promise<void>, onCompleted?: () => void) {
  return useCallback(
    async (task: Task, horizon: HorizonValue | null, segment?: SegmentKind) => {
      try {
        const res = await fetch(`/api/tasks/${task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ horizon }),
        })
        if (!res.ok) throw new Error('Could not change the horizon')
        showToast({
          message: horizonToast(task, horizon, segment),
          type: 'success',
          action: { label: 'Undo', onClick: onUndo },
        })
        onCompleted?.()
      } catch (err) {
        showToast({ message: err instanceof Error ? err.message : 'Failed', type: 'error' })
      } finally {
        void refresh()
      }
    },
    [onUndo, onCompleted, refresh],
  )
}

/**
 * AGED OUT (2026-10-29, src/lib/aged-out.ts): the row's consider is Process's
 * keep (comes back one threshold later, "kept N×"); Grow moves the horizon
 * one step out. Either way the row stays today, considered.
 */
function useAgedOutActions(run: RunSegmentAction) {
  const keep = useCallback(
    (task: Task) =>
      run(
        [task.id],
        // Considered, and drawn with the new count until the payload has it.
        { left: 'considered', patch: { growth_kept_count: task.growth_kept_count + 1 } },
        () => post('/api/task-segments/keep', { ids: [task.id] }),
        `Kept the horizon: “${task.title}”`,
      ),
    [run],
  )
  // `pick`: the hold menu's horizon; omitted, one step out.
  const grow = useCallback(
    (task: Task, pick?: HorizonValue) => {
      const to = pick ?? growStep(task.horizon)
      if (!to || to === task.horizon) return
      return run(
        [task.id],
        { left: 'considered', patch: { horizon: to, growth_kept_count: 0 } },
        () =>
          post('/api/task-segments/grow', { ids: [task.id], ...(pick ? { horizon: pick } : {}) }),
        `Horizon now ${HORIZON_LABELS[to]}: “${task.title}”`,
      )
    },
    [run],
  )
  return { keep, grow }
}

/**
 * Considered all (task queue PR 3, spec rule 9): every row still waiting in
 * the segment, in one consider call — one undo entry, Undo on the toast.
 */
function useConsiderAll(run: RunSegmentAction, considered: (id: number) => Overlay) {
  return useCallback(
    (segment: SegmentView) => {
      const ids = toConsider(segment).map((r) => r.task.id)
      if (ids.length === 0) return
      // Aged out (2026-10-29): considering there is Process's keep.
      const keep = segment.horizon === 'aged_out'
      const n = ids.length === 1 ? '1 task' : `${ids.length} tasks`
      return run(
        ids,
        considered,
        () => post(`/api/task-segments/${keep ? 'keep' : 'consider'}`, { ids }),
        keep ? `Kept the horizon of ${n}` : `Considered ${n}`,
      )
    },
    [run, considered],
  )
}

/** One tap's optimistic change, from the tap to the payload that includes it. */
interface PendingOps {
  /** Draws `value` over `ids` now; returns the tap's token. */
  add(ids: number[], value: Overlay | ((id: number) => Overlay)): number
  /** The write answered: drawn until a payload requested from now on is on screen. */
  settle(ids: number[], token: number): void
  /** The write failed or changed nothing: the rows go back at once. */
  drop(ids: number[], token: number): void
}

function usePendingOps(
  setPending: React.Dispatch<React.SetStateAction<PendingMap<number, Overlay>>>,
  requestSeq: () => number,
): PendingOps {
  return useMemo(
    () => ({
      add(ids, value) {
        const token = nextPendingToken()
        setPending((prev) => addPending(prev, ids, value, token))
        return token
      },
      settle(ids, token) {
        // Read now, not in the updater: the mark is the moment the write answered.
        const settledAt = requestSeq()
        setPending((prev) => settlePending(prev, ids, token, settledAt))
      },
      drop(ids, token) {
        setPending((prev) => dropPending(prev, ids, token))
      },
    }),
    [setPending, requestSeq],
  )
}

type RunSegmentAction = (
  ids: number[],
  to: Overlay | ((id: number) => Overlay),
  send: () => Promise<unknown>,
  message: string,
) => Promise<void>

/**
 * On deck (D2): like `run`, optimistic — the row leaves — but the answer
 * decides: a deck write that changed nothing (an A1 refusal, a skipped kind)
 * puts the row back and toasts the server's reason as an error.
 */
function useDeck(
  ops: PendingOps,
  timezone: string,
  onUndo: () => void,
  refresh: () => Promise<void>,
  onCompleted: (() => void) | undefined,
  pageRows: { current: Map<number, { safetyNet: boolean }> },
) {
  const dayStart = useDayStart()
  return useCallback(
    async (task: Task, day: string | null | undefined) => {
      // Decked: handled today, counted (the day roster). Taken off deck (an
      // Upcoming deck row): the deck's consider stamp stays, so the server
      // keeps it here as handled (`segment_left: 'considered'`) — the same.
      const token = ops.add([task.id], deckOverlay(task, day, timezone, dayStart, pageRows))
      const putBack = () => ops.drop([task.id], token)
      try {
        const result = await sendDeck([task.id], day)
        const message = deckToastMessage(result, task.title, timezone, dayStart)
        if (message) {
          ops.settle([task.id], token)
          toastResult(message, onUndo)
          onCompleted?.()
        } else {
          putBack()
          showToast({ message: deckErrorMessage(result, task), type: 'error' })
        }
      } catch (err) {
        putBack()
        showToast({
          message: err instanceof Error && err.message ? err.message : 'Something went wrong',
          type: 'error',
        })
      } finally {
        void refresh()
      }
    },
    [ops, timezone, dayStart, onUndo, refresh, onCompleted, pageRows],
  )
}

/**
 * What a deck does to its row until the refresh. On the DEADLINES page
 * (Trent, 2026-10-22) a decked row STAYS, waiting, showing its deck day — the
 * server does not stamp it considered (`deckKeepsPageRow`) — except a deck for
 * today outside the safety net, which the On deck section holds (it leaves,
 * handled). Taking a deck off keeps the row as it is. Elsewhere: decked →
 * handled; taken off → handled too.
 */
function deckOverlay(
  task: Task,
  day: string | null | undefined,
  timezone: string,
  dayStart: string,
  pageRows: { current: Map<number, { safetyNet: boolean }> },
): Overlay {
  const page = pageRows.current.get(task.id)
  if (!page) return { left: day === null ? 'considered' : 'deck' }
  const today = openTaskToday(timezone, new Date(), dayStart)
  const deckDay = day === undefined ? today : day
  if (deckDay === today && !page.safetyNet) return { left: 'deck' }
  return { patch: { on_deck_day: deckDay } }
}

/**
 * DEFER ON THE DEADLINES PAGE (2026-10-22; A3: tap + pick): this instance's
 * lead day moved to `day` (`POST /api/task-segments/defer-lead`). Optimistic
 * — the row leaves, counted as handled, "· deferred to Thu" — but the answer
 * decides: a refusal (the safety net has it, a day too close to the
 * deadline) moves nothing, so the row comes back and the toast says why.
 */
function useDeferLead(
  ops: PendingOps,
  onUndo: () => void,
  refresh: () => Promise<void>,
  onCompleted?: () => void,
) {
  return useCallback(
    async (task: Task, day: string) => {
      const token = ops.add([task.id], { left: 'deferred', patch: { lead_from: day } })
      const putBack = () => ops.drop([task.id], token)
      try {
        const result = (await post('/api/task-segments/defer-lead', {
          ids: [task.id],
          day,
        })) as { deferred: number; refused: { message: string }[]; summary: string } | undefined
        if (result && result.deferred > 0) {
          ops.settle([task.id], token)
          toastResult(`${result.summary}: “${task.title}”`, onUndo)
          onCompleted?.()
        } else {
          putBack()
          showToast({
            message: result?.refused?.[0]?.message ?? 'Could not defer this task',
            type: 'error',
          })
        }
      } catch (err) {
        putBack()
        showToast({
          message: err instanceof Error && err.message ? err.message : 'Something went wrong',
          type: 'error',
        })
      } finally {
        void refresh()
      }
    },
    [ops, onUndo, refresh, onCompleted],
  )
}

/**
 * Remove target (2026-10-12, `targetReset`): the same PATCH the dashboard's
 * row menu sends. With no deadline the task goes back to its horizon segment;
 * with one (2026-10-22) onto the deadlines page from its lead day. Either way
 * the row leaves Upcoming; Undo restores the target and `target_set_at`.
 */
function useRemoveTarget(run: RunSegmentAction) {
  return useCallback(
    (task: Task) =>
      run(
        [task.id],
        'gone',
        () => patchTask(task.id, { target_at: null }),
        `Target removed: “${task.title}”`,
      ),
    [run],
  )
}

/**
 * A write's toast, with Undo. (Target-today no longer skips repeating tasks —
 * §6 keeps the occurrence apart from the target, 2026-10-12 — so its
 * `skipped_recurring` is always empty and needs no wording.)
 */
function toastResult(message: string, onUndo: () => void): void {
  showToast({ message, type: 'success', action: { label: 'Undo', onClick: onUndo } })
}

async function patchTask(id: number, body: unknown): Promise<unknown> {
  const res = await fetch(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as { error?: string; data?: unknown } | null
  if (!res.ok) throw new Error(json?.error || 'Request failed')
  return json?.data
}

/**
 * The Today button's menu and picker (2026-10-12, a menu since 10-14): the
 * targeting each choice sends (`at`), through the same optimistic `run`.
 */
function useTargetPicker(run: RunSegmentAction, timezone: string) {
  const dayStart = useDayStart()
  const targetAt = useCallback(
    (task: Task, at: string) => {
      return run(
        [task.id],
        // Any day: the row leaves. A targeted one-off is in no horizon
        // segment (spec §1, 2026-10-12), and one targeted today has no
        // heads-up today — the refresh shows the same. It still counts, as
        // handled today (the day roster).
        { left: 'target' },
        () => post('/api/task-segments/target-today', { ids: [task.id], at }),
        `Targeted ${targetWhen(at, timezone, dayStart)}: “${task.title}”`,
      )
    },
    [run, timezone, dayStart],
  )
  return { targetAt }
}

/**
 * "today 3:00 PM", "tomorrow 9:00 AM", "Tue, Oct 13 3:00 PM" — the picker's
 * toast. Also the dashboard rows' Today toast (`useTaskActions.handleTargetAt`).
 * "today" / "tomorrow" are OpenTask days (`dayStart`, "Day starts at" PR 2).
 */
export function targetWhen(
  atIso: string,
  timezone: string,
  dayStart: string,
  now: Date = new Date(),
): string {
  const when = DateTime.fromISO(atIso, { zone: 'utc' }).setZone(timezone)
  const time = when.toFormat('h:mm a')
  const gap = openTaskDaysBetween(now, new Date(atIso), timezone, dayStart)
  if (gap === 0) return `today ${time}`
  if (gap === 1) return `tomorrow ${time}`
  return `${when.toFormat('ccc, LLL d')} ${time}`
}

/**
 * The horizon chip's toast. When the change moves the row to another segment,
 * it says where it went, by the panel's title ("Moved to Months", 2026-10-11;
 * the title since 2026-10-20) — the row is about to leave the list, and
 * "Horizon: Months" didn't say that. Compared on the EFFECTIVE horizon (a
 * deadline can pull a task in, so a new set horizon may leave it where it
 * is); unchanged, it keeps the plain "Horizon: X".
 */
function horizonToast(task: Task, horizon: HorizonValue | null, segment?: SegmentKind): string {
  if (segment) {
    const next = effectiveHorizon({ horizon, deadline_at: task.deadline_at }, new Date())
    if (next !== segment) return `Moved to ${SEGMENT_TITLES[next]}`
  }
  return horizon ? `Horizon: ${HORIZON_LABELS[horizon]}` : 'Horizon cleared'
}

export type TaskSegmentActions = ReturnType<typeof useTaskSegments>

/** "3 tasks" / "1 task". */
const nTasks = (n: number) => (n === 1 ? '1 task' : `${n} tasks`)

/**
 * THE QUEUE'S SELECT MODE (the U1 bar, Trent 2026-10-30): its verbs for
 * several rows at once — each ONE request (one undo entry), drawn at once
 * like a row's own tap (`run`), with Undo on its toast.
 */
function useBulkSegmentActions(run: RunSegmentAction, considered: (id: number) => Overlay) {
  return useMemo(
    () => ({
      considerMany: (ids: number[]) =>
        run(
          ids,
          considered,
          () => post('/api/task-segments/consider', { ids }),
          `Considered ${nTasks(ids.length)}`,
        ),
      doneMany: (ids: number[]) =>
        run(
          ids,
          { left: 'done' },
          () => post('/api/tasks/bulk/done', { ids }),
          `Done: ${nTasks(ids.length)}`,
        ),
      /** Not today: off today's list, back tomorrow (`/api/task-segments/defer`). */
      notTodayMany: (ids: number[]) =>
        run(
          ids,
          'deferred',
          () => post('/api/task-segments/defer', { ids }),
          `Not today: ${nTasks(ids.length)}`,
        ),
      /** Target: each a target at `at` (Today's long-press time, `target-today`). */
      targetMany: (ids: number[], at: string) =>
        run(
          ids,
          { left: 'target' },
          () => post('/api/task-segments/target-today', { ids, at }),
          `Targeted ${nTasks(ids.length)}`,
        ),
      /** Remove target: the picked targets go (`bulk/edit`, `include_task_ids` past the sweep filter). */
      removeTargetsMany: (ids: number[]) =>
        run(
          ids,
          'gone',
          () =>
            post('/api/tasks/bulk/edit', { ids, changes: { due_at: null }, include_task_ids: ids }),
          `Targets removed: ${nTasks(ids.length)}`,
        ),
      /** Skip until: the repeating ones past this occurrence, or to a day. */
      skipUntilMany: (ids: number[], until: string | null) =>
        run(
          ids,
          { left: 'considered' },
          () => post('/api/tasks/bulk/skip-until', { ids, until }),
          `Skipped: ${nTasks(ids.length)}`,
        ),
      removeMany: (ids: number[]) =>
        run(
          ids,
          'gone',
          () => post('/api/tasks/bulk/delete', { ids }),
          `Moved ${nTasks(ids.length)} to Trash`,
        ),
    }),
    [run, considered],
  )
}
