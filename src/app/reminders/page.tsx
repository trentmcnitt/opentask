'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { RemindersView } from '@/components/RemindersView'
import { useTaskActions, type ListTaskActionsReturn } from '@/hooks/useTaskActions'
import { useUndoRedoShortcuts } from '@/hooks/useUndoRedoShortcuts'
import { useSyncStream } from '@/hooks/useSyncStream'
import { loginUrlFromLocation } from '@/lib/login-redirect'
import type { Task } from '@/types'

/**
 * The Reminders surface (REDESIGN-V03 §6) as a route.
 *
 * §6 asks for "a separate screen/tab" and allows a chip that merely looks like one;
 * this is the real thing, with its own tab in both navs. That matters beyond
 * tidiness: reminders are now linkable and deep-linkable, which is what the iOS
 * widget and the slot notifications need (`opentask://reminders` → `/reminders`).
 *
 * The page is deliberately thin. `RemindersView` owns the rendering and
 * `useReminders` owns the data and the completion path, exactly as they did when
 * this surface lived inside the dashboard. What the page adds is the shell every
 * standalone page has (auth guard, sticky h1 header) plus the two things the
 * dashboard used to provide: an undo pipeline behind the "Considered" toast, and a
 * refresh chain so changes arriving from elsewhere land here too.
 */

/**
 * `useTaskActions` in list mode wants a task array; this page has none.
 *
 * Only its undo/redo half is used here — reminders own their own state and their
 * own completion path, so the list handlers (done, snooze, save) are never called
 * and have nothing to act on. A module-level constant keeps the hook's config
 * referentially stable rather than handing it a fresh array every render.
 */
const NO_TASKS: Task[] = []

export default function RemindersPage() {
  const { status } = useSession()
  const router = useRouter()

  // Registered by RemindersView while it is mounted.
  const refreshRef = useRef<(() => void) | null>(null)
  const refresh = useCallback(() => {
    refreshRef.current?.()
  }, [])

  const actions = useTaskActions({
    mode: 'list',
    onRefresh: refresh,
    tasks: NO_TASKS,
    setTasks: () => {},
  }) as ListTaskActionsReturn

  useUndoRedoShortcuts(actions.handleUndoRef, actions.handleRedoRef)

  // A reminder can be considered from a notification action, a widget, or another
  // device, so this surface joins the same SSE refresh chain the dashboard uses.
  useSyncStream({ onSync: refresh })

  useEffect(() => {
    if (status === 'loading') return
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
      <header className="safe-top bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
        <div className="mx-auto max-w-2xl px-4 py-3">
          <h1 className="text-xl font-semibold">Reminders</h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-6">
        <RemindersView
          onUndo={actions.handleUndo}
          onCompleted={actions.bumpUndoCount}
          refreshRef={refreshRef}
        />
      </main>
    </div>
  )
}
