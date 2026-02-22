import { useEffect, useRef } from 'react'
import type { Task } from '@/types'

interface BulkShortcutContext {
  isSelectionMode: boolean
  selectedCount: number
  openBulkSheet: () => void
}

/**
 * Hook to add Cmd+S / Ctrl+S shortcut for opening the quick action panel.
 * When multiple tasks are selected (bulk mode), opens the bulk modal instead.
 */
export function useQuickActionShortcut(
  focusedTask: Task | null,
  setOpen: (open: boolean) => void,
  isOpen: boolean,
  bulkContext?: BulkShortcutContext,
) {
  const focusedTaskRef = useRef(focusedTask)
  useEffect(() => {
    focusedTaskRef.current = focusedTask
  }, [focusedTask])

  const bulkContextRef = useRef(bulkContext)
  useEffect(() => {
    bulkContextRef.current = bulkContext
  }, [bulkContext])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        if (isOpen) {
          setOpen(false)
        } else if (
          bulkContextRef.current?.isSelectionMode &&
          bulkContextRef.current.selectedCount > 1
        ) {
          bulkContextRef.current.openBulkSheet()
        } else if (focusedTaskRef.current) {
          setOpen(true)
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, setOpen])
}
