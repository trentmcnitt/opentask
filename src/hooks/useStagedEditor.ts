'use client'

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { EditorSave } from '@/hooks/useEditorHost'

/**
 * The editor half of the editor-host contract (`useEditorHost` is the host
 * half). Every detail editor that stages edits until Save — QuotaDetail,
 * ReminderDetail, QuickActionPanel — needs the same five things, and each used
 * to carry its own copy, which had drifted (only one had beforeunload, one
 * never reported clean on unmount, one had no in-flight guard):
 *
 * - **Dirty report.** `onDirtyChange(dirty)` whenever dirtiness changes, so
 *   the host can paint its stripe and guard dismissal and navigation.
 * - **Clean report on unmount.** A host closes (unmounts) the editor, or swaps
 *   it for another one ("Make this a task"); without this the host stays
 *   "dirty" for an editor that no longer exists — one frame of blue stripe and
 *   a disabled drag on the next open, or a navigation guard with nothing to
 *   guard. It runs on unmount only (the callback is read through a ref):
 *   firing it on every dirty change would also release a refresh the task
 *   page deferred while the user was still editing.
 * - **beforeunload** while dirty, for a reload or tab close with staged edits.
 * - **A stable `saveRef` registration**, so a host's unsaved-changes dialog
 *   can commit the staged edits. The registered function never changes
 *   identity; it always runs the latest `save`.
 * - **`{ saving, runSave }`.** `runSave` is the in-flight guard: a second tap
 *   while a save is pending does nothing (two taps on a slow connection used
 *   to make two quotas, or two PATCHes and two undo entries). `saving` drives
 *   the Save button's disabled state and label.
 *
 * `save` must not reject: hosts report their own failures (a toast with the
 * server's reason) and reject only so the editor keeps its staged edits, so
 * the editor's `save` catches that rejection and returns. A rejection escaping
 * to the host's unsaved-changes dialog left that dialog up forever.
 *
 * `save` may take one optional argument (ReminderDetail's "Make this a task"
 * saves with `{ is_reminder: false }`); the `saveRef` path calls it without.
 */
export function useStagedEditor<T = void>({
  dirty,
  onDirtyChange,
  saveRef,
  save,
}: {
  dirty: boolean
  onDirtyChange?: (dirty: boolean) => void
  saveRef?: MutableRefObject<EditorSave | null>
  save: (arg?: T) => Promise<void>
}) {
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange
  }, [onDirtyChange])
  useEffect(() => {
    return () => onDirtyChangeRef.current?.(false)
  }, [])

  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Modern browsers ignore custom messages but still show a generic prompt
      e.returnValue = 'You have unsaved changes. Are you sure you want to leave?'
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const saveFnRef = useRef(save)
  useEffect(() => {
    saveFnRef.current = save
  }, [save])

  // A ref, not the `saving` state, is the guard: a second tap can arrive
  // before the render that would disable the button.
  const savingRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const runSave = useCallback(async (arg?: T) => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      await saveFnRef.current(arg)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [])

  useEffect(() => {
    if (!saveRef) return
    saveRef.current = () => runSave()
    return () => {
      saveRef.current = null
    }
  }, [saveRef, runSave])

  return { saving, runSave }
}
