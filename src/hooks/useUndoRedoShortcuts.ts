'use client'

import { useEffect, type MutableRefObject } from 'react'

/**
 * Keyboard shortcuts for undo (Cmd+Z) and redo (Cmd+Shift+Z).
 *
 * Used by the dashboard, project page, and task detail page.
 *
 * Ignores keystrokes when focused on an input, textarea, or contentEditable
 * element so that the browser's native undo/redo still works in text fields.
 */
export function useUndoRedoShortcuts(
  handleUndoRef: MutableRefObject<(() => Promise<void>) | null>,
  handleRedoRef: MutableRefObject<(() => Promise<void>) | null>,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const cmdKey = e.metaKey || e.ctrlKey
      const isInInput =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)

      if (cmdKey && e.key.toLowerCase() === 'z' && !isInInput) {
        e.preventDefault()
        if (e.shiftKey) {
          handleRedoRef.current?.()
        } else {
          handleUndoRef.current?.()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleUndoRef, handleRedoRef])
}
