'use client'

import { Fragment, useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronDown, Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trackedItems } from '@/lib/slot-view'
import {
  groupByLabel,
  periodSuffix,
  quotaGroupSummary,
  quotaShortfall,
  trackState,
  trackStream,
  trackStripeClass,
  type TrackStreamItem,
} from '@/lib/track'
import { useTrackProgress } from '@/hooks/useTrackProgress'
import { useFoldState } from '@/components/FoldStateProvider'
import { useLongPress } from '@/hooks/useLongPress'
import { useHorizontalSwipe } from '@/hooks/useHorizontalSwipe'
import { useQuotaMutations } from '@/hooks/useQuotaMutations'
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
import { TrackChipPopover } from '@/components/TrackChipPopover'
import { QuotaDetailModal } from '@/components/QuotaDetailModal'
import { GuardedLink } from '@/components/GuardedLink'
import { useNavigationGuard } from '@/components/NavigationGuardProvider'
import { useLabelConfig, useTrackPanelPreference } from '@/components/PreferencesProvider'
import type { LabelColor, Task } from '@/types'

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
 * - The panel is a plain group header ("TRACK") over ONE card. Two states,
 *   remembered as a user preference like the filter section. FOLDED (the
 *   default) the card holds its quotas as tight CHIPS with their full titles,
 *   wrapping wherever the width runs out (Trent, 2026-09-05: eight open rows
 *   pushed the first task of the day below the fold on his phone, and a folded
 *   one-liner hid the quotas). A chip is as wide as its title needs, up to the
 *   card; past that the title ellipsises, which on a phone the longest few do.
 *   The count never truncates — it is the thing the chip is for. Open the panel,
 *   or hold a chip, to read a title in full. Tap a chip: +1. Hold, or shift-click: −1.
 *   The chip's background fills as the count climbs and turns green at the
 *   target, so each chip is its own bar. OPEN, it is the full rows.
 * - Order is by label then title, and never changes on a tap — the widget's
 *   "order jumps under your finger" complaint applied verbatim here.
 * - "Met" is a state, not an exit: green check, count keeps going (3/2).
 *
 * MET QUOTAS ARE PUT AWAY — AT LOAD, NEVER UNDER A FINGER (Trent,
 * 2026-09-22). He tried two orders by how many are left (live was "too jumpy")
 * and then hiding a quota the moment it was met, and ruled: "alphabetical,
 * hide the complete ones", but "things should not disappear until reload."
 *
 * - The quotas already met when the panel LOADS are put away (`useMetAtLoad`).
 *   One met during the session stays where it is, green, until the next load.
 * - A label whose every quota was put away leaves the stream, title and all,
 *   and stacks at the card's foot as one green chip — "✓ HOUSE 2" — so a
 *   finished category is seen to be finished (`FinishedClusters`).
 * - A label that is partly done says how many, beside its name (`✓ 2`).
 * - The header's top right carries "3 of 19" — met of total — and tapping it
 *   shows the met ones in place, copying the Reminders slot's "X of Y"
 *   exactly (`TrackHeader`). The choice lives in the fold store: it survives
 *   navigating away and back, and a reload puts them away again.
 * - The order is still label then title. Nothing moves on a tap.
 *
 * GROUPED BY LABEL, AS ONE STREAM (Trent, 2026-09-09, picking variation G of
 * the `track-by-label` mockup, with D's stripe). It used to be one card per
 * period — DAY / WEEK / MONTH, each with a summed progress bar. The label is
 * the question a quota answers to ("there's a bunch of stuff for the kids and
 * there are other things"), and the period is answered by two letters on the
 * chip, so:
 *
 * - ONE card, holding ONE wrapping row. A cluster opens with its label in the
 *   panel's own small uppercase run — a plain flex item, so its chips flow
 *   after it on the same line and wrap with everything else.
 * - A TITLE ALWAYS STARTS ITS OWN ROW (Trent, 2026-09-09, on the dev build).
 *   The mockup let a title attach after the previous cluster's last chip, which
 *   is what made variation G the shortest of the seven drawn — but "house"
 *   landing mid-row after a health chip read as confusing rather than compact.
 *   A zero-height full-width `<li>` before each title after the first forces
 *   the wrap; the title itself keeps no left margin, so it sits flush with the
 *   card's left edge and the chips follow it across. The break is layout only,
 *   which is why it lives here and not in `trackStream`.
 * - NO summed bar. A bar across a group that mixes days, weeks and months is
 *   "2 a day + 3 a week + 1 a month = 7", a number nobody can act on. The
 *   Quotas page dropped it for the same reason when it moved to labels.
 * - The period lives on the chip instead, as a muted suffix: 0/2·d, 0/3·wk.
 * - A 3px stripe down the chip's left edge in the label's colour, and the same
 *   colour as a dot on the title (variation D). The chip's radius drops from a
 *   full pill to 10px so the stripe reads as a stripe rather than a crescent.
 *   Colour comes from `label_config`, the same place every other label colour
 *   in the app comes from; a label nobody has coloured, and the unlabelled
 *   cluster, get a neutral one rather than a palette invented in code. Green is
 *   reserved for "met", so `trackStripeClass` declines it: a label the user
 *   coloured green gets a neutral stripe HERE, and keeps its green chips
 *   everywhere else.
 *
 * OPEN, the same clusters in the same order become headings over the full
 * rows. Not drawn in the mockup — that was about the folded state, which is how
 * the panel ships — but the alternative was for the grouping to vanish the
 * moment the panel is expanded, and for the rows to be a flat list of 19 with
 * no organising idea at all. The stripe stays on the chips only: a row already
 * carries its own bar down that side of the panel.
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
 *    left`. It is a SECOND header button, `sm:hidden`, sitting beside the
 *    original one rather than replacing it. The original button means something
 *    else entirely — chips versus full rows — and folding that meaning into a
 *    single chevron would have made one control mean two things depending on
 *    the width it was pressed at.
 *
 *    That pair left the phone with no handle on chips-versus-rows at all, and
 *    `track_expanded` is a SERVER preference: a user who switched to rows at a
 *    desk arrived on his phone stuck in the taller view with nothing to press.
 *    So the card carries its own `sm:hidden` "Show as chips / Show as rows"
 *    link at its foot. Inside the card rather than beside the header, because
 *    it is only worth offering once there is something to look at, and a word
 *    rather than a chevron because the two folds on this panel already own
 *    every chevron in sight.
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
 * A cluster heading's width in the wrapping chip row.
 *
 * Open, it is auto — the whole point of the layout is that the chips flow after
 * the heading on its line. Shut, there are no chips to flow, and the heading
 * takes the full row so its meter and count can sit flush right.
 */
const CLUSTER_BASIS: FoldClasses = {
  open: '',
  shut: 'basis-full',
  auto: '',
}

/** A met cluster steps back — but only while it is shut and standing in for its chips. */
const CLUSTER_MET_DIM: FoldClasses = {
  open: '',
  shut: 'opacity-60',
  auto: '',
}

/** A quota row in the open panel. As `FOLD_BODY_BLOCK`, for a row that is a flex line. */
const CLUSTER_ROW: FoldClasses = {
  open: 'flex',
  shut: 'hidden',
  auto: 'flex',
}

/** `useQuotaMutations`'s `clear` — there is no selection on this panel to clear. */
const noop = () => {}

/**
 * All chip-level "detail" state for Track: which quota's popover bubble is
 * open, and which (if any) is open in the full `QuotaDetailModal` editor —
 * plumbed with the exact same mutations `QuotasView` uses
 * (`useQuotaMutations`) and the exact same deep-link escape hatch
 * (`requestNavigation` + `router.push`), so pressing a chip's "Open" button
 * edits the same way `/quotas` does, just without leaving (Trent, 2026-09-21:
 * "whenever I do things with tasks it opens a modal... that's how I like to
 * work"). One hook rather than state split across `TrackPanel` and its
 * chips' callers, so the panel's own render stays short — the same reason
 * `useQuotaMutations` is its own file rather than inline in `QuotasView`.
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
  const router = useRouter()
  const { requestNavigation } = useNavigationGuard()
  // The quota whose popover bubble is showing. By id, not object, so a sync
  // refresh can replace the rendered task underneath an open bubble.
  const [openId, setOpenId] = useState<number | null>(null)
  const [editing, setEditing] = useState<Task[]>([])
  const { saveQuotas, createQuota, deleteQuotas } = useQuotaMutations({
    refresh: onRefresh,
    clear: noop,
    onUndo,
    onCompleted,
  })

  const openPopover = useCallback((task: Task) => setOpenId(task.id), [])
  const closePopover = useCallback(() => setOpenId(null), [])
  // The popover's own "Open" button: the bubble it was pressed from closes,
  // the editor replaces it — never both open at once.
  const openEditor = useCallback((task: Task) => {
    setOpenId(null)
    setEditing([task])
  }, [])
  // The bubble's trash can: the bubble it was pressed from goes with it.
  const deleteFromPopover = useCallback(
    (task: Task) => {
      setOpenId(null)
      void deleteQuotas([task])
    },
    [deleteQuotas],
  )

  const modal = (
    <QuotaDetailModal
      tasks={editing}
      open={editing.length > 0}
      onClose={() => setEditing([])}
      onSave={saveQuotas}
      onCreate={createQuota}
      onDelete={(targets) => void deleteQuotas(targets)}
      onOpenPage={(id) => {
        // Through the guard, like every other route change in the app.
        if (requestNavigation(`/tasks/${id}`)) router.push(`/tasks/${id}`)
      }}
    />
  )

  return { openId, openPopover, closePopover, openEditor, deleteFromPopover, modal }
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
}

export function TrackPanel({ tasks, onUndo, onCompleted, onRefresh }: TrackPanelProps) {
  const { trackExpanded: open, setTrackExpanded: setOpen } = useTrackPanelPreference()
  const { labelConfig } = useLabelConfig()
  const detail = useTrackChipDetail({ onUndo, onCompleted, onRefresh })
  const section = useResponsiveFold('track-section')
  const clusters = useResponsiveFolds('track-cluster')
  const quotas = trackedItems(tasks)

  // What each cluster's shut header says. Keyed the same way the DOM is, so a
  // heading and its summary can never be looking at different groups.
  const summaries = clusterSummaries(quotas)

  const showMet = useShowMet()
  const metAtLoad = useMetAtLoad(quotas)
  const { stream, finished } = putAwayMet(
    withClusters(trackStream(quotas, labelConfig)),
    (task) => !showMet.shown && metAtLoad.has(task.id) && trackState(task).met,
  )

  if (quotas.length === 0) return null

  const overall = quotaGroupSummary(quotas)

  return (
    <section aria-label="Quotas" data-track-panel className="mb-6">
      <TrackHeader
        section={section}
        open={open}
        onToggleView={() => setOpen(!open)}
        overall={overall}
        showMet={showMet}
      />

      <div
        id="track-card"
        className={cn('bg-muted/30 rounded-2xl p-2', foldClass(section.state, SECTION_CARD))}
      >
        {open ? (
          <ul aria-label="Quotas">
            {stream.map(({ item, cluster }) =>
              item.kind === 'title' ? (
                <ClusterTitle
                  key={`title-${cluster}`}
                  item={item}
                  summary={summaries.get(cluster)}
                  state={clusters.stateOf(cluster)}
                  open={clusters.isOpen(cluster)}
                  onToggle={() => clusters.toggle(cluster)}
                  className="px-2 pt-3 pb-1 first:pt-1"
                />
              ) : (
                <TrackRow
                  key={item.task.id}
                  task={item.task}
                  foldClassName={foldClass(clusters.stateOf(cluster), CLUSTER_ROW)}
                />
              ),
            )}
          </ul>
        ) : (
          // One wrapping row for the whole panel: titles and chips are peers in
          // it, which is the entire trick — see the block comment above.
          <ul className="flex flex-wrap items-center gap-1.5" aria-label="Quotas">
            {stream.map(({ item, cluster }, i) =>
              item.kind === 'title' ? (
                <Fragment key={`title-${cluster}`}>
                  {/* The wrap that puts this title at the start of a row. A
                      full-basis, zero-height item fills whatever is left of the
                      line above and takes no height of its own; the row gap on
                      either side of it is the space between clusters. Not
                      before the first title, which already starts row one. */}
                  {i > 0 && <li aria-hidden="true" className="h-0 basis-full" />}
                  <ClusterTitle
                    item={item}
                    summary={summaries.get(cluster)}
                    state={clusters.stateOf(cluster)}
                    open={clusters.isOpen(cluster)}
                    onToggle={() => clusters.toggle(cluster)}
                    className={cn(
                      'max-w-full',
                      foldClass(clusters.stateOf(cluster), CLUSTER_BASIS),
                    )}
                  />
                </Fragment>
              ) : (
                <TrackChip
                  key={item.task.id}
                  task={item.task}
                  color={item.color}
                  foldClassName={foldClass(clusters.stateOf(cluster), FOLD_BODY_BLOCK)}
                  detailOpen={detail.openId === item.task.id}
                  onOpenDetail={detail.openPopover}
                  onCloseDetail={detail.closePopover}
                  onEdit={detail.openEditor}
                  onDeleteQuota={detail.deleteFromPopover}
                />
              ),
            )}
          </ul>
        )}

        <FinishedClusters finished={finished} spaced={stream.length > 0} onShow={showMet.toggle} />

        {/* The phone's only route between chips and rows. See the block comment
            above: the desktop header button that does this is `sm:hidden`'s
            opposite number, and without this one a `track_expanded` pinned on a
            desktop was unreachable on a phone. Right-aligned and muted — it is
            a way out of a view, not a thing to press on the way in. */}
        <div className="mt-1 flex justify-end sm:hidden">
          <button
            type="button"
            data-track-view-toggle
            onClick={() => setOpen(!open)}
            className="text-muted-foreground hover:text-foreground px-2 py-1 text-[11px] font-medium transition-colors"
          >
            {open ? 'Show as chips' : 'Show as rows'}
          </button>
        </div>
      </div>

      {detail.modal}
    </section>
  )
}

function clusterSummaries(quotas: Task[]) {
  return new Map(groupByLabel(quotas).map((g) => [clusterKey(g.label), quotaGroupSummary(g.tasks)]))
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

/**
 * The quotas that were already met when the panel loaded — the only ones it
 * puts away.
 *
 * Decided once, on the first render that has quotas, and held. A quota met
 * during the session stays exactly where it is, green, until the next load
 * (Trent, 2026-09-22: "things should not disappear until reload... It's
 * disorienting to have it jump around"). The caller also requires the quota to
 * STILL be met, so one that stops being met — the period rolled over, or a −1
 * came in from the phone — comes back rather than staying hidden on a stale
 * snapshot.
 *
 * Set during render rather than in an effect, so the first paint is already
 * the put-away one; React allows a state update during render for this
 * derive-once case.
 */
function useMetAtLoad(quotas: Task[]): ReadonlySet<number> {
  const [ids, setIds] = useState<ReadonlySet<number> | null>(null)
  if (ids === null && quotas.length > 0) {
    const next = new Set(quotas.filter((q) => trackState(q).met).map((q) => q.id))
    setIds(next)
    return next
  }
  return ids ?? new Set()
}

/** A label whose every quota was put away: it becomes one chip at the foot. */
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
 * The finished labels, stacked at the foot of the card as chips.
 *
 * Trent, 2026-09-22: "If we finish everything for a given category, I want to
 * see that that category was finished. The category can maybe be moved to the
 * bottom. They can kind of stack up like chips, with maybe the count of how
 * many things got completed." So each is the label's name, a check, and how
 * many quotas it closed — green, because green is this panel's word for met.
 * Tapping one shows the met quotas, which is where you would go to see what
 * those were.
 *
 * Only labels finished AT LOAD land here (see `useMetAtLoad`). One finished
 * during the session stays in place until the next load.
 */
function FinishedClusters({
  finished,
  spaced,
  onShow,
}: {
  finished: FinishedCluster[]
  /** There are quotas above, so leave a gap. */
  spaced: boolean
  onShow: () => void
}) {
  if (finished.length === 0) return null
  return (
    <ul
      aria-label="Finished"
      data-track-finished
      className={cn('flex flex-wrap items-center gap-1.5', spaced && 'mt-3')}
    >
      {finished.map((f) => (
        <li key={f.cluster}>
          <button
            type="button"
            data-track-finished-cluster={f.cluster}
            onClick={onShow}
            aria-label={`${f.name}: all ${f.count} met — show them`}
            className="flex h-7 items-center gap-1.5 rounded-[10px] border border-green-600/30 bg-green-600/10 px-2.5 text-[11px] font-semibold tracking-widest text-green-700 uppercase transition-colors hover:bg-green-600/15 dark:text-green-400"
          >
            <span
              aria-hidden="true"
              className={cn('size-2 shrink-0 rounded-full', trackStripeClass(f.color))}
            />
            {f.name}
            <span className="flex items-center gap-0.5 tracking-normal tabular-nums">
              <Check className="size-3" strokeWidth={3} aria-hidden="true" />
              {f.count}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Hidden on a phone while the section is folded — the "N left" line speaks then. */
const MET_COUNT: FoldClasses = {
  open: 'flex',
  shut: 'hidden sm:flex',
  auto: 'flex',
}

/**
 * The panel's header: the phone's section fold, the desktop chips/rows caret,
 * and — top right, as on every Reminders slot — the met count that shows and
 * hides the met quotas.
 *
 * THE COUNT COPIES THE REMINDERS SLOT'S "X of Y" EXACTLY (Trent, 2026-09-22:
 * "That's where we find things for the reminders. It's in the top right. You
 * click the X of Y to get there"). Same size, same muted text, and the same
 * held gray box while the met ones are showing — see `DashboardRemindersPanel`
 * for why the box, not a weight change, is the state. A button only when
 * something is met; otherwise a plain readout that must not look pressable.
 */
function TrackHeader({
  section,
  open,
  onToggleView,
  overall,
  showMet,
}: {
  section: { state: FoldState; open: boolean; toggle: () => void }
  open: boolean
  onToggleView: () => void
  overall: { count: number; met: number }
  showMet: { shown: boolean; toggle: () => void }
}) {
  const shortfall = quotaShortfall(overall)
  const countText = `${overall.met} of ${overall.count}`
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

      {/* A plain group header, built exactly like "Early morning" below —
          same padding, chevron size and negative margin — so the carets and
          labels line up. The caret switches the card between chips and the
          full rows. `hidden … sm:flex` rather than a bare `flex`: this is the
          desktop half of the header pair, and the two display utilities would
          otherwise fight over which one wins. */}
      <button
        type="button"
        onClick={onToggleView}
        aria-expanded={open}
        aria-label={open ? 'Collapse Quotas' : 'Expand Quotas'}
        className="hover:text-foreground hidden min-h-7 min-w-0 flex-1 items-center gap-2 px-1 text-left transition-colors sm:flex"
      >
        <span className="-mr-1.5 flex items-center justify-center p-0.5">
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'text-muted-foreground size-3 shrink-0 transition-transform duration-200',
              !open && '-rotate-90',
            )}
          />
        </span>
        <span className="text-muted-foreground text-xs font-semibold tracking-wider whitespace-nowrap uppercase">
          Quotas
        </span>
      </button>

      {overall.met > 0 ? (
        <button
          type="button"
          data-track-met-toggle
          onClick={showMet.toggle}
          aria-expanded={showMet.shown}
          aria-label={`${countText} met — ${showMet.shown ? 'hide' : 'show'} the met ones`}
          className={cn(
            'hover:bg-foreground/5 shrink-0 items-center rounded-lg px-1.5 py-1 text-xs whitespace-nowrap tabular-nums transition-colors',
            showMet.shown && 'bg-foreground/5',
            foldClass(section.state, MET_COUNT),
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
            foldClass(section.state, MET_COUNT),
          )}
        >
          {countText}
        </span>
      )}
    </div>
  )
}

/**
 * Tag every item in the flat stream with the cluster it belongs to.
 *
 * The stream is title-then-its-chips by construction, so the last title seen
 * names the current cluster. Done here rather than in `trackStream` because the
 * cluster key is what the FOLDS are keyed by, and nothing outside this file
 * needs it — `tr-track-stream.test.ts` pins the stream's shape, and a field
 * only the panel reads has no business widening it.
 *
 * A module function, not a loop in the component: the React Compiler rejects
 * reassigning a captured variable inside a callback in a render body, and the
 * accumulator is exactly that.
 */
function withClusters(items: TrackStreamItem[]): { item: TrackStreamItem; cluster: string }[] {
  let cluster = ''
  return items.map((item) => {
    if (item.kind === 'title') cluster = clusterKey(item.label)
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
}: {
  item: Extract<TrackStreamItem, { kind: 'title' }>
  summary: { count: number; met: number } | undefined
  state: FoldState
  open: boolean
  onToggle: () => void
  className: string
}) {
  const count = summary?.count ?? 0
  const met = summary?.met ?? 0
  const shortfall = quotaShortfall({ count, met })
  const allMet = shortfall.allMet

  return (
    <li data-track-cluster={clusterKey(item.label)} className={className}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
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
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'text-muted-foreground size-3 shrink-0 transition-transform duration-200',
            foldClass(state, FOLD_CHEVRON),
          )}
        />
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
      </button>
    </li>
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
  detailOpen,
  onOpenDetail,
  onCloseDetail,
  onEdit,
  onDeleteQuota,
}: {
  task: Task
  /** The cluster's colour; null paints the neutral stripe. */
  color: LabelColor | null
  /** Display classes from the cluster's fold — see `FOLD_BODY_BLOCK`. */
  foldClassName: string
  detailOpen: boolean
  onOpenDetail: (task: Task) => void
  onCloseDetail: () => void
  /** The popover's "Open" button was pressed — opens `QuotaDetailModal`. */
  onEdit: (task: Task) => void
  /** The bubble's trash can. Soft delete, with an Undo toast. */
  onDeleteQuota: (task: Task) => void
}) {
  const { state, period, log } = useTrackProgress(task)
  const press = useLongPress({ onLongPress: () => onOpenDetail(task) })
  const swipe = useHorizontalSwipe({ onSwipeLeft: () => void log(-1) })
  const suffix = period ? periodSuffix(period) : null

  return (
    <li className={cn('max-w-full', foldClassName)}>
      <TrackChipPopover
        task={task}
        state={state}
        open={detailOpen}
        onOpenChange={(next) => {
          if (!next) onCloseDetail()
        }}
        onOpen={onEdit}
        onDelete={onDeleteQuota}
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
            <span className="text-foreground font-medium">{state.current}</span>/{state.target}
            {/* The period, two letters, always muted — even on a met chip,
                where the count beside it goes green. It is which clock this
                counts against, not part of the score. Sighted-only by
                construction: the button's `aria-label` spells the period out
                in full. */}
            {suffix && <span className="text-muted-foreground">·{suffix}</span>}
          </span>
        </button>
      </TrackChipPopover>
    </li>
  )
}

function TrackRow({ task, foldClassName }: { task: Task; foldClassName: string }) {
  const { state, period, log } = useTrackProgress(task)

  return (
    <li
      data-track-row={task.id}
      className={cn(
        'hover:bg-background flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-2 py-2 transition-colors',
        foldClassName,
      )}
    >
      {/* The rows view is the keyboard-reachable route into a quota. The chips'
          press-and-hold has no keyboard equivalent, and the popover it opens is
          anchored to a chip that does not exist here — so this goes straight to
          the editor, which is the fuller thing and where a row has the room to
          send you. */}
      <GuardedLink
        href={`/tasks/${task.id}`}
        title={`${task.title} — open`}
        className={cn(
          'hover:text-foreground basis-full truncate rounded text-left text-[15px] underline-offset-4 hover:underline sm:flex-1 sm:basis-0',
          state.met ? 'text-foreground/70' : 'text-foreground',
        )}
      >
        {task.title}
      </GuardedLink>

      {/* Fixed-width cluster, flush right: the same columns on every line. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div
          className="bg-muted relative h-1.5 w-24 overflow-hidden rounded-full sm:w-28"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={state.target}
          aria-valuenow={state.current}
          aria-label={`${state.current} of ${state.target}${period ? ` ${period}` : ''}`}
        >
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-300 ease-out',
              state.met ? 'bg-green-600' : 'bg-foreground/60',
            )}
            style={{ width: `${state.fraction * 100}%` }}
          />
        </div>

        <span
          data-track-count
          className={cn(
            'flex w-16 items-center justify-end gap-1 text-sm whitespace-nowrap tabular-nums',
            state.met ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
          )}
        >
          {state.met && <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />}
          <span>
            <span className="text-foreground font-medium">{state.current}</span> / {state.target}
          </span>
          {period && <span className="sr-only"> {period}</span>}
        </span>

        <button
          type="button"
          onClick={() => void log(-1)}
          disabled={state.current === 0}
          aria-label={`Remove one from "${task.title}"`}
          title="Remove one"
          className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground flex size-7 items-center justify-center rounded-full border transition-colors disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Minus className="size-3.5" strokeWidth={2.5} />
        </button>
        <button
          type="button"
          onClick={() => void log(1)}
          // The count is IN the accessible name, not beside it. `aria-label`
          // replaces a button's contents wholesale, so the count on screen and
          // any sr-only run inside are never announced — and in the folded
          // panel this chip is now the only progress there is, the period
          // card's `progressbar` having gone with the cards.
          aria-label={`Log one more for "${task.title}" — ${state.current} of ${state.target}${
            period ? ` ${period}` : ''
          }`}
          title="Log one more"
          className="text-foreground hover:bg-foreground/5 flex h-7 w-14 items-center justify-center gap-1 rounded-full border text-xs font-medium transition-colors"
        >
          <Plus className="size-3.5" strokeWidth={2.5} />1
        </button>
      </div>
    </li>
  )
}
