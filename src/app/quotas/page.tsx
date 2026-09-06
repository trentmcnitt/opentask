'use client'

import { useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Header } from '@/components/Header'
import { QuotasView } from '@/components/QuotasView'
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
 * Thin on purpose: `QuotasView` owns the data and the rendering. What the page
 * adds is the shared top bar (Quotas is a peer surface, not a settings page)
 * and the undo pipeline behind it.
 */

/** `useTaskActions` in list mode wants an array; only its undo half is used. */
const NO_TASKS: Task[] = []

export default function QuotasPage() {
  const { status } = useSession()
  const router = useRouter()
  const timezone = useTimezone()

  const actions = useTaskActions({
    mode: 'list',
    onRefresh: async () => {},
    tasks: NO_TASKS,
    setTasks: () => {},
  }) as ListTaskActionsReturn

  useUndoRedoShortcuts(actions.handleUndoRef, actions.handleRedoRef)

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push(loginUrlFromLocation())
    }
  }, [status, router])

  if (status === 'loading') {
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
        onUndo={actions.handleUndo}
        onRedo={actions.handleRedo}
        undoCount={actions.undoCount}
        redoCount={actions.redoCount}
        timezone={timezone}
      />
      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        <QuotasView />
      </main>
    </div>
  )
}
