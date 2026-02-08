'use client'

import { useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface KeyboardShortcutsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus?: (e: Event) => void
}

function getShortcuts(cmdSymbol: string) {
  return [
    { keys: ['↑', '↓'], action: 'Move focus up/down' },
    { keys: ['⇧', 'Arrow'], action: 'Extend selection' },
    { keys: [cmdSymbol, '↑'], action: 'Jump to first task' },
    { keys: [cmdSymbol, '↓'], action: 'Jump to last task' },
    { keys: [cmdSymbol, '⇧', '↑'], action: 'First in group (or prev group)' },
    { keys: [cmdSymbol, '⇧', '↓'], action: 'Last in group (or next group)' },
    { keys: ['Space'], action: 'Toggle selection' },
    { keys: [cmdSymbol, 'A'], action: 'Select/deselect all' },
    { keys: [cmdSymbol, '⇧', 'A'], action: 'Select/deselect all in group' },
    { keys: [cmdSymbol, 'C'], action: 'Copy selected tasks' },
    { keys: [cmdSymbol, 'D'], action: 'Complete selected tasks' },
    { keys: [cmdSymbol, 'Z'], action: 'Undo' },
    { keys: [cmdSymbol, '⇧', 'Z'], action: 'Redo' },
    { keys: ['Home'], action: 'Jump to first task' },
    { keys: ['End'], action: 'Jump to last task' },
    { keys: [cmdSymbol, 'L'], action: 'Focus task list' },
    { keys: ['Esc'], action: 'Clear selection / exit keyboard mode' },
    { keys: ['?'], action: 'Show this help' },
  ]
}

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
}: KeyboardShortcutsDialogProps) {
  const shortcuts = useMemo(() => {
    const isMac =
      typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0
    return getShortcuts(isMac ? '⌘' : 'Ctrl')
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription className="sr-only">
            Available keyboard shortcuts for navigating and managing tasks
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 text-sm">
          {shortcuts.map(({ keys, action }, i) => (
            <div key={i} className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{action}</span>
              <div className="flex shrink-0 gap-1">
                {keys.map((k, j) => (
                  <kbd
                    key={j}
                    className="bg-muted text-muted-foreground rounded border px-1.5 py-0.5 font-mono text-xs"
                  >
                    {k}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
