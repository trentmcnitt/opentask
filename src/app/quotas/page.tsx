'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Header } from '@/components/Header'
import { QuotasSummary } from '@/components/QuotasSummary'
import { useUndoRedo } from '@/hooks/useUndoRedo'
import { useUndoRedoShortcuts } from '@/hooks/useUndoRedoShortcuts'
import { useTimezone } from '@/hooks/useTimezone'
import { useRequireSession } from '@/hooks/useRequireSession'
import { PageLoading } from '@/components/PageLoading'

/**
 * Quotas as a route (REDESIGN-V03 §5).
 *
 * Trent, 2026-09-06: "track needs to have its own item in the left-hand panel,
 * where we can easily work with these things… I can go to quotas and I can
 * easily remove items and the like."
 *
 * The Track panel on the dashboard is the daily instrument — glance, tap, move
 * on. This page is that panel with room around it: every quota, a way to make
 * one, and each one's history and editor behind a hold on its chip. The same
 * split Reminders has.
 *
 * Thin on purpose: `QuotasSummary` owns the data and the rendering. What the
 * page adds is the shared top bar (Quotas is a peer surface, not a settings
 * page), the undo pipeline behind it, and the search state.
 *
 * ONE VIEW since 2026-10-16. There used to be a Summary/Details switch (the
 * server preference `quotas_details`, 2026-09-25); Trent: "that Details view
 * is pointless… We're going to get rid of that special view." What the
 * Details list did, and where it lives now, is listed on `QuotasSummary`. The
 * `users.quotas_details` column and its preferences API field remain, unread
 * by the web app, so the preferences contract the native apps decode does not
 * change — the same as `track_expanded` (see `TrackPanel`).
 */

export default function QuotasPage() {
  const { ready } = useRequireSession()
  const timezone = useTimezone()

  // Searching narrows the quotas to matching ones — the view filters what it
  // already holds, so there is no request behind this. Mirrors the Reminders
  // page exactly.
  const [searchQuery, setSearchQuery] = useState('')
  const clearSearch = useCallback(() => setSearchQuery(''), [])
  const searchFocusRef = useRef<(() => void) | null>(null)

  // Cmd/Ctrl+K focuses search here as it does on Tasks and Reminders.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const inInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && !inInput) {
        e.preventDefault()
        searchFocusRef.current?.()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // The view populates this, so an undo/redo from the header or the keyboard
  // actually refreshes what is on screen — the same wiring the Reminders page
  // uses. Passing a no-op here left ⌘Z firing against a list that never moved.
  const refreshRef = useRef<(() => void) | null>(null)
  const refresh = useCallback(async () => {
    refreshRef.current?.()
  }, [])

  const actions = useUndoRedo({ onRefresh: refresh })

  useUndoRedoShortcuts(actions.handleUndoRef, actions.handleRedoRef)

  if (!ready) return <PageLoading />

  return (
    <div className="flex-1">
      <Header
        section="Quotas"
        // No badges: the default is the TASK counts, which read as "0 0" here
        // and mean nothing on this surface. Reminders passes its own; quotas
        // carry their numbers on the period headings instead.
        badges={<span />}
        onUndo={actions.handleUndo}
        onRedo={actions.handleRedo}
        undoCount={actions.undoCount}
        redoCount={actions.redoCount}
        onSearch={setSearchQuery}
        onSearchClear={clearSearch}
        searchFocusRef={searchFocusRef}
        searchSubject="quotas"
        timezone={timezone}
      />
      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        <QuotasSummary
          onUndo={actions.handleUndo}
          onCompleted={actions.bumpUndoCount}
          refreshRef={refreshRef}
          searchQuery={searchQuery}
        />
      </main>
    </div>
  )
}
