'use client'

import { useCallback, useEffect, useState } from 'react'
import { Gauge, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TrackPanel } from '@/components/TrackPanel'
import { useQuotaEditor } from '@/hooks/useQuotaEditor'
import { useQuotasData } from '@/hooks/useQuotasData'
import { LabelFilterBar } from '@/components/LabelFilterBar'
import { useLabelFilter } from '@/hooks/useLabelFilter'
import { filterByLabels } from '@/lib/label-filter'
import { matchesTaskSearch, normalizeTaskSearch } from '@/lib/task-search'
import type { Task } from '@/types'

/** Where this browser keeps the page's label filter — see `useLabelFilter`. */
export const QUOTAS_LABEL_FILTER_KEY = 'opentask.quotasLabelFilter'

/**
 * The Quotas page: the dashboard's Quotas panel, on a page of its own.
 *
 * Trent, 2026-09-25: "the default view when I go to the quotas screen to be the
 * dashboard version of quotas". So the page is `TrackPanel` itself — the same
 * component, not a copy — in its `standalone` mode (no phone section fold, no
 * redundant heading; see that prop).
 *
 * ONE VIEW (Trent, 2026-10-16: "that Details view is pointless… We're going to
 * get rid of that special view"). Until then a Summary/Details switch swapped
 * in a second list (`QuotasView`: rows with "met 2×", selection, the
 * multi-quota editor). Where each of its parts went:
 * - "met N×" → the chip's bubble (hold a chip), with missed, the streak and
 *   the day it was made (`TrackChipPopover`'s `QuotaRecord`).
 * - +1 / −1 → the chip: tap, and swipe left / right-click / shift-click.
 * - editing one → the bubble's Open (`QuotaDetailModal`); trashing one → the
 *   bubble's trash can.
 * - grouping by label → the panel's label clusters, inside each period.
 * - search, New quota, `?quota=<id>` → here and in the panel, below.
 *
 * THE LABEL FILTER (2026-10-24, Trent: "there's no way to filter by tag
 * here… That'd be nice"). The dashboard's label chips — `LabelFilterBar`
 * itself, with its gestures and colours, and the dashboard's rules for what a
 * selection means (src/lib/label-filter.ts: selected labels are OR'd,
 * excluded ones removed) — in one wrapping row under the header row. No
 * "Filters" toggle: the dashboard's folds a stack of five chip rows away, and
 * its open/shut is that page's server preference; one row of labels has
 * nothing to fold. The row is not drawn when no quota has a label.
 * - Counts are over the quotas the search lets through (the dashboard counts
 *   its label chips over its search results with every other filter applied;
 *   here search is the only other one).
 * - What it narrows, and how the numbers follow: `TrackPanel`'s "THE LABEL
 *   FILTER". The line under the chips says the view is filtered, and gives
 *   the whole count — the dashboard's "Showing N of M · Clear filter".
 * - Kept across reloads in this browser (`useLabelFilter`).
 * - selecting several and editing or trashing them together → gone with it.
 *
 * What this adds around the panel is only what the panel does not do for
 * itself on the dashboard: the page's header row, the empty state
 * (`TrackPanel` renders nothing at zero quotas), "New quota" — the button, and
 * the sidebar/phone plus, which reach the page through the `open-add-quota`
 * event — and the `?quota=<id>` deep link.
 */
export function QuotasSummary({
  onUndo,
  onCompleted,
  refreshRef,
  searchQuery,
}: {
  onUndo: () => void
  onCompleted: () => void
  refreshRef?: React.MutableRefObject<(() => void) | null>
  /** The top bar's search. The panel narrows itself (see `TrackPanel`); this
   *  view adds the count line and the no-match state. */
  searchQuery?: string
}) {
  const { tasks, error, refresh } = useQuotasData(refreshRef)
  // Only ever a create from here — editing an existing quota is the panel's
  // own editor, behind a chip's bubble.
  const { openCreate, modal } = useQuotaEditor({ refresh, onUndo, onCompleted })

  // `openCreate` is idempotent: a double-tap on the phone's plus dispatches
  // twice, and a second draft would throw away what was typed.
  useEffect(() => {
    window.addEventListener('open-add-quota', openCreate)
    return () => window.removeEventListener('open-add-quota', openCreate)
  }, [openCreate])

  // `?quota=<id>` — the Quotas widget's deep link (`WidgetLink.quota` →
  // `opentask://quota/<id>` → `/quotas?quota=<id>`, resolved in
  // `OpenTaskApp.handleWidgetLink`); a notification tap on a quota's id is
  // forwarded here by the dashboard's `?task=` effect too. Brings that quota's
  // chip into view and flashes it once; opens nothing — mirrors RemindersView's
  // `?reminder=<id>`. The panel does the showing (`TrackPanel`'s
  // `highlightId`: it unfolds the chip's cluster and shows it even if it is a
  // met one that would be put away).
  //
  // Read in `useState`'s initializer from `window.location.search` rather
  // than `useSearchParams()` (no Suspense boundary needed, and the first paint
  // already carries it). The param is stripped once the list has loaded, so
  // it outlives a remount before the data arrives, and a reload does not
  // flash again. An id that is not one of these quotas matches no chip.
  const [highlightId, setHighlightId] = useState<number | null>(readQuotaParam)
  const clearHighlight = useCallback(() => setHighlightId(null), [])
  const loaded = tasks !== null
  useEffect(() => {
    if (!loaded || !new URLSearchParams(window.location.search).has('quota')) return
    window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [loaded])

  const labels = useLabelFilter(QUOTAS_LABEL_FILTER_KEY)

  const query = normalizeTaskSearch(searchQuery)
  const searching = query.length > 0

  if (tasks === null)
    return <p className="text-muted-foreground py-16 text-center text-sm">{error ?? 'Loading…'}</p>

  return (
    // Not a labelled region: the panel inside is `region "Quotas"` already,
    // and two regions of one name would make "the Quotas panel" ambiguous.
    <div data-quotas-summary className="space-y-3 pb-24">
      <QuotasHeaderRow count={tasks.length} onNew={openCreate} />

      {tasks.length > 0 && (
        <QuotasFilterLines
          quotas={searching ? tasks.filter((t) => matchesTaskSearch(t, query)) : tasks}
          labels={labels}
          searchQuery={searching ? (searchQuery ?? '') : null}
        />
      )}

      {tasks.length === 0 ? (
        <EmptyState />
      ) : (
        <TrackPanel
          tasks={tasks}
          onUndo={onUndo}
          onCompleted={onCompleted}
          onRefresh={refresh}
          standalone
          searchQuery={searchQuery}
          highlightId={highlightId}
          onHighlightDone={clearHighlight}
          labelFilter={labels.criteria}
        />
      )}

      {modal}
    </div>
  )
}

/**
 * The label chips, the search's count line and the "Showing N of M" line, in
 * the dashboard's order (FilterBar, then the search line, then the filtered
 * line). `quotas` is what the search lets through — every quota when not
 * searching — so the chips count it and "of M" is its size, exactly as the
 * dashboard's chips and line count its search results.
 */
function QuotasFilterLines({
  quotas,
  labels,
  searchQuery,
}: {
  quotas: Task[]
  labels: ReturnType<typeof useLabelFilter>
  /** The search as typed, or null when not searching. */
  searchQuery: string | null
}) {
  const filtering = labels.activeCount > 0
  const hasLabels = filtering || quotas.some((q) => q.labels.length > 0)
  const shownCount = filterByLabels(quotas, labels.criteria).length
  return (
    <>
      {hasLabels && (
        <div
          data-quota-label-filter
          role="group"
          aria-label="Filter by label"
          className="flex flex-wrap items-center gap-1.5 px-1"
        >
          <LabelFilterBar
            tasks={quotas}
            selectedLabels={labels.criteria.selectedLabels}
            excludedLabels={labels.criteria.excludedLabels}
            onToggleLabel={labels.toggleLabel}
            onExclusiveLabel={labels.exclusiveLabel}
            onExcludeLabel={labels.excludeLabel}
          />
        </div>
      )}

      {searchQuery !== null && <QuotasSearchCount count={quotas.length} query={searchQuery} />}

      {/* An empty result under a search already says "No quota here says
          that"; this line is about the label filter only. */}
      {filtering && quotas.length > 0 && (
        <div
          data-quota-filter-count={shownCount}
          className="text-muted-foreground rounded-md bg-blue-50 px-3 py-2 text-sm dark:bg-blue-950/30"
        >
          Showing {shownCount} of {quotas.length} quota{quotas.length === 1 ? '' : 's'}{' '}
          <span className="mx-1">&middot;</span>
          <button
            type="button"
            onClick={labels.clearLabels}
            className="text-foreground font-medium hover:underline"
          >
            Clear filter
          </button>
        </div>
      )}
    </>
  )
}

/** `?quota=<id>` as a number, or null — see `QuotasSummary`'s deep-link comment. */
function readQuotaParam(): number | null {
  if (typeof window === 'undefined') return null
  const id = Number.parseInt(new URLSearchParams(window.location.search).get('quota') ?? '', 10)
  return Number.isNaN(id) ? null : id
}

/** The page's header row: the count, which is the page's h1, and "New quota". */
function QuotasHeaderRow({ count, onNew }: { count: number; onNew: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      {/* The page's h1, exactly as the Reminders headline is: this one line
          is the surface's summary, so it is the heading rather than a
          paragraph sitting where a heading should be. */}
      <h1 className="text-muted-foreground text-sm whitespace-nowrap">
        {count === 0 ? 'No quotas yet.' : `${count} quota${count === 1 ? '' : 's'}`}
      </h1>
      {/* "New" on a phone, "New quota" wider; the accessible name stays
          "New quota" at every width. */}
      <Button size="sm" onClick={onNew} aria-label="New quota">
        <Plus className="size-4" />
        <span className="sm:hidden">New</span>
        <span className="hidden sm:inline">New quota</span>
      </Button>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <div className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-full">
        <Gauge className="size-5" />
      </div>
      <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
        A quota is something you do a set number of times in a period — &ldquo;eat beef four times a
        week&rdquo;. It counts instead of completing, and it is never late.
      </p>
    </div>
  )
}

/**
 * The count line shown while a search is active, and the no-match state — the
 * Reminders surface's `SearchResults` header, word for word apart from the
 * noun, so the two pages read the same.
 */
function QuotasSearchCount({ count, query }: { count: number; query: string }) {
  return (
    <>
      <div className="text-muted-foreground px-2 text-sm" data-search-count={count}>
        {count} result{count !== 1 ? 's' : ''} for &ldquo;{query.trim()}&rdquo;
      </div>
      {count === 0 && (
        <p className="text-muted-foreground py-12 text-center text-sm">No quota here says that.</p>
      )}
    </>
  )
}
