'use client'

import { useState } from 'react'
import { Clock3, MoreHorizontal, SkipForward, XCircle } from 'lucide-react'
import { BarAction } from '@/components/SelectionBarShell'
import { SnoozeMenu } from '@/components/SnoozeMenu'
import { DeckMenu } from '@/components/OnDeckButton'
import { OnDeckIcon } from '@/components/icons/OnDeckIcon'
import { OptionMenu } from '@/components/OptionMenu'
import { SkipUntilDialog } from '@/components/SkipUntilDialog'
import { removableTargetIds } from '@/lib/row-corner'
import { canSkipUntil } from '@/lib/skip-until'
import { REMOVE_TARGET } from '@/lib/task-model-words'
import { taskWord } from '@/lib/utils'
import type { Task } from '@/types'

/**
 * THE VERBS THE LIST'S AND THE QUEUE'S SELECTION BARS SHARE (the U1 bar,
 * Trent, 2026-10-30): Target, Deck and More, each a `BarAction` that opens its
 * menu. One set, so the two bars can never offer them differently.
 */

/** On a wider screen a menu's trigger wrapper takes the verb's share of the row. */
const VERB_WRAPPER = 'flex min-w-0 flex-1'

/** Target: T1's menu, titled for the selection ("Target · 3 tasks"). */
export function TargetVerb({
  count,
  onTarget,
}: {
  count: number
  onTarget: (until: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <SnoozeMenu
      open={open}
      onOpenChange={setOpen}
      title={`Target · ${count} ${taskWord(count)}`}
      onSnooze={onTarget}
      triggerClassName={VERB_WRAPPER}
    >
      <BarAction icon={<Clock3 />} label="Target" onClick={() => setOpen(true)} data-bar-target />
    </SnoozeMenu>
  )
}

/**
 * Deck: the On deck menu for the selection. No one task's limit applies to the
 * days offered; the server refuses per task what a deadline forbids, and the
 * toast says so.
 */
const NO_LIMIT_TASK = {
  on_deck_day: null,
  deadline_at: null,
  due_at: null,
  target_auto: false,
  rrule: null,
} as const

export function DeckVerb({
  timezone,
  onDeck,
}: {
  timezone: string
  onDeck: (day: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <DeckMenu
      task={NO_LIMIT_TASK}
      timezone={timezone}
      limit={null}
      open={open}
      onOpenChange={setOpen}
      onPick={onDeck}
      triggerClassName={VERB_WRAPPER}
    >
      <BarAction icon={<OnDeckIcon />} label="Deck" onClick={() => setOpen(true)} data-bar-deck />
    </DeckMenu>
  )
}

const SKIP = 'skip-until'
const REMOVE = 'remove-target'

/**
 * More: Skip until… (the selection's repeating tasks) and Remove target (its
 * one-offs with a picked target), each offered when some selected task takes
 * it, with how many when not all do. Disabled when neither applies.
 */
export function MoreVerb({
  selectedTasks,
  timezone,
  onRemoveTargets,
  onSkipUntil,
}: {
  selectedTasks: Task[]
  timezone: string
  /** The selection's one-offs whose target the user picked: their targets go. */
  onRemoveTargets: (ids: number[]) => void
  onSkipUntil?: (ids: number[], until: string | null) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [skipOpen, setSkipOpen] = useState(false)
  const removable = removableTargetIds(selectedTasks)
  const repeating = onSkipUntil ? selectedTasks.filter(canSkipUntil) : []
  const of = (n: number) => (n < selectedTasks.length ? ` (${n})` : '')
  const options = [
    ...(repeating.length > 0
      ? [{ label: `Skip until…${of(repeating.length)}`, option: SKIP, icon: <SkipForward /> }]
      : []),
    ...(removable.length > 0
      ? [{ label: `${REMOVE_TARGET}${of(removable.length)}`, option: REMOVE, icon: <XCircle /> }]
      : []),
  ]
  return (
    <>
      <OptionMenu
        open={open}
        onOpenChange={setOpen}
        title="More"
        options={options}
        onSelect={(option) => {
          setOpen(false)
          if (option === SKIP) setSkipOpen(true)
          else if (option === REMOVE) onRemoveTargets(removable)
        }}
        triggerClassName={VERB_WRAPPER}
      >
        <BarAction
          icon={<MoreHorizontal />}
          label="More"
          onClick={() => setOpen(true)}
          disabled={options.length === 0}
          data-bar-more
        />
      </OptionMenu>
      {onSkipUntil && (
        <SkipUntilDialog
          open={skipOpen}
          onOpenChange={setSkipOpen}
          tasks={repeating}
          leftAlone={selectedTasks.length - repeating.length}
          timezone={timezone}
          onSkip={async (until) => {
            await onSkipUntil(
              selectedTasks.map((t) => t.id),
              until,
            )
            setSkipOpen(false)
          }}
        />
      )}
    </>
  )
}
