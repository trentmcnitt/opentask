'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useTaskQueue } from '@/components/PreferencesProvider'
import { RolloverNowRow } from './RolloverNowRow'

/**
 * Settings → Advanced (Trent, 2026-10-24: "Roll over now… seems
 * dangerous"): a fold at the bottom of the page, closed every time Settings
 * opens (deliberately not remembered), holding the actions that move many
 * tasks at once. Today that is Roll over now alone, which keeps its own
 * dry-run and confirm (src/components/settings/RolloverNowRow.tsx).
 *
 * Roll over now exists only with the task queue on, so the whole section is
 * hidden with it off (and while preferences load) — a fold with nothing in it
 * would be empty chrome.
 *
 * The heading itself is the toggle: the card's h2 holds a button with
 * `aria-expanded`, so the page's heading outline still names the section.
 */
export function AdvancedSection() {
  const { loaded, enabled } = useTaskQueue()
  const [open, setOpen] = useState(false)
  if (!loaded || !enabled) return null
  return (
    <section
      className="rounded-lg border border-zinc-200 px-4 py-2 dark:border-zinc-800"
      data-settings-advanced
    >
      <h2 className="text-sm font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="settings-advanced-body"
          className="flex min-h-11 w-full items-center gap-2 text-left uppercase transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
        >
          <span className="flex-1">Advanced</span>
          {open ? (
            <ChevronDown className="size-4 shrink-0" />
          ) : (
            <ChevronRight className="size-4 shrink-0" />
          )}
        </button>
      </h2>
      {open && (
        <div id="settings-advanced-body" className="pt-1 pb-2">
          <RolloverNowRow />
        </div>
      )}
    </section>
  )
}
