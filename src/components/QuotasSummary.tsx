'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { TrackPanel } from '@/components/TrackPanel'
import { QuotaDetailModal } from '@/components/QuotaDetailModal'
import type { QuotaCreateDraft } from '@/components/QuotaDetail'
import { EmptyState, QuotasHeaderRow, QuotasSearchCount } from '@/components/QuotasView'
import { useNavigationGuard } from '@/components/NavigationGuardProvider'
import { useQuotaMutations } from '@/hooks/useQuotaMutations'
import { useQuotasData } from '@/hooks/useQuotasData'
import { matchesTaskSearch, normalizeTaskSearch } from '@/lib/task-search'

/**
 * /quotas' default view: the dashboard's Quotas panel, on a page of its own.
 *
 * Trent, 2026-09-25: "the default view when I go to the quotas screen to be the
 * dashboard version of quotas, with an option to expand it to the view that you
 * have here, where it shows how many have been met." So the page opens on
 * `TrackPanel` itself — the same component, not a copy — in its `standalone`
 * mode (no phone section fold, no redundant heading; see that prop), and
 * `QuotasView`, the detailed list with "met 2×", selection and the multi-quota
 * editor, is one press of the page's Summary/Details switch away.
 *
 * What this adds around the panel is only what the panel does not do for
 * itself on the dashboard: the page's header row (shared with `QuotasView` so
 * the two views line up), the empty state (`TrackPanel` renders nothing at zero
 * quotas), and "New quota" — the button, and the sidebar/phone plus, which
 * reach the page through the `open-add-quota` event exactly as they reach
 * `QuotasView`. Editing an existing quota is the panel's own: hold a chip, then
 * "Open", which is its `QuotaDetailModal`.
 */
export function QuotasSummary({
  onUndo,
  onCompleted,
  refreshRef,
  viewSwitch,
  searchQuery,
}: {
  onUndo: () => void
  onCompleted: () => void
  refreshRef?: React.MutableRefObject<(() => void) | null>
  viewSwitch?: React.ReactNode
  /** The top bar's search. The panel narrows itself (see `TrackPanel`); this
   *  view adds the count line and the no-match state, as `QuotasView` does. */
  searchQuery?: string
}) {
  const router = useRouter()
  const { requestNavigation } = useNavigationGuard()
  const { tasks, error, refresh } = useQuotasData(refreshRef)
  const [creating, setCreating] = useState<QuotaCreateDraft | null>(null)
  const { saveQuotas, createQuota, deleteQuotas } = useQuotaMutations({
    refresh,
    clear: noop,
    onUndo,
    onCompleted,
  })

  // Idempotent, as in `QuotasView`: a double-tap on the phone's plus
  // dispatches twice, and a second draft would throw away what was typed.
  useEffect(() => {
    const open = () => setCreating((current) => current ?? { title: '' })
    window.addEventListener('open-add-quota', open)
    return () => window.removeEventListener('open-add-quota', open)
  }, [])

  const query = normalizeTaskSearch(searchQuery)
  const searching = query.length > 0

  if (tasks === null)
    return <p className="text-muted-foreground py-16 text-center text-sm">{error ?? 'Loading…'}</p>

  return (
    // Not a labelled region: the panel inside is `region "Quotas"` already,
    // and two regions of one name would make "the Quotas panel" ambiguous.
    <div data-quotas-summary className="space-y-3 pb-24">
      <QuotasHeaderRow
        count={tasks.length}
        onNew={() => setCreating({ title: '' })}
        viewSwitch={viewSwitch}
      />

      {searching && tasks.length > 0 && (
        <QuotasSearchCount
          count={tasks.filter((t) => matchesTaskSearch(t, query)).length}
          query={searchQuery ?? ''}
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
        />
      )}

      <QuotaDetailModal
        tasks={[]}
        create={creating}
        open={creating !== null}
        onClose={() => setCreating(null)}
        onSave={saveQuotas}
        onCreate={createQuota}
        onDelete={(targets) => void deleteQuotas(targets)}
        onOpenPage={(id) => {
          if (requestNavigation(`/tasks/${id}`)) router.push(`/tasks/${id}`)
        }}
      />
    </div>
  )
}

/** `useQuotaMutations`' `clear` — nothing on this view is selected. */
function noop() {}

export type QuotasPageView = 'summary' | 'details'

/**
 * The page's Summary / Details switch.
 *
 * A two-option segmented control styled exactly like the dashboard's
 * `ViewModeToggle` (Today / Projects / All) — the app's one pattern for "the
 * same things, shown another way". (It was deliberately not a "Show as …"
 * text button, because the panel then had its own "Show as rows / Show as
 * chips" switch; that switch is gone as of 2026-09-29.) Words only, no icons —
 * the words are the affordance.
 */
export function QuotasViewSwitch({
  view,
  onChange,
}: {
  view: QuotasPageView
  onChange: (view: QuotasPageView) => void
}) {
  const options: { value: QuotasPageView; label: string; hint: string }[] = [
    { value: 'summary', label: 'Summary', hint: 'The Quotas panel from the Tasks page' },
    { value: 'details', label: 'Details', hint: 'Every quota with how often it has been met' },
  ]
  return (
    <div
      role="group"
      aria-label="Quotas view"
      data-quotas-view-switch
      className="bg-muted/50 inline-flex items-center gap-0.5 rounded-lg p-0.5"
    >
      {options.map((option) => {
        const active = view === option.value
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            title={option.hint}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
