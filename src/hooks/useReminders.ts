'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { groupBySlot, parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import type { Task } from '@/types'
import { showToast } from '@/lib/toast'
import { summarizeReminders, type RemindersSummary } from '@/lib/reminders-summary'
import {
  applyPromptMoves,
  groupWaiting,
  promptWaiting,
  type QuotaPrompt,
} from '@/lib/quota-prompts'

/**
 * Today's reminders, grouped by time slot (REDESIGN-V03 §6).
 *
 * The server owns both the grouping and the within-slot ordering, so this hook
 * deliberately does no sorting: §6's "priority is prominence" is expressed as
 * position, and position is decided once, server-side, rather than being
 * re-derived by every surface that renders it.
 */
export interface ReminderGroup {
  slot: TimeSlot | null
  reminders: Task[]
  count: number
  /** Considered today in this slot (progress, §6). Reminders only — see `groupConsidered`. */
  considered: number
  /** The considered ones, most recent first — shown behind the counter, each with a way back. */
  consideredItems: Task[]
  /**
   * Quota prompts assigned to this slot today (2026-09-24) — every one, the
   * handled ones included with their flags, so the slot's size stays fixed
   * for the day. A row renders only while `promptWaiting`; handled ones count
   * as considered (`groupConsidered`) but never join `consideredItems`, whose
   * put-back is /undone, which a quota refuses. Undo is the way back.
   */
  prompts: QuotaPrompt[]
}

/** What a prompt tap asked for: the circle, or the square checkbox. */
type PromptIntent = 'consider' | 'did'

/**
 * A prompt after `intent`, and every sibling prompt of the same quota with the
 * count that implies — a did-it on "Daily Walks" in the morning moves the
 * afternoon's row to 1/2 too. The server's own answer replaces this on the
 * next refresh; this is only what the screen shows until then.
 *
 * Skips a prompt the payload already shows as considered: a refresh that
 * lands after the server committed but before the request returned must not
 * count the +1 twice.
 */
function applyPromptIntents(
  groups: ReminderGroup[],
  intents: Map<string, PromptIntent>,
): ReminderGroup[] {
  if (intents.size === 0) return groups
  const all = groups.flatMap((g) => g.prompts)
  const counts = new Map<number, number>()
  for (const p of all) {
    const intent = intents.get(p.prompt_key)
    if (!intent || p.considered) continue
    const current = counts.get(p.task_id) ?? p.current
    if (intent === 'did') {
      counts.set(p.task_id, p.number !== null ? Math.max(current, p.number) : current + 1)
    }
  }
  return groups.map((g) => {
    if (!g.prompts.some((p) => intents.has(p.prompt_key) || counts.has(p.task_id))) return g
    return {
      ...g,
      prompts: g.prompts.map((p) => {
        const intent = intents.get(p.prompt_key)
        const current = counts.get(p.task_id) ?? p.current
        const acted = intent !== undefined && !p.considered
        return {
          ...p,
          current,
          considered: p.considered || acted,
          done: (acted && intent === 'did') || (p.number !== null ? current >= p.number : p.done),
        }
      }),
    }
  })
}

interface UseRemindersOptions {
  /** Undo the last action — wired to the completion toast. */
  onUndo: () => void
  /**
   * Called after a reminder is completed. The page uses this to keep its own
   * undo counter in step; completion here goes through the ordinary /done
   * endpoint, so it produces an ordinary undo entry.
   */
  onCompleted?: () => void
  /**
   * For placing a newly created reminder into its slot at once, before the
   * server's next payload confirms it.
   */
  timeSlots?: TimeSlot[]
  timezone?: string
}

export interface UseRemindersReturn {
  groups: ReminderGroup[]
  total: number
  /**
   * Whether the user has any reminders at all, today or otherwise. Only the empty
   * state uses it — see `hasAnyReminders` in `@/core/tasks/reminders`.
   */
  hasAny: boolean
  loading: boolean
  error: string | null
  /** IDs (and prompt_keys) mid-completion — the row is animating out while the request is in flight. */
  completingIds: Set<number | string>
  /** True once anything has been completed on this surface in this session. */
  consideredAny: boolean
  complete: (task: Task) => Promise<void>
  /**
   * "The row has finished leaving the screen." Called by the row itself when
   * its collapse animation ends (or when it unmounts mid-collapse), and only
   * then does the considered reminder leave `groups`.
   *
   * Completion used to remove the row the instant it was clicked, which made
   * the list reflow under a stationary pointer: the second click of a
   * double-click landed on whichever thought had slid up into the gap and
   * considered that one too. Now the row stays where it is, inert, until it
   * has visibly gone.
   */
  rowLeft: (id: number | string) => void
  /**
   * A row reporting that it is on screen. Returns its own deregistration, so a
   * row can call it straight out of an effect. Only a mounted row can report
   * its animation finishing, so only a mounted row's completion is allowed to
   * hold anything back — see `completeIds`.
   */
  registerRow: (id: number | string) => () => void
  /**
   * True once a fetch has resolved since this hook mounted. The module cache
   * paints the surface instantly on a revisit, so `loading === false` is not
   * the same as "this is the current truth" — anything that must not act on
   * stale data (the `?reminder=` deep link) waits for this instead.
   */
  hydrated: boolean
  /**
   * Complete ("consider") a set of reminders at once — a selection made on the
   * surface, or a whole slot. One bulk call, one undo entry.
   */
  completeMany: (tasks: Task[], prompts?: QuotaPrompt[]) => Promise<void>
  /**
   * Complete every reminder in one slot with a single tap — the container-level
   * gesture the design record calls "my task is to do my reminders".
   */
  completeGroup: (group: ReminderGroup) => Promise<void>
  /** A quota prompt's circle: handled for today, no progress (2026-09-24). */
  considerPrompt: (prompt: QuotaPrompt) => Promise<void>
  /** A quota prompt's square checkbox: did it — progress, and handled. */
  didPrompt: (prompt: QuotaPrompt) => Promise<void>
  /**
   * Show a prompt in another period at once while `save` (the quota's PATCH)
   * runs; the refresh after it reconciles. A failed save puts it back.
   */
  movePrompt: (prompt: QuotaPrompt, toSlotId: number, save: () => Promise<void>) => Promise<void>
  /** Reverse a consideration: the thought returns to waiting. */
  putBack: (task: Task) => Promise<void>
  /** Move reminders to Trash (soft delete), with Undo. */
  remove: (tasks: Task[]) => Promise<void>
  refresh: () => Promise<void>
  /** Reminders with no occurrence today — reachable, never counted. */
  notToday: Task[]
  /**
   * Create a reminder. A daily one is placed in its slot the moment the server
   * answers; any other cadence waits for the refresh, since only the server
   * knows whether it is today's.
   */
  create: (input: ReminderCreateInput) => Promise<Task>
}

export interface ReminderCreateInput {
  title: string
  rrule: string | null
  notes?: string | null
  priority?: number
  /**
   * Hand the text to AI enrichment after creating it. The quick add sets this:
   * it sends a daily-in-this-slot default so the row is on screen at once, and
   * enrichment then reads what was actually typed ("every Friday evening") and
   * corrects the schedule. The form does not — there the user chose.
   */
  enrich?: boolean
}

/**
 * Last successful payload, module-scoped so a revisit to the Reminders surface
 * paints instantly from memory while a background refresh reconciles
 * (stale-while-revalidate). Survives client-side navigation only — sign-out
 * goes through a full page load, which resets module state, so one user's
 * cache cannot leak into another's session.
 */
let remindersCache: { groups: ReminderGroup[]; hasAny: boolean; notToday: Task[] } | null = null

// Anyone showing a number derived from the cache (the nav badge) subscribes
// here and re-renders whenever the surface refreshes or completes something.
const cacheListeners = new Set<() => void>()
function setRemindersCache(next: typeof remindersCache) {
  remindersCache = next
  for (const listener of cacheListeners) listener()
}

/** The API speaks snake_case; the one place its reminder groups become ours. */
function parseGroups(json: unknown): ReminderGroup[] {
  const groups = (json as { data?: { groups?: unknown[] } })?.data?.groups ?? []
  return groups.map((raw) => {
    const g = raw as Omit<ReminderGroup, 'consideredItems'> & { considered_items?: Task[] }
    return {
      slot: g.slot,
      reminders: g.reminders ?? [],
      count: g.count ?? g.reminders?.length ?? 0,
      considered: g.considered ?? 0,
      consideredItems: g.considered_items ?? [],
      prompts: g.prompts ?? [],
    }
  })
}

/**
 * Apply what is still in flight to a payload the server just sent: ids being
 * considered leave `reminders` for `consideredItems`, ids being put back go
 * the other way. Without this a refresh landing mid-request re-inserted the
 * row in its old place (a visible gap, or a thought that flickered back).
 */
function reconcileInFlight(
  incoming: ReminderGroup[],
  pending: Set<number | string>,
  restoring: Set<number>,
  pendingPrompts: Map<string, PromptIntent>,
  pendingMoves: Map<string, number>,
): ReminderGroup[] {
  // Prompts in flight: the same promise as for reminders — a refresh landing
  // mid-request must not bring a handled prompt back, nor a moved one back to
  // the period it just left.
  const withPrompts = applyPromptIntents(applyPromptMoves(incoming, pendingMoves), pendingPrompts)
  if (pending.size === 0 && restoring.size === 0) return withPrompts
  return withPrompts.map((g) => {
    const leaving = g.reminders.filter((r) => pending.has(r.id))
    const returning = g.consideredItems.filter((r) => restoring.has(r.id))
    if (leaving.length === 0 && returning.length === 0) return g
    const reminders = [...g.reminders.filter((r) => !pending.has(r.id)), ...returning]
    const consideredItems = [...leaving, ...g.consideredItems.filter((r) => !restoring.has(r.id))]
    return {
      ...g,
      reminders,
      count: reminders.length,
      consideredItems,
      considered: consideredItems.length,
    }
  })
}

/**
 * Place a fresh reminder in the group for its slot, creating the group if the
 * slot had nothing today; groups stay in slot order with the un-slotted last.
 */
function insertIntoGroups(
  groups: ReminderGroup[],
  task: Task,
  slots: TimeSlot[],
  timezone: string,
): ReminderGroup[] {
  const slot = groupBySlot([task], slots, timezone)[0]?.slot ?? null
  const existing = groups.findIndex((g) => (g.slot?.id ?? null) === (slot?.id ?? null))
  if (existing >= 0) {
    return groups.map((g, i) =>
      i === existing
        ? { ...g, reminders: [...g.reminders, task], count: g.reminders.length + 1 }
        : g,
    )
  }
  const fresh: ReminderGroup = {
    slot,
    reminders: [task],
    count: 1,
    considered: 0,
    consideredItems: [],
    prompts: [],
  }
  const startOf = (g: ReminderGroup) => (g.slot ? parseHHMM(g.slot.start_time) : null)
  const mine = startOf(fresh)
  const at = groups.findIndex((g) => {
    const theirs = startOf(g)
    if (mine === null) return false
    return theirs === null || theirs > mine
  })
  return at < 0 ? [...groups, fresh] : [...groups.slice(0, at), fresh, ...groups.slice(at)]
}

export function useReminders({
  onUndo,
  onCompleted,
  timeSlots,
  timezone,
}: UseRemindersOptions): UseRemindersReturn {
  const [groups, setGroups] = useState<ReminderGroup[]>(remindersCache?.groups ?? [])
  const [hasAny, setHasAny] = useState(remindersCache?.hasAny ?? false)
  const [notToday, setNotToday] = useState<Task[]>(remindersCache?.notToday ?? [])
  const [loading, setLoading] = useState(remindersCache === null)
  const [error, setError] = useState<string | null>(null)
  const [completingIds, setCompletingIds] = useState<Set<number | string>>(new Set())
  const [consideredAny, setConsideredAny] = useState(false)
  const consideredAnyRef = useRef(consideredAny)
  consideredAnyRef.current = consideredAny
  const [hydrated, setHydrated] = useState(false)

  // Callbacks live in a ref so `refresh` and `complete` stay referentially
  // stable — the parent registers `refresh` in a ref and calls it from its own
  // refresh chain, and an identity that changed every render would make that
  // registration a moving target.
  const callbacksRef = useRef({ onUndo, onCompleted })
  callbacksRef.current = { onUndo, onCompleted }
  const placementRef = useRef({ timeSlots, timezone })
  placementRef.current = { timeSlots, timezone }

  // IDs whose completion request is still in flight. A background refresh
  // (sync stream, undo chain) can land BETWEEN the optimistic removal and the
  // server recording the completion; the payload it brings still contains the
  // row, and re-inserting it produced an invisible gap (the row re-rendered in
  // its "completing" state and stayed). Any refresh strips these first.
  // The same in the other direction: a put-back whose request is still out.
  const pendingIdsRef = useRef<Set<number>>(new Set())
  const restoringIdsRef = useRef<Set<number>>(new Set())
  // Prompt keys whose action is still in flight, and which action — a
  // refresh re-applies them (`applyPromptIntents`), as it strips pending ids.
  const pendingPromptsRef = useRef<Map<string, PromptIntent>>(new Map())
  // Prompt moves whose PATCH is still out (prompt_key → target slot id).
  const pendingMovesRef = useRef<Map<string, number>>(new Map())
  /**
   * IDs whose row is still on screen, collapsing. They are still in `groups`,
   * so a server payload — which no longer lists them — cannot be applied
   * without deciding where to put them back. Rather than guess, `refresh`
   * holds until the last one has gone and `rowLeft` runs the held one; the
   * wait is the length of one animation.
   */
  const leavingIdsRef = useRef<Set<number | string>>(new Set())
  const heldRefreshRef = useRef(false)
  /** IDs with a row actually rendered right now (see `registerRow`). */
  const mountedIdsRef = useRef<Set<number | string>>(new Set())
  // The rendered groups, for the snapshot a failed completion restores.
  const groupsRef = useRef<ReminderGroup[]>(groups)
  groupsRef.current = groups
  const stripPending = (incoming: ReminderGroup[]) =>
    reconcileInFlight(
      incoming,
      pendingIdsRef.current,
      restoringIdsRef.current,
      pendingPromptsRef.current,
      pendingMovesRef.current,
    )

  const refresh = useCallback(async () => {
    if (leavingIdsRef.current.size > 0) {
      heldRefreshRef.current = true
      return
    }
    try {
      const res = await fetch('/api/reminders')
      if (!res.ok) throw new Error('Failed to load reminders')
      const json = await res.json()
      const nextGroups = stripPending(parseGroups(json))
      const nextHasAny = json?.data?.has_any === true
      const nextNotToday = ((json as { data?: { not_today?: Task[] } })?.data?.not_today ??
        []) as Task[]
      setRemindersCache({ groups: nextGroups, hasAny: nextHasAny, notToday: nextNotToday })
      setGroups(nextGroups)
      setHasAny(nextHasAny)
      setNotToday(nextNotToday)
      setError(null)
      setHydrated(true)
    } catch (err) {
      // A failed background refresh over cached data is not an error state —
      // the stale render plus the next successful refresh beats an error
      // banner replacing content the user can already see.
      if (remindersCache === null) {
        setError(err instanceof Error ? err.message : 'Failed to load reminders')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * Complete ("consider") a reminder.
   *
   * Routed through the ordinary POST /api/tasks/:id/done so completion, undo,
   * webhooks and recurrence advance behave exactly as they do for a task —
   * §6 changes what a reminder LOOKS like, not how completion works.
   *
   * OPTIMISTIC: the row leaves local state (and the toast fires) BEFORE the
   * server round trip — over a real network the round trip is what made
   * check-off feel frozen. A FAILED call restores the snapshot taken before
   * removal, so the item honestly reappears; same failure semantics as the
   * widget's tombstones (§8).
   */
  /**
   * Consider one or more reminders. One call, one undo entry — POST /done for
   * a single item, POST /bulk/done for several — so the toast's Undo restores
   * everything it removed.
   *
   * OPTIMISTIC, in both directions: the rows leave and the toast appears at
   * once. The toast's Undo is safe to press before the server has answered:
   * it waits for this request to settle first, so it can never undo whatever
   * action came before. (Offering Undo only after the round trip was the old
   * rule; over a real network that read as a frozen half-second between the
   * tap and any acknowledgement.) A failed call restores the snapshot and
   * turns the toast's promise into a no-op.
   */
  /** Move ids out of `reminders` and in behind the slot's counter. */
  const commitConsidered = useCallback((ids: number[]) => {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    setGroups((prev) => {
      const next = prev.map((g) => {
        const considered = g.reminders.filter((r) => idSet.has(r.id))
        if (considered.length === 0) return g
        const reminders = g.reminders.filter((r) => !idSet.has(r.id))
        return {
          ...g,
          reminders,
          count: reminders.length,
          consideredItems: [...considered, ...g.consideredItems],
          considered: considered.length + g.consideredItems.length,
        }
      })
      if (remindersCache) setRemindersCache({ ...remindersCache, groups: next })
      return next
    })
  }, [])

  /**
   * Run the refresh that was held while rows were collapsing, if the last of
   * them has now gone. Every path that empties `leavingIdsRef` ends here —
   * a held refresh that nothing releases would silently switch this surface
   * off for the rest of the session.
   */
  const releaseHeldRefresh = useCallback(() => {
    if (leavingIdsRef.current.size > 0 || !heldRefreshRef.current) return
    heldRefreshRef.current = false
    void refresh()
  }, [refresh])

  /**
   * Apply prompt actions to `groups` — the prompts' `commitConsidered`. A
   * handled prompt stays in its group (it counts as considered there) but no
   * longer renders, since only waiting prompts are rows.
   */
  const commitPrompts = useCallback((keys: string[], intent: PromptIntent) => {
    if (keys.length === 0) return
    const intents = new Map(keys.map((k) => [k, intent] as const))
    setGroups((prev) => {
      const next = applyPromptIntents(prev, intents)
      if (remindersCache) setRemindersCache({ ...remindersCache, groups: next })
      return next
    })
  }, [])
  /** The action each collapsing prompt row commits when it has gone. */
  const leavingPromptsRef = useRef<Map<string, PromptIntent>>(new Map())

  const registerRow = useCallback((id: number | string) => {
    mountedIdsRef.current.add(id)
    return () => {
      mountedIdsRef.current.delete(id)
    }
  }, [])

  /**
   * Consider reminders, and act on quota prompts, in one request and one undo
   * entry. Reminders are always "considered" (/done); prompts take `intent` —
   * the circle and every sweep send 'consider', only the square checkbox sends
   * 'did'. The request goes to the narrowest endpoint that covers it: a
   * reminder's /done, bulk/done, a prompt endpoint, or bulk/complete for a
   * mix (which is what makes a slot's "Considered all" one Undo).
   */
  const completeIds = useCallback(
    async (
      tasks: Task[],
      message: (considered: number) => string,
      prompts: QuotaPrompt[] = [],
      intent: PromptIntent = 'consider',
    ) => {
      // One completion per reminder in flight. Two Enters inside the collapse,
      // or a slot sweep confirmed over a row that is still going, would
      // otherwise send /done twice — and a recurring reminder would advance two
      // occurrences for one intention.
      const fresh = tasks.filter((t) => !pendingIdsRef.current.has(t.id))
      const ids = fresh.map((t) => t.id)
      // The same for prompts, keyed by prompt_key (numbered prompts share a
      // task id).
      const keys = prompts.map((p) => p.prompt_key).filter((k) => !pendingPromptsRef.current.has(k))
      if (ids.length === 0 && keys.length === 0) return
      // Only a row that is ON SCREEN can report its animation finishing, so
      // only those are allowed to hold their place — and with it the refresh.
      // Anything swept out of a folded slot, or from under a "Show all N" cap,
      // has no row to reflow under anyone's pointer, so it leaves at once, the
      // way everything used to.
      const all: (number | string)[] = [...ids, ...keys]
      const onScreen = all.filter((id) => mountedIdsRef.current.has(id))
      const offScreen = all.filter((id) => !mountedIdsRef.current.has(id))
      for (const id of ids) pendingIdsRef.current.add(id)
      for (const key of keys) pendingPromptsRef.current.set(key, intent)
      for (const id of onScreen) leavingIdsRef.current.add(id)
      for (const id of onScreen)
        if (typeof id === 'string') leavingPromptsRef.current.set(id, intent)
      // The on-screen rows do not leave `groups` here. They are marked as
      // leaving, which is what draws them struck through and inert while they
      // collapse; each one calls `rowLeft` when its animation ends, and THAT is
      // what moves it behind the slot's counter. Holding the position is the
      // whole point: see `rowLeft` for the double-click this prevents.
      const snapshot = groupsRef.current
      const hadConsidered = consideredAnyRef.current
      if (onScreen.length > 0) setCompletingIds((prev) => new Set([...prev, ...onScreen]))
      commitConsidered(offScreen.filter((id): id is number => typeof id === 'number'))
      commitPrompts(
        offScreen.filter((id): id is string => typeof id === 'string'),
        intent,
      )
      setConsideredAny(true)

      const request = (async () => {
        const res = await fetch(...completionRequest(ids, keys, intent))
        if (!res.ok) throw new Error('Failed to complete reminders')
        callbacksRef.current.onCompleted?.()
      })()

      // Undo waits for the completion to be recorded, then undoes exactly it.
      let settledOk = false
      showToast({
        message: message(ids.length + keys.length),
        type: 'success',
        action: {
          label: 'Undo',
          onClick: () => {
            void request.then(() => callbacksRef.current.onUndo()).catch(() => undefined)
          },
        },
      })

      try {
        await request
        settledOk = true
      } catch {
        // A thought still collapsing never went anywhere the user can see, so
        // this puts it back in place rather than re-inserting it: drop the
        // leaving marks, restore whatever a row that already finished had
        // committed, and take back the session flag if this was the first one.
        for (const id of all) leavingIdsRef.current.delete(id)
        for (const key of keys) leavingPromptsRef.current.delete(key)
        setCompletingIds((prev) => {
          const next = new Set(prev)
          for (const id of all) next.delete(id)
          return next
        })
        if (remindersCache) setRemindersCache({ ...remindersCache, groups: snapshot })
        setGroups(snapshot)
        if (!hadConsidered) setConsideredAny(false)
        showToast({ message: 'Could not complete reminders', type: 'error' })
        // Clearing those marks may have emptied the leaving set, and a refresh
        // held behind it must not be stranded by a failure.
        releaseHeldRefresh()
      } finally {
        for (const id of ids) pendingIdsRef.current.delete(id)
        for (const key of keys) pendingPromptsRef.current.delete(key)
        // A refresh after a confirmed completion converges the cache with the
        // server (the recurring case: a considered reminder is gone until its next
        // occurrence, which only the server knows). After a FAILURE too when
        // prompts were involved: the likeliest cause is a page left open over
        // midnight, whose prompt keys are yesterday's and are refused — without
        // a refresh every tap would fail the same way until something else
        // reloaded the list.
        if (settledOk || keys.length > 0) void refresh()
      }
    },
    [refresh, commitConsidered, commitPrompts, releaseHeldRefresh],
  )

  /**
   * A considered row has finished collapsing — now it leaves the data.
   *
   * This is the other half of the deferral in `completeIds`, and the reason
   * for it: with removal on click, the list reflowed under a pointer that had
   * not moved, so the second click of a double-click landed on whichever
   * thought slid up into the gap and considered that one too (measured on dev:
   * one double-click took two reminders). The row now holds its place, inert,
   * until it has visibly gone.
   *
   * Idempotent, because two things call it: the row's `animationend`, and the
   * row unmounting while still mid-collapse (a folded slot, a navigation) —
   * without that second path a row that never finished animating would hold
   * `refresh` shut.
   */
  const rowLeft = useCallback(
    (id: number | string) => {
      if (!leavingIdsRef.current.has(id)) return
      leavingIdsRef.current.delete(id)
      setCompletingIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      // It moves behind the slot's counter as it goes, so the progress bar and
      // the "put back" list agree with the row that just left. A prompt row
      // (keyed by its prompt_key) commits the action it was leaving for.
      if (typeof id === 'string') {
        commitPrompts([id], leavingPromptsRef.current.get(id) ?? 'consider')
        leavingPromptsRef.current.delete(id)
      } else {
        commitConsidered([id])
      }
      // Any refresh that arrived during the collapse was held rather than
      // applied over a row that was still on screen. Run it now.
      releaseHeldRefresh()
    },
    [commitConsidered, commitPrompts, releaseHeldRefresh],
  )

  const completeMany = useCallback(
    (tasks: Task[], prompts: QuotaPrompt[] = []) =>
      completeIds(tasks, (n) => `Considered ${n}`, prompts),
    [completeIds],
  )

  /** The circle on a quota prompt: considered for today, no progress. */
  const considerPrompt = useCallback(
    (prompt: QuotaPrompt) =>
      completeIds([], () => `Considered “${prompt.title}”`, [prompt], 'consider'),
    [completeIds],
  )
  /** The square checkbox on a quota prompt: did it — progress, and considered. */
  const didPrompt = useCallback(
    (prompt: QuotaPrompt) => {
      const next =
        prompt.number !== null ? Math.max(prompt.current, prompt.number) : prompt.current + 1
      return completeIds(
        [],
        () => `Logged “${prompt.title}” · ${next}/${prompt.target}`,
        [prompt],
        'did',
      )
    },
    [completeIds],
  )

  /**
   * Move a prompt to another period (the period chips in its bubble). The
   * row jumps at once; `save` is the quota editor's own write (a PATCH of
   * `quota_prompt_config`, one undo entry, its toast and refresh). The move
   * stays applied to any payload that lands while the PATCH is out, and a
   * failed save refreshes it back to where the server still has it.
   */
  const movePrompt = useCallback(
    async (prompt: QuotaPrompt, toSlotId: number, save: () => Promise<void>) => {
      if (prompt.slot_id === toSlotId) return
      const moves = new Map([[prompt.prompt_key, toSlotId]])
      pendingMovesRef.current.set(prompt.prompt_key, toSlotId)
      // Computed here, not in a `setGroups` updater: the cache write notifies
      // other components (the nav badge), and an updater runs during this
      // component's render — React refuses a setState of another component
      // from there ("Cannot update a component while rendering…").
      const next = applyPromptMoves(groupsRef.current, moves)
      groupsRef.current = next
      setGroups(next)
      if (remindersCache) setRemindersCache({ ...remindersCache, groups: next })
      // Only this move's own entry is cleared: a second move of the same row
      // made while this one was out owns the key now.
      const settle = () => {
        if (pendingMovesRef.current.get(prompt.prompt_key) === toSlotId) {
          pendingMovesRef.current.delete(prompt.prompt_key)
        }
      }
      try {
        await save()
        settle()
      } catch {
        // `save` has already said so (its error toast); put the row back.
        settle()
        await refresh()
      }
    },
    [refresh],
  )

  const putBack = usePutBack({ setGroups, refresh, restoringIdsRef, callbacksRef })
  const remove = useRemove({ setGroups, refresh, pendingIdsRef, callbacksRef })

  const complete = useCallback(
    (task: Task) => completeIds([task], () => `Considered \u201c${task.title}\u201d`),
    [completeIds],
  )

  /**
   * Create a reminder (POST /api/tasks with the flag). The row is shown the
   * moment the server answers when it is certainly today's — a daily one —
   * so the quick add feels immediate; otherwise the refresh decides where it
   * belongs (today's slot, or "Not today"). Undoable like any creation.
   */
  const create = useCallback(
    async (input: ReminderCreateInput): Promise<Task> => {
      const body: Record<string, unknown> = { title: input.title, is_reminder: true }
      if (input.rrule) body.rrule = input.rrule
      if (input.notes) body.notes = input.notes
      if (input.priority) body.priority = input.priority
      if (input.enrich) body.enrich = true
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(err?.error || 'Could not add the reminder')
      }
      const task = (await res.json()).data as Task
      setHasAny(true)
      const { timeSlots: slots, timezone: tz } = placementRef.current
      const daily =
        /^FREQ=DAILY(?:;|$)/.test(task.rrule ?? '') && !/INTERVAL=/.test(task.rrule ?? '')
      if (daily && slots && tz) {
        setGroups((prev) => {
          const next = insertIntoGroups(prev, task, slots, tz)
          if (remindersCache) setRemindersCache({ ...remindersCache, groups: next, hasAny: true })
          return next
        })
        void refresh()
      } else {
        await refresh()
      }
      callbacksRef.current.onCompleted?.()
      return task
    },
    [refresh],
  )

  // A slot's "Considered all" sweeps its waiting prompts too — as considered,
  // never as done (Trent's rule: consider-all is never +1).
  const completeGroup = useCallback(
    (group: ReminderGroup) => completeMany(group.reminders, group.prompts.filter(promptWaiting)),
    [completeMany],
  )

  const total = groups.reduce((sum, group) => sum + groupWaiting(group), 0)

  return {
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
    remove,
    refresh,
    notToday,
    create,
  }
}

/**
 * The narrowest request that commits a consideration. Reminders alone go
 * where they always went (/done, bulk/done); prompts alone to their own
 * endpoint; a mix to bulk/complete, so a slot's sweep is ONE undo entry.
 */
function completionRequest(
  ids: number[],
  keys: string[],
  intent: PromptIntent,
): [string, RequestInit] {
  const post = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (keys.length === 0) {
    return ids.length === 1
      ? [`/api/tasks/${ids[0]}/done`, { method: 'POST' }]
      : ['/api/tasks/bulk/done', post({ ids })]
  }
  if (ids.length === 0) {
    return [`/api/quota-prompts/${intent === 'did' ? 'did' : 'consider'}`, post({ keys })]
  }
  return [
    '/api/tasks/bulk/complete',
    post({ ids, prompts: keys.map((key) => ({ key, did: intent === 'did' })) }),
  ]
}

/**
 * Trash one or more reminders (POST /api/tasks/bulk/delete — a soft delete,
 * one undo entry). Trent (2026-09-05): the surface had no way to get rid of a
 * reminder. Same optimistic shape as considering: the rows leave at once,
 * the toast's Undo waits for the request, a failure restores the snapshot.
 * The ids ride in `pendingIdsRef` so a refresh landing mid-request does not
 * re-insert them.
 */
function useRemove({
  setGroups,
  refresh,
  pendingIdsRef,
  callbacksRef,
}: {
  setGroups: React.Dispatch<React.SetStateAction<ReminderGroup[]>>
  refresh: () => Promise<void>
  pendingIdsRef: React.MutableRefObject<Set<number>>
  callbacksRef: React.MutableRefObject<UseRemindersOptions>
}) {
  return useCallback(
    async (tasks: Task[]) => {
      const ids = tasks.map((t) => t.id)
      if (ids.length === 0) return
      const idSet = new Set(ids)
      for (const id of ids) pendingIdsRef.current.add(id)
      let snapshot: ReminderGroup[] | null = null
      setGroups((prev) => {
        snapshot = prev
        const next = prev.map((g) => {
          const reminders = g.reminders.filter((r) => !idSet.has(r.id))
          const consideredItems = g.consideredItems.filter((r) => !idSet.has(r.id))
          if (
            reminders.length === g.reminders.length &&
            consideredItems.length === g.consideredItems.length
          )
            return g
          return {
            ...g,
            reminders,
            count: reminders.length,
            consideredItems,
            considered: consideredItems.length,
          }
        })
        if (remindersCache) setRemindersCache({ ...remindersCache, groups: next })
        return next
      })

      const request = (async () => {
        const res = await fetch('/api/tasks/bulk/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        })
        if (!res.ok) throw new Error('Failed to delete reminders')
        callbacksRef.current.onCompleted?.()
      })()

      let settledOk = false
      showToast({
        message:
          tasks.length === 1
            ? `Moved \u201c${tasks[0].title}\u201d to Trash`
            : `Moved ${tasks.length} reminders to Trash`,
        type: 'success',
        action: {
          label: 'Undo',
          onClick: () => {
            void request.then(() => callbacksRef.current.onUndo()).catch(() => undefined)
          },
        },
      })

      try {
        await request
        settledOk = true
      } catch {
        if (snapshot) {
          const restored = snapshot
          if (remindersCache) setRemindersCache({ ...remindersCache, groups: restored })
          setGroups(restored)
        }
        showToast({ message: 'Could not delete reminders', type: 'error' })
      } finally {
        for (const id of ids) pendingIdsRef.current.delete(id)
        if (settledOk) void refresh()
      }
    },
    [refresh, setGroups, pendingIdsRef, callbacksRef],
  )
}

/**
 * Put a considered thought back (POST /api/tasks/:id/undone — for a
 * recurring reminder that reverses the latest completion). Optimistic the
 * same way as considering: the row returns at once, the toast's Undo waits
 * for the request, a failure restores the snapshot.
 */
function usePutBack({
  setGroups,
  refresh,
  restoringIdsRef,
  callbacksRef,
}: {
  setGroups: React.Dispatch<React.SetStateAction<ReminderGroup[]>>
  refresh: () => Promise<void>
  restoringIdsRef: React.MutableRefObject<Set<number>>
  callbacksRef: React.MutableRefObject<UseRemindersOptions>
}) {
  return useCallback(
    async (task: Task) => {
      const id = task.id
      restoringIdsRef.current.add(id)
      let snapshot: ReminderGroup[] | null = null
      setGroups((prev) => {
        snapshot = prev
        const next = prev.map((g) => {
          if (!g.consideredItems.some((r) => r.id === id)) return g
          const consideredItems = g.consideredItems.filter((r) => r.id !== id)
          const reminders = [...g.reminders, task]
          return {
            ...g,
            reminders,
            count: reminders.length,
            consideredItems,
            considered: consideredItems.length,
          }
        })
        if (remindersCache) setRemindersCache({ ...remindersCache, groups: next })
        return next
      })

      const request = (async () => {
        const res = await fetch(`/api/tasks/${id}/undone`, { method: 'POST' })
        if (!res.ok) throw new Error('Failed to put back')
        callbacksRef.current.onCompleted?.()
      })()

      let settledOk = false
      showToast({
        message: `Put back \u201c${task.title}\u201d`,
        type: 'success',
        action: {
          label: 'Undo',
          onClick: () => {
            void request.then(() => callbacksRef.current.onUndo()).catch(() => undefined)
          },
        },
      })

      try {
        await request
        settledOk = true
      } catch {
        if (snapshot) {
          const restored = snapshot
          if (remindersCache) setRemindersCache({ ...remindersCache, groups: restored })
          setGroups(restored)
        }
        showToast({ message: 'Could not put it back', type: 'error' })
      } finally {
        restoringIdsRef.current.delete(id)
        if (settledOk) void refresh()
      }
    },
    [refresh, setGroups, restoringIdsRef, callbacksRef],
  )
}

/**
 * One fetch for everyone. The sidebar, the tab bar and the Reminders top bar
 * all read the cache and all mount at once, so without this each would fire
 * its own `/api/reminders` on the same tick. Concurrent callers share the
 * in-flight request; the next call after it settles starts a fresh one.
 */
let cacheLoad: Promise<void> | null = null
function loadRemindersCache(): Promise<void> {
  if (cacheLoad) return cacheLoad
  cacheLoad = (async () => {
    try {
      const res = await fetch('/api/reminders')
      if (!res.ok) return
      const json = await res.json()
      setRemindersCache({
        groups: parseGroups(json),
        hasAny: json?.data?.has_any === true,
        notToday: ((json as { data?: { not_today?: Task[] } })?.data?.not_today ?? []) as Task[],
      })
    } catch {
      // A badge that stays at its last value beats one that flickers.
    } finally {
      cacheLoad = null
    }
  })()
  return cacheLoad
}

/**
 * The day's numbers (waiting so far, later, considered) for the nav badge and
 * the Reminders top bar, read from the shared cache.
 *
 * Fetches once when nothing is cached, then re-derives whenever the Reminders
 * surface refreshes or completes something (same cache), and re-fetches when
 * the tab regains focus so a stale count never survives a trip away from the
 * app. Deliberately does NOT open its own sync stream — the navs are mounted
 * everywhere, and one EventSource per hook instance would multiply
 * connections; the surface's own stream keeps the cache honest while it is
 * open, and focus covers the rest.
 */
function subscribeToCache(listener: () => void) {
  cacheListeners.add(listener)
  return () => {
    cacheListeners.delete(listener)
  }
}
const readCache = () => remindersCache
const readServerCache = () => null

export function useRemindersSummary(timezone: string): RemindersSummary<ReminderGroup> | null {
  // useSyncExternalStore rather than a force-render counter: the cache is
  // module state, and a render that reads it directly is invisible to the
  // React Compiler, which memoises the derived summary on `timezone` alone and
  // leaves every subscriber stuck at its first (empty) value. As a store
  // snapshot it is a real render input, so the summary recomputes when it
  // changes and only then.
  const cache = useSyncExternalStore(subscribeToCache, readCache, readServerCache)
  useEffect(() => {
    if (remindersCache === null) void loadRemindersCache()
    const onFocus = () => void loadRemindersCache()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  return cache ? summarizeReminders(cache.groups, timezone) : null
}

/** The nav badge number: reminders waiting in slots that have started, plus Anytime. */
export function useRemindersBadge(timezone: string): number {
  return useRemindersSummary(timezone)?.waitingSoFar ?? 0
}
