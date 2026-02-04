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
}

function getShortcuts(cmdLabel: string) {
  return [
    { keys: ['Arrow Up', 'Arrow Down'], action: 'Move focus up/down' },
    { keys: ['Shift', 'Arrow'], action: 'Extend selection' },
    { keys: [cmdLabel, 'Arrow Up'], action: 'Jump to first task' },
    { keys: [cmdLabel, 'Arrow Down'], action: 'Jump to last task' },
    { keys: [cmdLabel, 'Shift', 'Arrow Up'], action: 'First in group (or prev group)' },
    { keys: [cmdLabel, 'Shift', 'Arrow Down'], action: 'Last in group (or next group)' },
    { keys: ['Space'], action: 'Toggle selection' },
    { keys: [cmdLabel, 'A'], action: 'Select/deselect all' },
    { keys: [cmdLabel, 'Shift', 'A'], action: 'Select/deselect all in group' },
    { keys: [cmdLabel, 'D'], action: 'Complete selected tasks' },
    { keys: ['Home'], action: 'Jump to first task' },
    { keys: ['End'], action: 'Jump to last task' },
    { keys: [cmdLabel, 'L'], action: 'Focus task list' },
    { keys: ['Esc'], action: 'Clear selection / exit keyboard mode' },
    { keys: ['?'], action: 'Show this help' },
  ]
}

export function KeyboardShortcutsDialog({ open, onOpenChange }: KeyboardShortcutsDialogProps) {
  const shortcuts = useMemo(() => {
    const isMac =
      typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0
    return getShortcuts(isMac ? 'Cmd' : 'Ctrl')
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
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
