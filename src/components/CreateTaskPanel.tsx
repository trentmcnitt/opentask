'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { QuickActionPanel, QuickActionPanelChanges } from '@/components/QuickActionPanel'
import { useTimezone } from '@/hooks/useTimezone'
import { useIsMobile } from '@/hooks/useIsMobile'
import { showErrorToast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import type { Project } from '@/types'

function isIOS(): boolean {
  if (typeof window === 'undefined') return false
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

interface CreateTaskPanelProps {
  open: boolean
  onClose: () => void
  onCreated: () => void
  projects: { id: number; name: string }[]
  initialTitle?: string
}

export function CreateTaskPanel({
  open,
  onClose,
  onCreated,
  projects,
  initialTitle,
}: CreateTaskPanelProps) {
  const timezone = useTimezone()
  const isMobile = useIsMobile()
  const [isPanelDirty, setIsPanelDirty] = useState(false)

  // --- iOS proxy input for keyboard focus during sheet animation ---
  //
  // iOS Safari only opens the virtual keyboard when .focus() is called within
  // the user gesture call stack. The sheet's slide-up animation uses a CSS
  // transform (translateY), so if Radix auto-focuses the textarea at the START
  // of the animation, Safari's scroll-into-view measures a mid-animation position,
  // leaving the input too low on screen.
  //
  // The proxy input trick: intercept Radix's auto-focus, focus a hidden proxy
  // input instead (preserving the gesture chain so the keyboard opens), then
  // transfer focus to the real textarea AFTER the animation completes. Safari
  // keeps the keyboard open during input-to-input focus transfers, and by the
  // time we focus the real input, its position is final.
  const proxyRef = useRef<HTMLInputElement | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isIOS()) return

    const proxy = document.createElement('input')
    proxy.type = 'text'
    proxy.setAttribute('aria-hidden', 'true')
    proxy.readOnly = true
    proxy.tabIndex = -1
    Object.assign(proxy.style, {
      position: 'fixed',
      opacity: '0',
      height: '0',
      width: '0',
      top: '50%',
      left: '0',
      fontSize: '16px',
      pointerEvents: 'none',
    })
    document.body.appendChild(proxy)
    proxyRef.current = proxy

    return () => {
      proxy.remove()
      proxyRef.current = null
    }
  }, [])

  const handleOpenAutoFocus = useCallback((e: Event) => {
    if (!isIOS()) return

    e.preventDefault()
    proxyRef.current?.focus()

    // Transfer focus to the real textarea after the 500ms sheet animation
    // plus a small buffer for the compositor to commit the final position
    setTimeout(() => {
      const textarea = panelRef.current?.querySelector('textarea')
      textarea?.focus()
    }, 600)
  }, [])

  const handleCreate = useCallback(
    async (fields: QuickActionPanelChanges & { title: string }) => {
      const body: Record<string, unknown> = { title: fields.title }
      if (fields.due_at) body.due_at = fields.due_at
      if (fields.priority && fields.priority > 0) body.priority = fields.priority
      if (fields.labels && fields.labels.length > 0) body.labels = fields.labels
      if (fields.rrule) {
        body.rrule = fields.rrule
        if (fields.recurrence_mode) body.recurrence_mode = fields.recurrence_mode
      }
      if (fields.project_id) body.project_id = fields.project_id
      if (fields.auto_snooze_minutes !== undefined && fields.auto_snooze_minutes !== null) {
        body.auto_snooze_minutes = fields.auto_snooze_minutes
      }

      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error('Failed to create task')
        onCreated()
      } catch {
        showErrorToast('Failed to create task')
      }
    },
    [onCreated],
  )

  const handleSave = useCallback(() => {
    // In create mode, Save is replaced by Create Task — this is the onSave callback
    // that QuickActionPanel calls after handleCreate completes
    onClose()
  }, [onClose])

  const handleCancel = useCallback(() => {
    onClose()
  }, [onClose])

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) onClose()
    },
    [onClose],
  )

  const panel = (
    <div
      ref={panelRef}
      className={cn(
        'rounded-lg border p-3',
        isPanelDirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
      )}
    >
      <QuickActionPanel
        task={null}
        timezone={timezone}
        mode={isMobile ? 'sheet' : 'popover'}
        createMode
        initialTitle={initialTitle}
        onCreate={handleCreate}
        projects={projects as Project[]}
        onSave={handleSave}
        onCancel={handleCancel}
        onDirtyChange={setIsPanelDirty}
      />
    </div>
  )

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent
          side="bottom"
          className="rounded-t-2xl"
          showCloseButton={false}
          onOpenAutoFocus={handleOpenAutoFocus}
        >
          <VisuallyHidden>
            <SheetTitle>New Task</SheetTitle>
            <SheetDescription>Create a new task</SheetDescription>
          </VisuallyHidden>
          <div className="px-4 pb-2">{panel}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[28rem] max-w-[calc(100%-2rem)] p-4" showCloseButton={false}>
        <VisuallyHidden>
          <DialogTitle>New Task</DialogTitle>
          <DialogDescription>Create a new task</DialogDescription>
        </VisuallyHidden>
        <div className="min-w-0">{panel}</div>
      </DialogContent>
    </Dialog>
  )
}
