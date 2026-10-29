'use client'

/**
 * The dashboard's MODE SWITCH (Trent, 2026-10-28): Today | Scan | All, in
 * the view toggle's own segmented look (`ViewModeToggle`). The words are
 * `MODE_LABELS`; the ids are stable (`ModeId`).
 */
import { MODE_LABELS, MODE_ORDER } from '@/lib/modes/registry'
import type { ModeId } from '@/lib/modes/types'
import { cn } from '@/lib/utils'

export function ModeSwitch({ mode, onMode }: { mode: ModeId; onMode: (mode: ModeId) => void }) {
  return (
    <div
      role="group"
      aria-label="Dashboard mode"
      data-mode-switch
      className="bg-muted/50 inline-flex items-center gap-0.5 rounded-lg p-0.5"
    >
      {MODE_ORDER.map((id) => {
        const active = mode === id
        return (
          <button
            key={id}
            type="button"
            data-mode={id}
            onClick={() => onMode(id)}
            aria-pressed={active}
            className={cn(
              'rounded-md px-3 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {MODE_LABELS[id]}
          </button>
        )
      })}
    </div>
  )
}
