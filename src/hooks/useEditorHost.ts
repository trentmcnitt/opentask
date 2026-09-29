'use client'

import { useCallback, useRef, useState } from 'react'

/** The editor's save, published through its `saveRef` prop. */
export type EditorSave = () => Promise<void> | void

/**
 * The plumbing every host of a detail editor (QuotaDetail, ReminderDetail,
 * TaskDetail's QuickActionPanel) needs: the editor reports dirtiness through
 * `onDirtyChange` and publishes its save through `saveRef`; the host paints a
 * dirty stripe, guards dismissal and navigation, and can commit the staged
 * edits from outside (an unsaved-changes dialog's Save).
 *
 * Dirtiness is held twice, on purpose:
 * - `dirtyRef` is written synchronously the moment the editor reports. Guards
 *   read it. Radix hands a dismissal (Escape, a click outside) to whichever
 *   `onOpenChange` it last captured, so a guard closing over state trails the
 *   editor's report by a render — an Escape right after a chip tap reached a
 *   guard that still believed the editor was clean, and the edit was dropped
 *   without asking (seen in the full E2E run). Mirroring the state into a ref
 *   in an effect would bring that back, one render later.
 * - `isDirty` is state, and only drives rendering (the stripe, the sheet's
 *   drag-to-dismiss).
 *
 * `onChange`, when given, runs after both are written — the task page uses it
 * to tell the app-level navigation guard and to flush a deferred refresh. Pass
 * a stable callback (useCallback): it is a dependency of `onDirtyChange`.
 */
export function useEditorHost(onChange?: (dirty: boolean) => void) {
  const [isDirty, setIsDirty] = useState(false)
  const dirtyRef = useRef(false)
  const saveRef = useRef<EditorSave | null>(null)

  const onDirtyChange = useCallback(
    (dirty: boolean) => {
      dirtyRef.current = dirty
      setIsDirty(dirty)
      onChange?.(dirty)
    },
    [onChange],
  )

  /** Commit whatever the editor has staged; a no-op before it has mounted. */
  const commit = useCallback(() => saveRef.current?.(), [])

  return { isDirty, dirtyRef, onDirtyChange, saveRef, commit }
}
