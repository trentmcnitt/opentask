'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { QuotaDetailModal } from '@/components/QuotaDetailModal'
import type { QuotaCreateDraft } from '@/components/QuotaDetail'
import { useNavigationGuard } from '@/components/NavigationGuardProvider'
import { useQuotaMutations } from '@/hooks/useQuotaMutations'
import type { Task } from '@/types'

/** The default `clear`: most quota surfaces have no selection to clear. */
const noop = () => {}

/**
 * The quota editor, wired: `QuotaDetailModal` plus the state that opens it and
 * the writes it makes (`useQuotaMutations`). Every surface that edits a quota
 * mounts this one hook — `QuotasView` (the detailed list), `QuotasSummary`
 * (/quotas' panel view, for "New quota"), `TrackPanel`'s chips and the quota
 * prompts on the reminder surfaces (`useQuotaPromptDetail`) — so a quota saves,
 * creates, deletes and leaves for its full page the same way from each.
 *
 * - `openEdit(tasks)` edits a SNAPSHOT of those quotas (several at once is the
 *   modal's multi-edit): the surfaces refresh on their own, and a task
 *   identity changing under the editor would reset its staged edits.
 * - `openCreate()` starts a blank draft. Idempotent: a double-tap on the
 *   phone's plus dispatches `open-add-quota` twice, and a second draft would
 *   throw away what was already typed.
 * - "Open full page" goes through the navigation guard, like every other route
 *   change in the app, so an unsaved editor still gets to ask first.
 *
 * What stays with each caller is what differs between them: the popovers, the
 * selection, and each one's period-move closure (a Track chip moves a quota's
 * whole reminder; a prompt row moves one prompt, optimistically). Those call
 * `saveQuotas` from here so the write itself is the editor's.
 */
export function useQuotaEditor({
  refresh,
  onUndo,
  onCompleted,
  clear = noop,
}: {
  refresh: () => Promise<void>
  onUndo: () => void
  onCompleted: () => void
  /** Clear the surface's selection after a save or delete (`QuotasView`). */
  clear?: () => void
}) {
  const router = useRouter()
  const { requestNavigation } = useNavigationGuard()
  const [editing, setEditing] = useState<Task[]>([])
  const [creating, setCreating] = useState<QuotaCreateDraft | null>(null)
  const { saveQuotas, createQuota, deleteQuotas } = useQuotaMutations({
    refresh,
    clear,
    onUndo,
    onCompleted,
  })

  const openEdit = useCallback((tasks: Task[]) => setEditing(tasks), [])
  const openCreate = useCallback(() => setCreating((current) => current ?? { title: '' }), [])
  const close = useCallback(() => {
    setEditing([])
    setCreating(null)
  }, [])

  const modal = (
    <QuotaDetailModal
      tasks={editing}
      create={creating}
      open={editing.length > 0 || creating !== null}
      onClose={close}
      onSave={saveQuotas}
      onCreate={createQuota}
      onDelete={(targets) => void deleteQuotas(targets)}
      onOpenPage={(id) => {
        if (requestNavigation(`/tasks/${id}`)) router.push(`/tasks/${id}`)
      }}
    />
  )

  return { saveQuotas, createQuota, deleteQuotas, openEdit, openCreate, close, modal }
}
