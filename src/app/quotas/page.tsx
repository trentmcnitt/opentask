'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Header } from '@/components/Header'
import { QuotasView } from '@/components/QuotasView'
import { QuotasSummary, QuotasViewSwitch, type QuotasPageView } from '@/components/QuotasSummary'
import { useQuotasPagePreference } from '@/components/PreferencesProvider'
import { useTaskActions, type ListTaskActionsReturn } from '@/hooks/useTaskActions'
import { useUndoRedoShortcuts } from '@/hooks/useUndoRedoShortcuts'
import { useTimezone } from '@/hooks/useTimezone'
import { loginUrlFromLocation } from '@/lib/login-redirect'
import type { Task } from '@/types'

/**
 * Quotas as a route (REDESIGN-V03 §5).
 *
 * Trent, 2026-09-06: "track needs to have its own item in the left-hand panel,
 * where we can easily work with these things… I can go to quotas and I can
 * easily remove items and the like."
 *
 * The Track panel on the dashboard is the daily instrument — glance, tap, move
 * on. This page is the workshop: every quota with its real history, a way to
 * make one, and a route into each one's editor. The same split Reminders has.
 *
 * Thin on purpose: the views own the data and the rendering. What the page
 * adds is the shared top bar (Quotas is a peer surface, not a settings page),
 * the undo pipeline behind it, and which of its two views is showing.
 *
 * TWO VIEWS (Trent, 2026-09-25: "the default view when I go to the quotas
 * screen to be the dashboard version of quotas, with an option to expand it to
 * the view that you have here, where it shows how many have been met"):
 *
 * - SUMMARY, the default — `QuotasSummary`, the dashboard's Quotas panel.
 * - DETAILS — `QuotasView`, the list with "met 2×", selection and the
 *   multi-quota editor, unchanged.
 *
 * The choice is the server preference `quotas_details`, like the panel's own
 * `track_expanded`: it follows the user between the phone and the desk, and it
 * goes through the provider's dirty-field merge and ordered saver, so a press
 * that lands before the preferences load is not snapped back by it.
 *
 * `?quota=<id>` (the Quotas widget's deep link) OPENS DETAILS for that visit,
 * without saving it. The details list is where a single quota can be brought
 * into view and flashed (`QuotasView`'s deep-link effect); the summary cannot
 * promise that — a quota met at load is put away there, and its label cluster
 * may be folded shut — so scrolling to a chip would sometimes scroll to
 * nothing. Not saved, because following a link is not choosing a view: the
 * next plain visit opens wherever the user left it.
 */

/** `useTaskActions` in list mode wants an array; only its undo half is used. */
const NO_TASKS: Task[] = []

export default function QuotasPage() {
  const { status } = useSession()
  const router = useRouter()
  const timezone = useTimezone()

  // The view populates this, so an undo/redo from the header or the keyboard
  // actually refreshes what is on screen — the same wiring the Reminders page
  // uses. Passing a no-op here left ⌘Z firing against a list that never moved.
  const refreshRef = useRef<(() => void) | null>(null)
  const refresh = useCallback(async () => {
    refreshRef.current?.()
  }, [])

  const actions = useTaskActions({
    mode: 'list',
    onRefresh: refresh,
    tasks: NO_TASKS,
    setTasks: () => {},
  }) as ListTaskActionsReturn

  useUndoRedoShortcuts(actions.handleUndoRef, actions.handleRedoRef)

  const { quotasDetails, setQuotasDetails, loaded } = useQuotasPagePreference()
  // Read once, on the first client render — see the block comment above.
  // Lazily rather than in an effect, so the first paint is already the right
  // view; the server renders the loading state either way (the session is
  // still loading there), so nothing hydrates against a different tree.
  const [deepLinked, setDeepLinked] = useState(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('quota'),
  )
  const view: QuotasPageView = deepLinked || quotasDetails ? 'details' : 'summary'
  const onViewChange = (next: QuotasPageView) => {
    setDeepLinked(false)
    setQuotasDetails(next === 'details')
  }

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push(loginUrlFromLocation())
    }
  }, [status, router])

  // Wait for the preferences as well as the session: until they land,
  // `quotasDetails` is the default, and a user who chose Details would watch
  // the summary paint and then swap out from under him.
  if (status === 'loading' || (status === 'authenticated' && !loaded)) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-muted-foreground animate-pulse">Loading...</div>
      </div>
    )
  }

  if (status === 'unauthenticated') return null

  return (
    <div className="flex-1">
      <Header
        section="Quotas"
        // No badges: the default is the TASK counts, which read as "0 0" here
        // and mean nothing on this surface. Reminders passes its own; quotas
        // carry their numbers on the period card instead.
        badges={<span />}
        onUndo={actions.handleUndo}
        onRedo={actions.handleRedo}
        undoCount={actions.undoCount}
        redoCount={actions.redoCount}
        timezone={timezone}
      />
      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        {view === 'details' ? (
          <QuotasView
            onUndo={actions.handleUndo}
            onCompleted={actions.bumpUndoCount}
            refreshRef={refreshRef}
            viewSwitch={<QuotasViewSwitch view={view} onChange={onViewChange} />}
          />
        ) : (
          <QuotasSummary
            onUndo={actions.handleUndo}
            onCompleted={actions.bumpUndoCount}
            refreshRef={refreshRef}
            viewSwitch={<QuotasViewSwitch view={view} onChange={onViewChange} />}
          />
        )}
      </main>
    </div>
  )
}
