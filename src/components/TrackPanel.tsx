'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trackedItems } from '@/lib/slot-view'
import {
  groupByLabel,
  quotaGroupSummary,
  quotaShortfall,
  trackSections,
  trackState,
  trackStream,
  trackStripeClass,
  TRACK_NOTCH_CLASS,
  type TrackSection,
  type TrackStreamItem,
} from '@/lib/track'
import { useTrackProgress } from '@/hooks/useTrackProgress'
import { useTimezone } from '@/hooks/useTimezone'
import { useFoldState } from '@/components/FoldStateProvider'
import { useLongPress } from '@/hooks/useLongPress'
import { useHorizontalSwipe } from '@/hooks/useHorizontalSwipe'
import { useQuotaEditor } from '@/hooks/useQuotaEditor'
import {
  foldClass,
  useResponsiveFold,
  useResponsiveFolds,
  FOLD_BODY_BLOCK,
  FOLD_BODY_FLEX,
  FOLD_CHEVRON,
  FOLD_SUMMARY,
  type FoldClasses,
  type FoldState,
} from '@/hooks/useResponsiveFold'
import { TrackChipPopover, type PromptPeriods } from '@/components/TrackChipPopover'
import { usePromptSetup } from '@/components/QuotaPromptField'
import { useLabelConfig, useWeekStart } from '@/components/PreferencesProvider'
import { movedPromptConfig, numbersLabel, quotaPeriodRows } from '@/lib/quota-prompts'
import type { TimeSlot } from '@/lib/time-slot-assign'
import { log as logger } from '@/lib/logger'
import { matchesTaskSearch, normalizeTaskSearch } from '@/lib/task-search'
import type { LabelColor, LabelConfig, Task } from '@/types'

/**
 * Track (REDESIGN-V03 §5): the quotas' home on the Tasks page.
 *
 * Trent, on the first cut (quotas as full task rows at the top of "Anytime
 * today"): "the alignment is all weird and the things just look sloppy…
 * wherever they go, it can't be buried on the Tasks page." So the quotas are
 * an instrument panel above the day, not rows inside it:
 *
 * - One line per quota, every line the same shape: title · bar · count · − · +1.
 *   The control cluster has fixed widths and sits flush right, so the lines
 *   align as one object. No circle, no AI commentary, no recurrence glyph —
 *   none of that is what a counter is about.
 * - The panel is a plain group header ("TRACK") over ONE card, which holds its
 *   quotas as tight CHIPS with their full titles, wrapping wherever the width
 *   runs out (Trent, 2026-09-05: eight open rows pushed the first task of the
 *   day below the fold on his phone, and a folded one-liner hid the quotas).
 *   A chip is as wide as its title needs, up to the card; past that the title
 *   ellipsises, which on a phone the longest few do. The count never
 *   truncates — it is the thing the chip is for. Hold a chip to read a title
 *   in full. Tap a chip: +1. Hold, or shift-click: −1. The chip's background
 *   fills as the count climbs and turns green at the target, so each chip is
 *   its own bar.
 * - CHIPS ONLY (Trent, 2026-09-29). There used to be a second, "rows" layout —
 *   one full line per quota with a bar, a count, − and +1 — behind a "Show as
 *   rows / Show as chips" switch, remembered in the server preference
 *   `track_expanded`. It is gone: the switch, the rows and the client's use of
 *   that preference. (The `users.track_expanded` column and the preferences
 *   API field remain, unread by the web app, so older clients and the native
 *   apps' decoding are unaffected.)
 * - Order is by label then title, and never changes on a tap — the widget's
 *   "order jumps under your finger" complaint applied verbatim here.
 * - "Met" is a state, not an exit: green check, count keeps going (3/2).
 *
 * MET QUOTAS ARE PUT AWAY (Trent, 2026-09-22; revised 2026-09-28). He tried
 * two orders by how many are left (live was "too jumpy") and then hiding a
 * quota the moment it was met, and ruled: "alphabetical, hide the complete
 * ones", but "things should not disappear until reload." On 2026-09-28 he
 * reversed the reload half: "if I complete something, there should be a
 * 5-second countdown or something before it actually hides it from my screen.
 * I shouldn't have to reload to get this off the dashboard."
 *
 * - The quotas already met when the panel LOADS are put away (`useMetPutAway`).
 * - One met during the session stays where it is, green, and fades out over
 *   `MET_LEAVE_MS` (5s) — never instantly, so it never vanishes under the
 *   finger that just met it — then is put away like the rest. Taking it back
 *   below target (a −1) before then cancels the countdown.
 * - A label whose every quota was put away leaves its section, title and all
 *   — nothing stands in for it (see `finishedClusterInSection`, below the
 *   period redesign, for why and what used to be there).
 * - A label that is partly done says how many, beside its name (`✓ 2`).
 * - The header's top right carries "3 of 19" — met of total — and tapping it
 *   shows the met ones in place, copying the Reminders slot's "X of Y"
 *   exactly (`TrackHeader`). The choice lives in the fold store: it survives
 *   navigating away and back, and a reload puts them away again. This count
 *   is panel-wide, across every period — unaffected by the grouping below.
 * - The order is still label then title within a period. Nothing moves on a tap.
 *
 * GROUPED BY PERIOD, THEN LABEL (Trent, 2026-09-23, choosing `mock4` — a
 * period-first mock — over the label-first design this panel shipped with
 * from 2026-09-09). A quota is answerable to two questions — "what is it
 * about" (the label) and "what clock is it on" (the period) — and Trent tried
 * the label first, with the period a muted two-letter suffix on the chip
 * ("0/3·wk"). Living with it, the suffix read as an afterthought and a week's
 * worth of "how am I doing" had no single number to look at. The period comes
 * back as the outer grouping; the label clusters from the 09-09 design move
 * inside it, unchanged in spirit — the change is what wraps them.
 *
 * - One `<li data-quota-period>` per period — Today, This week, This month,
 *   This year, then a period-less "No period" bucket last — built by
 *   `trackSections`, which also does the period's math (elapsed fraction,
 *   days left, the summed bar). Ordered day-to-year and empty periods are
 *   omitted, both `groupByPeriod`'s doing (`@/lib/track`).
 * - EACH SECTION'S HEADING IS ONE LINE (`PeriodHeading`): the period name,
 *   bold and full-strength — not muted, unlike a label's — so it outranks the
 *   clusters under it; a muted "N days left" (nothing for Today); an inline bar
 *   that flexes to fill whatever room is left; "**M** of N" quotas met. A
 *   THIN DIVIDER (a top border) sits between sections, never before the first.
 * - THE BAR IS HONEST NOW BECAUSE A SECTION SHARES ONE CLOCK. The 09-09 design
 *   dropped the summed bar because a label group mixes days, weeks and months
 *   — "2 a day + 3 a week + 1 a month = 7" meant nothing. A period section
 *   cannot mix: every quota in it shares one period, so
 *   `sum(min(current,target)) / sum(target)` (partial credit, capped per
 *   quota — `trackSummary`) is a real number again. Indigo while short of the
 *   target, green when every quota in the section is met.
 * - THE NOTCH marks how much of the period has already run — a 2px line
 *   inside the bar, clipped by its `overflow-hidden`, never sticking out. ONE
 *   flat, faint tone at every fraction, on the fill or off it (Trent,
 *   2026-09-23: it must not switch shade by what it sits over) — see
 *   `TRACK_NOTCH_CLASS`, tuned in that one place. No notch on the no-period
 *   section: there is no clock to mark. The bar carries its own accessible
 *   description (`aria-valuetext`, e.g. "67% done, 43% of the week gone") —
 *   the notch itself is decorative and `aria-hidden`.
 * - THE PERIOD SUFFIX IS GONE FROM THE CHIP ("0/2·wk" → "0/2"). The section it
 *   sits in already says the period; repeating it on every chip was the
 *   afterthought that started this redesign. The chip's `aria-label` still
 *   spells the period out for a screen reader, since nothing else there does.
 * - INSIDE A SECTION, the label clusters are exactly the 09-09 design:
 *   `trackStream`, called per section rather than once over the whole panel
 *   (a "kids" label with both weekly and monthly quotas now gets a cluster in
 *   EACH section, which is correct — a cluster spanning periods could not
 *   carry one honest bar either). A LABEL NOW GETS ITS OWN LINE, chips
 *   wrapping in below it (`mock4`'s `.lab-own` + `.flow`, not the 09-09 mock's
 *   title-as-a-peer) — a cluster title's flex item is `basis-full` at every
 *   fold state now, where it used to share its row with chips while open. The
 *   3px label-colour stripe, the neutral fallback, and green's exclusion for
 *   "met" (`trackStripeClass`) are unchanged.
 *
 * This panel and the Quotas page are the ONLY places a quota appears (Trent,
 * 2026-09-08: "a quota is not a task"). It used to be a plain row in the All
 * and Projects lists too, wearing a "0 / 4" chip and no controls; the
 * dashboard now filters tracked rows out of every list, which is why this
 * panel is handed the unfiltered corpus rather than the list's own array.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO NEW FOLDS, BOTH SHUT ON A PHONE (Trent, 2026-09-15: "I just need a way on
 * mobile to be able to immediately see my tasks").
 *
 * The panel outgrew itself. At 22 quotas it is 350-500px tall, and on a phone —
 * under a filter chip stack that wraps to a dozen rows — it put the first task
 * of the day roughly three screens down. Neither fold changes anything a
 * desktop user sees; both default to shut below `sm` and open at or above it,
 * in CSS, so the first paint is already right (see `useResponsiveFold`).
 *
 * 1. THE SECTION FOLD hides the whole card, leaving one line: `TRACK · 8 of 22
 *    left`. It is a header button, `sm:hidden`, sitting beside the desktop
 *    heading (plain text).
 * 2. THE GROUP FOLDS make each label cluster independently collapsible. A shut
 *    cluster shows a 30×3 meter filled to met/count and "{n} left" — or "✓ all
 *    met", at which point the whole header steps back in opacity so a finished
 *    category stops competing for attention.
 *
 * "{n} left" COUNTS QUOTAS STILL SHORT, not items and not increments remaining
 * (Trent picked it over both). It is the only one of the three that moves as he
 * logs progress, and it answers the one question a shut header has to answer:
 * is opening this worth it. `quotaGroupSummary` is the single source for it.
 */

/**
 * The card, folded away by the section fold.
 *
 * OPEN IS THE DEFAULT AT EVERY WIDTH as of 2026-09-21. These `auto` values
 * used to fold the whole panel — card, clusters and rows — away below `sm`,
 * because 22 quotas of Track pushed the first task of the day about three
 * screens down a phone. Trent reversed it after living with it: "The track
 * should be expanded. Everything should be expanded for the track on mobile.
 * Otherwise I can't check things off easily. I know it pushes the task stuff
 * down but it's a price we have to pay for now." Checking a quota off is what
 * the phone is for, and a fold taxed every one of those taps.
 *
 * Only the pre-choice default moved; `shut` is untouched and the phone's
 * section toggle still works exactly as it did.
 *
 * The card is still open by default on a phone, but as of 2026-09-29 each
 * PERIOD inside it starts folded to its bar there — see `PERIOD_BODY`.
 *
 * "Shut" only hides it BELOW `sm`, which is not a typo. The section fold is a
 * phone affordance and its button is `sm:hidden`; a user who shuts the panel on
 * a phone and then widens the window would otherwise be left with a hidden card
 * and no control anywhere that reopens it.
 */
const SECTION_CARD: FoldClasses = {
  open: 'block',
  shut: 'hidden sm:block',
  auto: 'block',
}

/** The one-line stand-in for the folded card. Mirrors `SECTION_CARD`. */
const SECTION_SUMMARY: FoldClasses = {
  open: 'hidden',
  shut: 'flex sm:hidden',
  auto: 'hidden',
}

/**
 * A cluster heading's width in the wrapping chip row: always the full row now
 * (`mock4`, 2026-09-23), open or shut — a label gets its own line and its
 * chips wrap in below it, where the 09-09 design let an open cluster's chips
 * flow onto the title's own line. Unlike `CLUSTER_MET_DIM` and the fold
 * classes below, this does not vary by fold state, so it is a plain string
 * rather than a `FoldClasses` — there is nothing left for `foldClass` to pick
 * between.
 */
const CLUSTER_TITLE_ROW = 'max-w-full basis-full mt-1.5 mb-1 first:mt-0'

/** A met cluster steps back — but only while it is shut and standing in for its chips. */
const CLUSTER_MET_DIM: FoldClasses = {
  open: '',
  shut: 'opacity-60',
  auto: '',
}

/**
 * All chip-level "detail" state for Track: which quota's popover bubble is
 * open, and which (if any) is open in the full `QuotaDetailModal` editor —
 * the same editor `QuotasView` mounts (`useQuotaEditor`: same mutations, same
 * guarded "Open full page"), so pressing a chip's "Open" button edits the
 * same way `/quotas` does, just without leaving (Trent, 2026-09-21:
 * "whenever I do things with tasks it opens a modal... that's how I like to
 * work"). One hook rather than state split across `TrackPanel` and its
 * chips' callers, so the panel's own render stays short — the same reason
 * `useQuotaEditor` is its own file rather than inline in `QuotasView`.
 */
function useTrackChipDetail({
  onUndo,
  onCompleted,
  onRefresh,
}: {
  onUndo: () => void
  onCompleted: () => void
  onRefresh: () => Promise<void>
}) {
  // The quota whose popover bubble is showing. By id, not object, so a sync
  // refresh can replace the rendered task underneath an open bubble.
  const [openId, setOpenId] = useState<number | null>(null)
  const { saveQuotas, deleteQuotas, openEdit, modal } = useQuotaEditor({
    refresh: onRefresh,
    onUndo,
    onCompleted,
  })

  const openPopover = useCallback((task: Task) => setOpenId(task.id), [])
  const closePopover = useCallback(() => setOpenId(null), [])
  // The popover's own "Open" button: the bubble it was pressed from closes,
  // the editor replaces it — never both open at once.
  const openEditor = useCallback(
    (task: Task) => {
      setOpenId(null)
      openEdit([task])
    },
    [openEdit],
  )
  // The bubble's trash can: the bubble it was pressed from goes with it.
  const deleteFromPopover = useCallback(
    (task: Task) => {
      setOpenId(null)
      void deleteQuotas([task])
    },
    [deleteQuotas],
  )

  // Read once here, not per chip: `useQuotaPromptPrefs` fetches on every mount.
  const setup = usePromptSetup()

  /**
   * The bubble's period chips (2026-09-25) — where this quota's daily
   * reminder sits, the same chips a prompt row's bubble carries, one tap to
   * move it for good. The save is #83's exactly: `movedPromptConfig` merged
   * over the stored config, written by `saveQuotas` (the editor's PATCH, with
   * its Undo toast). No optimistic move: nothing on this panel shows the
   * period, and the dashboard's Reminders card follows because this panel's
   * `onRefresh` is the dashboard's `refreshAll`, which refetches it too.
   *
   * Hidden (undefined) with Settings' quota reminders off, the quota's own
   * "Remind me daily" off, or no periods — `quotaPeriodRows` returns none.
   */
  const periodsFor = (task: Task): PromptPeriods | undefined => {
    if (!setup.enabled) return undefined
    const rows = quotaPeriodRows(task, setup.slots, setup.userDefault)
    if (rows.length === 0) return undefined
    const several = rows.length > 1
    const move = (numbers: number[] | null, slot: TimeSlot) => {
      setOpenId(null)
      const which =
        several && numbers ? ` (${numbersLabel(numbers, task.progress_target ?? 1)})` : ''
      void saveQuotas(
        [task.id],
        { quota_prompt_config: movedPromptConfig(task.quota_prompt_config, { numbers }, slot.id) },
        { message: `Moved “${task.title}”${which} to ${slot.label}` },
      ).catch((err) => {
        // A refused save has already said so, in `saveQuotas`' error toast.
        logger.error('ui', 'Moving a quota reminder failed:', err)
      })
    }
    return {
      slots: setup.slots,
      label: 'Reminds me in',
      rows: rows.map((row) => ({
        key: row.numbers ? row.numbers.join(',') : 'quota',
        label: row.numbers ? numbersLabel(row.numbers, task.progress_target ?? 1) : '',
        currentId: row.slotId,
        onPick: (slot) => move(row.numbers, slot),
      })),
    }
  }

  return { openId, openPopover, closePopover, openEditor, deleteFromPopover, periodsFor, modal }
}

interface TrackPanelProps {
  tasks: Task[]
  /** Undo the last action — wired to the toasts, as `DashboardRemindersPanel`
   *  is (this panel and that one share the dashboard's one undo pipeline). */
  onUndo: () => void
  /** Tell the host an undoable thing happened, so its Undo count is right. */
  onCompleted: () => void
  /** Refetch the dashboard's own task list after a save/create/delete — this
   *  panel does not own its data the way `/quotas` owns its own fetch; `tasks`
   *  is a prop, so the mutation's own success is not enough to update it. */
  onRefresh: () => Promise<void>
  /**
   * On its own page (/quotas' default view, 2026-09-25) rather than above the
   * task list. The panel is the same — chips, "Show met", tap/hold — but
   * the parts that only exist to get it out of the task list's way go:
   *
   * - the phone's SECTION FOLD. It shuts the card so the first task of the day
   *   is reachable; on /quotas there is no task list beneath, and a fold shut
   *   on the dashboard (it is stored in the shared fold state) would otherwise
   *   open this page onto one line and nothing else. The card is always shown.
   * - the "QUOTAS" heading — the top bar and the page's own h1 already say it.
   */
  standalone?: boolean
  /**
   * The /quotas top bar's search (standalone only — the dashboard's search is
   * the task list's, and never reaches this panel). See "SEARCH" in the body.
   */
  searchQuery?: string
}

/**
 * The fold handles a search hands the sections list: every cluster open and
 * none of them toggleable — the Reminders surface's `locked` slots. Nothing
 * here writes the fold store, so clearing the search finds every fold exactly
 * where the user left it.
 */
const SEARCH_CLUSTERS: ReturnType<typeof useResponsiveFolds> = {
  stateOf: () => true,
  isOpen: () => true,
  toggle: () => {},
}

/**
 * "Now," for the period sections' math — refreshed every minute, not the 15s
 * convention elsewhere in the app (`useQuickSelectDate`, `QuickActionPanel`).
 * Those redraw a relative time like "in 3 mins"; the fastest thing a period
 * section shows is the DAILY notch, which moves by whole minutes at best, so
 * a 15s tick would just spend renders nobody can see move.
 */
function useTrackNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}

export function TrackPanel({
  tasks,
  onUndo,
  onCompleted,
  onRefresh,
  standalone = false,
  searchQuery,
}: TrackPanelProps) {
  const { labelConfig } = useLabelConfig()
  const timezone = useTimezone()
  const { weekStart } = useWeekStart()
  const now = useTrackNow()
  const detail = useTrackChipDetail({ onUndo, onCompleted, onRefresh })
  const section = useResponsiveFold('track-section')
  const clusters = useResponsiveFolds('track-cluster')
  // Shut on a phone until tapped — see `PERIOD_BODY`.
  const periods = useResponsiveFolds('track-period', false)
  const quotas = trackedItems(tasks)

  // SEARCH (standalone only) narrows what is RENDERED, never what the panel's
  // state is computed from — the Reminders surface's rule. `useMetPutAway`
  // below still sees every quota: fed the matches alone, it would drop a met
  // quota that fell out of the results from `putAway`, and on clearing greet
  // it as newly met and fade it out for five seconds. While searching:
  // - only matching quotas are sectioned, so a period with no match is gone;
  // - every label cluster renders open (`SEARCH_CLUSTERS`), since a folded
  //   result is a result nobody can see — without touching the fold store;
  // - met quotas are shown even with "Show met" off, for the same reason.
  // The header's overall count stays the whole set's: it describes the page.
  const query = normalizeTaskSearch(searchQuery)
  const searching = query.length > 0
  const shown = searching ? quotas.filter((q) => matchesTaskSearch(q, query)) : quotas

  const sections = trackSections(shown, timezone, now, weekStart)
  // What each cluster's shut header says. Keyed the same way the DOM is (one
  // key per period+label), so a heading and its summary can never be looking
  // at different groups.
  const summaries = clusterSummaries(sections)

  const showMet = useShowMet()
  const { putAway, leaving } = useMetPutAway(quotas)
  const hideMet = !showMet.shown && !searching
  const isPutAway = (task: Task) => hideMet && putAway.has(task.id) && trackState(task).met
  const isLeaving = (task: Task) => hideMet && leaving.has(task.id) && trackState(task).met

  // No match at all renders nothing; `QuotasSummary` says so. That also
  // unmounts `detail.modal`, which is fine: the editor's overlay keeps the
  // search field out of reach while it is open, and a save that drops the
  // last match closes the editor anyway.
  if (quotas.length === 0 || sections.length === 0) return null

  const overall = quotaGroupSummary(quotas)

  return (
    <section aria-label="Quotas" data-track-panel className={cn(!standalone && 'mb-6')}>
      <TrackHeader standalone={standalone} section={section} overall={overall} showMet={showMet} />

      <div
        id="track-card"
        className={cn(
          'bg-muted/30 rounded-2xl p-2',
          !standalone && foldClass(section.state, SECTION_CARD),
        )}
      >
        <TrackSectionsList
          sections={sections}
          periods={standalone || searching ? null : periods}
          labelConfig={labelConfig}
          isPutAway={isPutAway}
          isLeaving={isLeaving}
          summaries={summaries}
          clusters={searching ? SEARCH_CLUSTERS : clusters}
          locked={searching}
          detail={detail}
        />
      </div>

      {detail.modal}
    </section>
  )
}

/**
 * What each period+label cluster's shut header says — `quotaGroupSummary`
 * over that section's slice of the corpus, keyed the same way the DOM and the
 * fold store are (`sectionClusterKey`), so a "kids" cluster under This week
 * and a "kids" cluster under This month never share a summary or a fold.
 */
function clusterSummaries(sections: TrackSection[]): Map<string, { count: number; met: number }> {
  const out = new Map<string, { count: number; met: number }>()
  for (const s of sections) {
    for (const g of groupByLabel(s.tasks)) {
      out.set(sectionClusterKey(s.key, g.label), quotaGroupSummary(g.tasks))
    }
  }
  return out
}

const SHOW_MET_KEY = 'track-show-met'

/** Whether met quotas are on show — put away until asked for. See "MET QUOTAS" above. */
function useShowMet(): { shown: boolean; toggle: () => void } {
  const { choices, toggleChoice } = useFoldState()
  return {
    shown: choices.get(SHOW_MET_KEY) ?? false,
    toggle: () => toggleChoice(SHOW_MET_KEY, false),
  }
}

/** How long a quota met during the session stays, fading, before it is put away. */
export const MET_LEAVE_MS = 5000

/**
 * Which met quotas are put away, and which are on their way out.
 *
 * `putAway` starts as the quotas already met when the panel loaded — decided
 * on the first render that has quotas, during render so the first paint is
 * already the put-away one. A quota met DURING the session joins `leaving`
 * instead: it stays where it is, green, fading out (`animate-met-leave`, the
 * same `MET_LEAVE_MS`), and its own timer moves it to `putAway` when that
 * runs out — see "MET QUOTAS ARE PUT AWAY" above. One timer per quota, so
 * meeting a second one doesn't restart the first one's countdown.
 *
 * The caller also requires the quota to STILL be met. One that stops being
 * met — a −1 before the countdown ends, the period rolling over, a −1 from the
 * phone — leaves both sets here, so meeting it again starts a fresh countdown
 * rather than vanishing on a stale entry.
 */
function useMetPutAway(quotas: Task[]): {
  putAway: ReadonlySet<number>
  leaving: ReadonlySet<number>
} {
  const [putAway, setPutAway] = useState<ReadonlySet<number> | null>(null)
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(new Set())
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const finishLeaving = useCallback((id: number) => {
    setPutAway((prev) => new Set(prev ?? []).add(id))
    setLeaving((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])
  useLeaveTimers(leaving, finishLeaving, timers)

  // Load: what is already met is put away, with no countdown.
  if (putAway === null) {
    if (quotas.length === 0) return { putAway: new Set(), leaving }
    const atLoad = new Set(quotas.filter((q) => trackState(q).met).map((q) => q.id))
    setPutAway(atLoad)
    return { putAway: atLoad, leaving }
  }

  // Since load: newly met quotas start leaving; ones no longer met come back.
  // Adjusted during render, guarded so it only sets state when something
  // actually changed (React's "adjusting state when a prop changes").
  const met = new Set(quotas.filter((q) => trackState(q).met).map((q) => q.id))
  const newlyMet = [...met].filter((id) => !putAway.has(id) && !leaving.has(id))
  const unmetLeaving = [...leaving].filter((id) => !met.has(id))
  const unmetPutAway = [...putAway].filter((id) => !met.has(id))
  if (newlyMet.length > 0 || unmetLeaving.length > 0) {
    const next = new Set([...leaving, ...newlyMet])
    for (const id of unmetLeaving) next.delete(id)
    setLeaving(next)
  }
  if (unmetPutAway.length > 0) {
    const next = new Set(putAway)
    for (const id of unmetPutAway) next.delete(id)
    setPutAway(next)
  }

  return { putAway, leaving }
}

/**
 * The countdown timers behind `useMetPutAway`'s `leaving`: one per quota,
 * started when it starts leaving and cleared if it stops. Split out so the
 * hook body stays a render-time derivation.
 */
function useLeaveTimers(
  leaving: ReadonlySet<number>,
  onDone: (id: number) => void,
  timers: React.MutableRefObject<Map<number, ReturnType<typeof setTimeout>>>,
) {
  useEffect(() => {
    const running = timers.current
    for (const id of leaving) {
      if (!running.has(id)) {
        running.set(
          id,
          setTimeout(() => {
            running.delete(id)
            onDone(id)
          }, MET_LEAVE_MS),
        )
      }
    }
    for (const [id, timer] of running) {
      if (!leaving.has(id)) {
        clearTimeout(timer)
        running.delete(id)
      }
    }
  }, [leaving, onDone, timers])

  useEffect(() => {
    const running = timers.current
    return () => {
      for (const timer of running.values()) clearTimeout(timer)
      running.clear()
    }
  }, [timers])
}

/**
 * A label cluster whose every quota was put away, inside one period section.
 * See `finishedClusterInSection`, right below `putAwayMet`, for what becomes
 * of it.
 */
interface FinishedCluster {
  cluster: string
  name: string
  color: LabelColor | null
  count: number
}

/**
 * Take the put-away quotas out of the stream, and whole clusters with them.
 *
 * A cluster that has nothing left to show loses its title too — a heading
 * over nothing reads as a bug — and is handed back as a `FinishedCluster` so
 * the foot can say it was finished rather than it silently vanishing.
 */
function putAwayMet(
  stream: { item: TrackStreamItem; cluster: string }[],
  isPutAway: (task: Task) => boolean,
): { stream: { item: TrackStreamItem; cluster: string }[]; finished: FinishedCluster[] } {
  const titles = new Map<string, Extract<TrackStreamItem, { kind: 'title' }>>()
  const shown = new Map<string, number>()
  const hidden = new Map<string, number>()
  for (const { item, cluster } of stream) {
    if (item.kind === 'title') titles.set(cluster, item)
    else if (isPutAway(item.task)) hidden.set(cluster, (hidden.get(cluster) ?? 0) + 1)
    else shown.set(cluster, (shown.get(cluster) ?? 0) + 1)
  }
  const done = new Set([...hidden.keys()].filter((c) => !shown.has(c)))
  return {
    stream: stream.filter(({ item, cluster }) =>
      item.kind === 'title' ? !done.has(cluster) : !isPutAway(item.task),
    ),
    finished: [...done].map((cluster) => {
      const title = titles.get(cluster)!
      return { cluster, name: title.name, color: title.color, count: hidden.get(cluster)! }
    }),
  }
}

/**
 * How a period section marks a label cluster it put away in full.
 *
 * STILL BEING DECIDED (Trent, 2026-09-23, mid-`mock4`). Before the period
 * redesign, a fully-put-away label stacked as a green "✓ HOUSE 2" chip at the
 * card's foot — `FinishedClusters`, which this replaced (Trent, 2026-09-22:
 * "the category can maybe be moved to the bottom... stack up like chips").
 * Trent disliked that box specifically INSIDE a period section, where the
 * section's own heading already says "M of M" once everything in it is done,
 * so for now this is a no-op: the cluster simply leaves the section, like any
 * other put-away item, with nothing standing in for it. Isolated as its own
 * function, fed the real data either way, so the eventual answer replaces
 * only this — not `sectionBodyItems` or the section layout around it.
 */
function finishedClusterInSection(_finished: FinishedCluster[]): null {
  return null
}

/**
 * The fold-state and DOM key for one period section's one label cluster —
 * `${period}:${label}`, so "kids" under This week and "kids" under This month
 * never share a fold or a summary. See `clusterKey` for the label half.
 */
function sectionClusterKey(sectionKey: string, label: string | null): string {
  return `${sectionKey}:${clusterKey(label)}`
}

/**
 * One section's title/chip stream: `trackStream` scoped to that section's
 * quotas, cluster-tagged, with quotas met at load put away — the same
 * `putAwayMet` the pre-period panel used, run once per section so a cluster
 * spanning periods (a label with both weekly and monthly quotas) is judged,
 * and put away, independently in each.
 */
function sectionBodyItems(
  section: TrackSection,
  labelConfig: LabelConfig[],
  isPutAway: (task: Task) => boolean,
): { item: TrackStreamItem; cluster: string }[] {
  const tagged = withClusters(trackStream(section.tasks, labelConfig), section.key)
  const { stream, finished } = putAwayMet(tagged, isPutAway)
  finishedClusterInSection(finished)
  return stream
}

/**
 * The space above a period section, and the thin divider between sections —
 * never before the first. Tighter on a phone while the periods are folded to
 * their bars (`PERIOD_BODY`): three bars stacked with a desktop section's
 * breathing room between them read as three separate panels, not one gauge.
 * Once a section is opened on the phone it takes the full spacing, since it
 * has chips under it again.
 */
const SECTION_DIVIDER: FoldClasses = {
  open: 'border-foreground/10 mt-3 border-t pt-3',
  shut: 'border-foreground/10 mt-1.5 border-t pt-1.5 sm:mt-3 sm:pt-3',
  auto: 'border-foreground/10 mt-1.5 border-t pt-1.5 sm:mt-3 sm:pt-3',
}

/**
 * A period section's body — its label clusters and chips — FOLDED
 * AWAY ON A PHONE BY DEFAULT (Trent, 2026-09-29: "on mobile, I want quotas to
 * start collapsed … segments: day, week, month. They have the bars fill up so
 * I can see how far I am towards completing today, this week, and this month.
 * Desktop doesn't need it.").
 *
 * So below `sm` the dashboard's panel opens as one line per period — its
 * existing `PeriodHeading`, bar and "M of N" and all, nothing new drawn — and
 * tapping a line opens that period's chips (`PeriodFoldButton`). This walks
 * back part of the 2026-09-21 reversal ("Everything should be expanded for the
 * track on mobile. Otherwise I can't check things off easily"): the whole
 * panel still opens by default (`SECTION_CARD`), and a period is one tap from
 * its chips, rather than the whole card being one tap away as it was before
 * 09-21.
 *
 * `sm`, not the `xl` at which the panel moves to its own column: every other
 * phone-only fold in this file is `sm`, so a tablet-width window keeps the
 * full panel, as it keeps the section fold's desktop behaviour.
 *
 * `shut` still shows the body at `sm` and up, for `SECTION_CARD`'s reason: the
 * toggle is `sm:hidden`, and a period shut on a phone must not leave a widened
 * window with hidden chips and no control to bring them back.
 *
 * WHERE THE CHOICE LIVES: the shared fold store (`FoldStateProvider`), like
 * every other fold on this panel — so an opened period stays open across a
 * trip to /quotas and back, and a reload (or a cold PWA launch) starts folded
 * again. Not on /quotas (`standalone`), nor during a search: those render
 * every body open with no toggle.
 */
const PERIOD_BODY: FoldClasses = {
  open: 'flex',
  shut: 'hidden sm:flex',
  auto: 'hidden sm:flex',
}

/**
 * The panel's body: one `<li data-quota-period>` per section — see
 * `PeriodSection`.
 *
 * ONE outer `<ul aria-label="Quotas">` — sections are `<li>`s inside it,
 * rather than one list per section, so `getByRole('list', { name: 'Quotas' })`
 * still finds exactly one list, as it always has.
 */
function TrackSectionsList({
  sections,
  periods,
  ...rest
}: Omit<PeriodSectionProps, 'section' | 'first' | 'period'> & {
  sections: TrackSection[]
  /** The phone's period folds, or null where periods never fold (standalone, search). */
  periods: ReturnType<typeof useResponsiveFolds> | null
}) {
  return (
    <ul aria-label="Quotas">
      {sections.map((s, i) => (
        <PeriodSection
          key={s.key}
          section={s}
          first={i === 0}
          period={
            periods && {
              state: periods.stateOf(s.key),
              open: periods.isOpen(s.key),
              toggle: () => periods.toggle(s.key),
            }
          }
          {...rest}
        />
      ))}
    </ul>
  )
}

interface PeriodSectionProps {
  section: TrackSection
  first: boolean
  /** This section's phone fold (`PERIOD_BODY`), or null if it never folds. */
  period: { state: FoldState; open: boolean; toggle: () => void } | null
  labelConfig: LabelConfig[]
  isPutAway: (task: Task) => boolean
  /** Met this session and fading out before it is put away (`useMetPutAway`). */
  isLeaving: (task: Task) => boolean
  summaries: Map<string, { count: number; met: number }>
  clusters: ReturnType<typeof useResponsiveFolds>
  detail: ReturnType<typeof useTrackChipDetail>
  /** Search results: clusters render open and cannot be folded (`SEARCH_CLUSTERS`). */
  locked?: boolean
}

/**
 * One period section: its heading and — unless every quota in it was put away
 * (`sectionBodyItems` returns empty) — its label clusters of chips. A fully
 * met section renders ONLY its heading (Trent,
 * 2026-09-23: no body text once a section says "M of M") — that is this
 * length check, not a separate case, since `putAwayMet` only ever empties a
 * section by putting away everything in it. Such a section gets no phone fold
 * button either: there is nothing behind it to open.
 */
function PeriodSection({
  section: s,
  first,
  period,
  labelConfig,
  isPutAway,
  isLeaving,
  summaries,
  clusters,
  detail,
  locked = false,
}: PeriodSectionProps) {
  const bodyItems = sectionBodyItems(s, labelConfig, isPutAway)
  const bodyId = `track-period-${s.key}`
  // No fold (standalone, search): the body's plain display, as before.
  const bodyClass = (classes: FoldClasses) =>
    period ? foldClass(period.state, classes) : classes.open
  return (
    <li
      data-quota-period={s.key}
      className={cn(!first && foldClass(period ? period.state : true, SECTION_DIVIDER))}
    >
      <div className="relative">
        <PeriodHeading section={s} />
        {period && bodyItems.length > 0 && (
          <PeriodFoldButton
            section={s}
            open={period.open}
            onToggle={period.toggle}
            controls={bodyId}
          />
        )}
      </div>
      {bodyItems.length > 0 && (
        // One wrapping row per section: titles and chips are peers in
        // it, the section's own trick inherited from the label-first
        // panel — see the block comment above.
        <ul id={bodyId} className={cn('flex-wrap items-center gap-1.5', bodyClass(PERIOD_BODY))}>
          {bodyItems.map(({ item, cluster }) =>
            item.kind === 'title' ? (
              <ClusterTitle
                key={`title-${cluster}`}
                item={item}
                summary={summaries.get(cluster)}
                state={clusters.stateOf(cluster)}
                open={clusters.isOpen(cluster)}
                onToggle={() => clusters.toggle(cluster)}
                locked={locked}
                className={CLUSTER_TITLE_ROW}
              />
            ) : (
              <TrackChip
                key={item.task.id}
                task={item.task}
                color={item.color}
                foldClassName={foldClass(clusters.stateOf(cluster), FOLD_BODY_BLOCK)}
                leaving={isLeaving(item.task)}
                detailOpen={detail.openId === item.task.id}
                onOpenDetail={detail.openPopover}
                onCloseDetail={detail.closePopover}
                onEdit={detail.openEditor}
                onDeleteQuota={detail.deleteFromPopover}
                periods={detail.openId === item.task.id ? detail.periodsFor(item.task) : undefined}
              />
            ),
          )}
        </ul>
      )}
    </li>
  )
}

/**
 * The phone's handle on a period section's fold: a transparent button laid
 * over the WHOLE heading row, so the bar and the "M of N" are the thing you
 * tap — Trent's rule that an affordance is made of the text, not a glyph
 * beside it, and this panel's chevrons are already spent on the section and
 * cluster folds. The only visible trace is the pressed tint.
 *
 * AN OVERLAY, NOT THE HEADING TURNED INTO A BUTTON. `sm:hidden` takes it out
 * of the layout and the accessibility tree on a desktop, where the heading is
 * plain text and nothing folds — a heading that was itself a button would sit
 * in the desktop's tab order announcing an `aria-expanded` nothing honours.
 * And one heading means one `progressbar` per section at every width.
 *
 * It overhangs the ~26px heading by 6px top and bottom (`-inset-y-1.5`) so the
 * tap target is a comfortable ~38px without making the folded rows taller.
 */
function PeriodFoldButton({
  section,
  open,
  onToggle,
  controls,
}: {
  section: TrackSection
  open: boolean
  onToggle: () => void
  controls: string
}) {
  const verb = open ? 'hide' : 'show'
  return (
    <button
      type="button"
      data-track-period-toggle
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={`${section.heading}: ${section.summary.met} of ${section.summary.count} met — ${verb} its quotas`}
      className="active:bg-foreground/5 absolute inset-x-0 -inset-y-1.5 rounded-lg transition-colors sm:hidden"
    />
  )
}

/**
 * A period section's heading — period first, bold and full-strength ink so it
 * outranks the muted label headings beneath it (`mock4`: "TODAY" reads darker
 * than "HEALTH"). One line: the period name · a muted "N days
 * left" (omitted for Today, which already says it, and for the no-period section, which has no clock) · a bar that
 * flexes to fill whatever room is left · "**M** of N" quotas met.
 *
 * Not a button — nothing here folds. Only the label clusters inside a section
 * (`ClusterTitle`) and the mobile section card (`TrackHeader`) do.
 */
function PeriodHeading({ section }: { section: TrackSection }) {
  const fillPct = Math.round(section.barFraction * 100)
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <span className="text-foreground shrink-0 text-[11px] font-bold tracking-widest whitespace-nowrap uppercase">
        {section.heading}
      </span>
      {section.timeLeft && (
        <span className="text-muted-foreground shrink-0 text-[11px] whitespace-nowrap">
          {section.timeLeft}
        </span>
      )}
      <span
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fillPct}
        aria-valuetext={section.barAriaLabel}
        data-track-period-bar
        className="bg-muted relative h-[5px] min-w-[40px] flex-1 overflow-hidden rounded-full"
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute inset-y-0 left-0 h-full rounded-full transition-[width] duration-300 ease-out',
            section.allMet ? 'bg-green-600' : 'bg-indigo-600 dark:bg-indigo-500',
          )}
          style={{ width: `${section.barFraction * 100}%` }}
        />
        {/* The notch: how much of the period's clock has already run. ONE
            tone at every fraction, whether it sits on the fill or off it
            (Trent, 2026-09-23 — it must not switch shade by what it covers) —
            see `TRACK_NOTCH_CLASS`, tuned in that one place. The bar's own
            `overflow-hidden` clips it to the bar's height, so it never sticks
            out top or bottom; its description lives on the bar's
            `aria-valuetext` above, since the notch itself is decorative. */}
        {section.elapsedFraction !== null && (
          <span
            aria-hidden="true"
            data-track-period-notch
            className={cn('absolute inset-y-0 -ml-px w-[2px]', TRACK_NOTCH_CLASS)}
            style={{ left: `${section.elapsedFraction * 100}%` }}
          />
        )}
      </span>
      <span
        data-track-period-count
        className="text-muted-foreground shrink-0 text-[11px] whitespace-nowrap tabular-nums"
      >
        <span className="text-foreground font-semibold">{section.summary.met}</span> of{' '}
        {section.summary.count}
      </span>
    </div>
  )
}

/** Hidden on a phone while the section is folded — the "N left" line speaks then. */
const MET_COUNT: FoldClasses = {
  open: 'flex',
  shut: 'hidden sm:flex',
  auto: 'flex',
}

/**
 * The panel's header: the phone's section fold, the desktop heading, and — top
 * right, as on every Reminders slot — the met count that shows and hides the
 * met quotas.
 *
 * THE COUNT COPIES THE REMINDERS SLOT'S "X of Y" EXACTLY (Trent, 2026-09-22:
 * "That's where we find things for the reminders. It's in the top right. You
 * click the X of Y to get there"). Same size, same muted text, and the same
 * held gray box while the met ones are showing — see `DashboardRemindersPanel`
 * for why the box, not a weight change, is the state. A button only when
 * something is met; otherwise a plain readout that must not look pressable.
 */
function TrackHeader({
  standalone,
  section,
  overall,
  showMet,
}: {
  /** On /quotas: no section fold, no heading — see `TrackPanelProps.standalone`. */
  standalone: boolean
  section: { state: FoldState; open: boolean; toggle: () => void }
  overall: { count: number; met: number }
  showMet: { shown: boolean; toggle: () => void }
}) {
  const shortfall = quotaShortfall(overall)
  if (standalone) {
    // The met count is never folded away here, because the card never folds.
    return (
      <div className="mb-2 flex min-h-7 items-center justify-end gap-2">
        <TrackMetCount overall={overall} showMet={showMet} foldClassName="flex" />
      </div>
    )
  }
  return (
    <div className="mb-2 flex items-center gap-2">
      {/* Phone: the section fold. One line when shut, and the line carries the
          number that says whether opening it is worth it. */}
      <button
        type="button"
        data-track-section-toggle
        onClick={section.toggle}
        aria-expanded={section.open}
        aria-controls="track-card"
        className="hover:text-foreground flex min-h-7 min-w-0 flex-1 items-center gap-2 px-1 text-left transition-colors sm:hidden"
      >
        <span className="-mr-1.5 flex items-center justify-center p-0.5">
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'text-muted-foreground size-3 shrink-0 transition-transform duration-200',
              foldClass(section.state, FOLD_CHEVRON),
            )}
          />
        </span>
        <span className="text-muted-foreground text-xs font-semibold tracking-wider whitespace-nowrap uppercase">
          Quotas
        </span>
        <span
          data-track-section-summary
          className={cn(
            'ml-auto items-center gap-0.5 text-xs whitespace-nowrap tabular-nums',
            shortfall.allMet ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
            foldClass(section.state, SECTION_SUMMARY),
          )}
        >
          {shortfall.allMet && <Check className="size-3" strokeWidth={3} aria-hidden="true" />}
          {shortfall.full}
        </span>
      </button>

      {/* Desktop: the heading is PLAIN TEXT. It used to be a chips/rows
          switch (a caret button, "Expand/Collapse Quotas"), and Trent kept
          flipping the view by tapping the heading without meaning to
          (2026-09-24); the rows layout itself is gone as of 2026-09-29.
          `hidden … sm:flex` rather than a bare
          `flex`: this is the desktop half of the header pair, and the two
          display utilities would otherwise fight over which one wins. */}
      <div data-track-heading className="hidden min-h-7 min-w-0 flex-1 items-center px-1 sm:flex">
        <span className="text-muted-foreground text-xs font-semibold tracking-wider whitespace-nowrap uppercase">
          Quotas
        </span>
      </div>

      <TrackMetCount
        overall={overall}
        showMet={showMet}
        foldClassName={foldClass(section.state, MET_COUNT)}
      />
    </div>
  )
}

/**
 * The header's "X of Y" met count — a button that shows and hides the met
 * quotas when something is met, otherwise a plain readout. See `TrackHeader`.
 */
function TrackMetCount({
  overall,
  showMet,
  foldClassName,
}: {
  overall: { count: number; met: number }
  showMet: { shown: boolean; toggle: () => void }
  /** Display classes: `MET_COUNT`'s fold on the dashboard, always shown standalone. */
  foldClassName: string
}) {
  const countText = `${overall.met} of ${overall.count}`
  return overall.met > 0 ? (
    <button
      type="button"
      data-track-met-toggle
      onClick={showMet.toggle}
      aria-expanded={showMet.shown}
      aria-label={`${countText} met — ${showMet.shown ? 'hide' : 'show'} the met ones`}
      className={cn(
        'hover:bg-foreground/5 shrink-0 items-center rounded-lg px-1.5 py-1 text-xs whitespace-nowrap tabular-nums transition-colors',
        showMet.shown && 'bg-foreground/5',
        foldClassName,
      )}
    >
      <span className={cn(showMet.shown ? 'text-foreground' : 'text-muted-foreground')}>
        {countText}
      </span>
    </button>
  ) : (
    <span
      aria-label={`${countText} met`}
      className={cn(
        'text-muted-foreground shrink-0 px-1.5 text-xs whitespace-nowrap tabular-nums',
        foldClassName,
      )}
    >
      {countText}
    </span>
  )
}

/**
 * Tag every item in one section's stream with the (period+label) cluster it
 * belongs to.
 *
 * The stream is title-then-its-chips by construction, so the last title seen
 * names the current cluster. Done here rather than in `trackStream` because the
 * cluster key is what the FOLDS are keyed by, and nothing outside this file
 * needs it — `tr-track-stream.test.ts` pins the stream's shape, and a field
 * only the panel reads has no business widening it. `sectionKey` scopes it to
 * ONE section (`sectionClusterKey`): a "kids" title in This week and a "kids"
 * title in This month must tag their chips with different clusters, or the
 * two would share one fold and one put-away decision.
 *
 * A module function, not a loop in the component: the React Compiler rejects
 * reassigning a captured variable inside a callback in a render body, and the
 * accumulator is exactly that.
 */
function withClusters(
  items: TrackStreamItem[],
  sectionKey: string,
): { item: TrackStreamItem; cluster: string }[] {
  let cluster = ''
  return items.map((item) => {
    if (item.kind === 'title') cluster = sectionClusterKey(sectionKey, item.label)
    return { item, cluster }
  })
}

/**
 * The grouping key a title carries in the DOM.
 *
 * The EMPTY STRING for the unlabelled cluster, not the word "unlabelled" or
 * "other": a label with either of those names is legal, and would then share a
 * key — and a selector — with the group of quotas that have no label at all.
 * A label name is validated non-empty and trimmed (`validateLabelConfig`,
 * `createLabel`), so "" is the one key no label can take.
 */
function clusterKey(label: string | null): string {
  return label ?? ''
}

/**
 * A cluster's heading, and the control that folds the cluster.
 *
 * `whitespace-nowrap` so "ideas" never breaks at its hyphen, with
 * `max-w-full truncate` behind it so a very long label ellipsises at the card's
 * edge instead of pushing out of it.
 *
 * The meter is `aria-hidden` and carries no `role`: it is a redraw of the "{n}
 * left" text beside it, and a second `progressbar` here would be noise to a
 * screen reader and a collision for anything counting the panel's real ones.
 */
function ClusterTitle({
  item,
  summary,
  state,
  open,
  onToggle,
  className,
  locked = false,
}: {
  item: Extract<TrackStreamItem, { kind: 'title' }>
  summary: { count: number; met: number } | undefined
  state: FoldState
  open: boolean
  onToggle: () => void
  className: string
  /**
   * Search results: the cluster is shown open and cannot be folded, so the
   * heading is plain text with no chevron — the Reminders surface's `locked`
   * slot header, which drops its button the same way.
   */
  locked?: boolean
}) {
  const count = summary?.count ?? 0
  const met = summary?.met ?? 0
  const shortfall = quotaShortfall({ count, met })
  const allMet = shortfall.allMet

  return (
    <li data-track-cluster={clusterKey(item.label)} className={className}>
      <ClusterTitleShell
        locked={locked}
        onToggle={onToggle}
        open={open}
        className={cn(
          'hover:text-foreground flex w-full items-center gap-1.5 text-left transition-opacity',
          allMet && foldClass(state, CLUSTER_MET_DIM),
        )}
      >
        <span
          aria-hidden="true"
          className={cn('size-2 shrink-0 rounded-full', trackStripeClass(item.color))}
        />
        <span
          data-track-cluster-name
          className="text-muted-foreground min-w-0 truncate text-[11px] font-semibold tracking-widest uppercase"
        >
          {item.name}
        </span>
        {!locked && (
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'text-muted-foreground size-3 shrink-0 transition-transform duration-200',
              foldClass(state, FOLD_CHEVRON),
            )}
          />
        )}
        {/* How many this label has closed, while it is open and still has
            more to do — "it'd be nice to see how many things were completed
            for a given category before the whole category is finished"
            (Trent, 2026-09-22). Green is met's colour everywhere on this
            panel. Shut, the summary on the right says it instead; all met, the
            header already reads "all met". */}
        {met > 0 && !allMet && (
          <span
            data-track-cluster-met
            aria-label={`${met} met`}
            className={cn(
              'items-center gap-0.5 text-[11px] text-green-700 tabular-nums dark:text-green-400',
              foldClass(state, FOLD_BODY_FLEX),
            )}
          >
            <Check className="size-3" strokeWidth={3} aria-hidden="true" />
            {met}
          </span>
        )}

        <span
          data-track-cluster-summary
          className={cn(
            'ml-auto items-center gap-1.5 pl-2 text-[11px] whitespace-nowrap tabular-nums',
            allMet ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
            foldClass(state, FOLD_SUMMARY),
          )}
        >
          <span
            aria-hidden="true"
            className="bg-muted relative block h-[3px] w-[30px] overflow-hidden rounded-full"
          >
            <span
              className={cn(
                'block h-full rounded-full transition-[width] duration-300 ease-out',
                allMet ? 'bg-green-600' : 'bg-foreground/60',
              )}
              style={{ width: `${count === 0 ? 0 : (met / count) * 100}%` }}
            />
          </span>
          {shortfall.allMet ? (
            <span className="flex items-center gap-0.5">
              <Check className="size-3" strokeWidth={3} aria-hidden="true" />
              {shortfall.short}
            </span>
          ) : (
            <span>{shortfall.short}</span>
          )}
        </span>
      </ClusterTitleShell>
    </li>
  )
}

/** `ClusterTitle`'s outer element: the fold's button, or plain text while locked. */
function ClusterTitleShell({
  locked,
  onToggle,
  open,
  className,
  children,
}: {
  locked: boolean
  onToggle: () => void
  open: boolean
  className: string
  children: React.ReactNode
}) {
  if (locked) return <div className={className}>{children}</div>
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className={className}>
      {children}
    </button>
  )
}

/**
 * One quota as a chip.
 *
 * The gestures, and why each one (Trent, 2026-09-06):
 *   tap / click        +1
 *   swipe left         −1   "I think I want to try swiping left to reduce them"
 *   click-drag left    −1   the same handler; pointer events cover both
 *   right-click        −1   "or it could be maybe right-click to subtract one"
 *   shift-click        −1   kept, the pre-existing desktop path
 *   press and hold     open the detail sheet — this REPLACED hold-to-subtract,
 *                      which is why swipe had to take over −1 first
 *
 * The fill behind the text is the count over the target. Long titles wrap the
 * row, never the chip's text.
 */
function TrackChip({
  task,
  color,
  foldClassName,
  leaving = false,
  detailOpen,
  onOpenDetail,
  onCloseDetail,
  onEdit,
  onDeleteQuota,
  periods,
}: {
  task: Task
  /** The cluster's colour; null paints the neutral stripe. */
  color: LabelColor | null
  /** Display classes from the cluster's fold — see `FOLD_BODY_BLOCK`. */
  foldClassName: string
  /** Met this session: fading out before it is put away (`useMetPutAway`). */
  leaving?: boolean
  detailOpen: boolean
  onOpenDetail: (task: Task) => void
  onCloseDetail: () => void
  /** The popover's "Open" button was pressed — opens `QuotaDetailModal`. */
  onEdit: (task: Task) => void
  /** The bubble's trash can. Soft delete, with an Undo toast. */
  onDeleteQuota: (task: Task) => void
  /** Where its daily reminder sits, while its bubble is open — see `periodsFor`. */
  periods?: PromptPeriods
}) {
  const { state, period, log } = useTrackProgress(task)
  const press = useLongPress({ onLongPress: () => onOpenDetail(task) })
  const swipe = useHorizontalSwipe({ onSwipeLeft: () => void log(-1) })

  return (
    <li
      className={cn('max-w-full', foldClassName, leaving && 'animate-met-leave')}
      data-track-leaving={leaving ? '' : undefined}
    >
      <TrackChipPopover
        task={task}
        state={state}
        open={detailOpen}
        onOpenChange={(next) => {
          if (!next) onCloseDetail()
        }}
        onOpen={onEdit}
        onDelete={onDeleteQuota}
        periods={periods}
      >
        <button
          type="button"
          data-track-chip={task.id}
          onPointerDown={(e) => {
            press.onPointerDown(e)
            swipe.onPointerDown(e)
          }}
          onPointerUp={(e) => {
            press.onPointerUp()
            swipe.onPointerUp(e)
          }}
          onPointerMove={(e) => {
            press.onPointerMove(e)
            swipe.onPointerMove(e)
          }}
          onPointerLeave={press.onPointerLeave}
          onPointerCancel={swipe.onPointerCancel}
          onContextMenu={(e) => {
            e.preventDefault()
            // Mouse only. A long-press on iOS can raise a contextmenu of its own,
            // and that must not silently subtract when the user meant to open
            // the sheet.
            if (!press.wasTouch()) void log(-1)
          }}
          onClick={(e) => {
            // A hold opened the sheet and a swipe already logged its −1; the
            // click that trails either one is not a tap.
            if (press.didFire() || swipe.didSwipe()) return
            void log(e.shiftKey ? -1 : 1)
          }}
          // The count is IN the accessible name, not beside it. `aria-label`
          // replaces a button's contents wholesale, so the count on screen and
          // any sr-only run inside are never announced — and in the folded
          // panel this chip is now the only progress there is, the period
          // card's `progressbar` having gone with the cards.
          aria-label={`Log one more for "${task.title}" — ${state.current} of ${state.target}${
            period ? ` ${period}` : ''
          }`}
          title="Tap: +1 · Swipe left, right-click or shift-click: −1 · Hold: details"
          className={cn(
            // leading-5, not leading-none: with the chip clipping its fill, a tight line
            // box cut the descenders off "Eggs" and "Grinding" (Trent, 2026-09-05).
            // touch-action pan-y, NOT touch-manipulation: the page must keep
            // scrolling vertically while the horizontal drag belongs to us.
            // rounded-[10px] rather than a full pill, and an extra 2px of left
            // padding: at pill radius the 3px stripe is clipped into a crescent
            // and stops reading as a stripe.
            'relative flex h-7 max-w-full touch-pan-y items-center gap-1.5 overflow-hidden rounded-[10px] border pr-2.5 pl-3 text-[13px] leading-5 transition-colors select-none',
            'border-foreground/15 bg-background hover:border-foreground/40 active:scale-[0.98]',
            state.met && 'border-green-600/30',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-y-0 left-0 transition-[width] duration-300 ease-out',
              state.met ? 'bg-green-600/15' : 'bg-foreground/10',
            )}
            style={{ width: `${state.fraction * 100}%` }}
          />
          {/* After the fill, not before it: a met chip's fill runs the whole
              width, and underneath it the stripe would be tinted green. */}
          <span
            aria-hidden="true"
            className={cn('absolute inset-y-0 left-0 w-[3px]', trackStripeClass(color))}
          />
          <span className="relative truncate">{task.title}</span>
          <span
            data-track-count
            className={cn(
              'relative text-xs whitespace-nowrap tabular-nums',
              state.met ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
            )}
          >
            {/* No period suffix as of the 2026-09-23 redesign — the section
                this chip sits in already says the period (`PeriodHeading`),
                so repeating it on every chip was the afterthought that
                started the redesign. Sighted-only either way: the button's
                `aria-label` below still spells the period out in full for a
                screen reader, since nothing else on the chip does. */}
            <span className="text-foreground font-medium">{state.current}</span>/{state.target}
          </span>
        </button>
      </TrackChipPopover>
    </li>
  )
}
