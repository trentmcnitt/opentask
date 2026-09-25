'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check } from 'lucide-react'
import { cn, fromRowControl } from '@/lib/utils'
import { trackState, trackStripeClass } from '@/lib/track'
import { movedPromptConfig, type QuotaPrompt } from '@/lib/quota-prompts'
import type { TimeSlot } from '@/lib/time-slot-assign'
import { useLongPress } from '@/hooks/useLongPress'
import { useQuotaMutations } from '@/hooks/useQuotaMutations'
import { useNavigationGuard } from '@/components/NavigationGuardProvider'
import { TrackChipPopover } from '@/components/TrackChipPopover'
import { QuotaDetailModal } from '@/components/QuotaDetailModal'
import { ordinal, usePromptSetup } from '@/components/QuotaPromptField'
import { log } from '@/lib/logger'
import type { Task } from '@/types'

/**
 * A quota PROMPT on a reminder surface (quota reminders, 2026-09-24).
 *
 * An unmet quota also shows up in a reminder period each day, so it gets the
 * attention a reminder gets. It is drawn AS a reminder row — the sibling is
 * `ReminderRow` in RemindersView.tsx (and `PanelRow` in the dashboard panel),
 * and everything not listed here is copied from it: the circle, the whole-row
 * tap, the struck-through collapse, the 16px (panel: 13.5px) wrapping title,
 * never truncated.
 *
 * WHAT DIFFERS, AND WHY
 * - TWO ACTIONS. Ticking a reminder means "considered", not "did it" (Trent's
 *   final decision). So the circle and a tap on the row CONSIDER it — handled
 *   for today, nothing logged — and a SQUARE checkbox on the right, beside the
 *   count, is "did it": progress, and considered too. Square because it is a
 *   different verb from the circle, and a checkbox is what "I did this" looks
 *   like everywhere else.
 * - A thin left stripe in the quota's label colour — the same stripe a quota
 *   chip wears (`trackStripeClass`: green is never spent, since green means
 *   "met"). The colour is resolved by the server (`stripe_color`).
 * - The label carries progress, "Daily Walks · 1/2" — never "#1".
 * - NOT SELECTABLE. A prompt is not a task: Trash would delete the quota and
 *   Details would open a reminder editor on it. A hold (or Cmd/Ctrl+Enter)
 *   opens the quota's own bubble — `TrackChipPopover`, the quota long-press
 *   everywhere else — whose Open reaches `QuotaDetailModal`. While a
 *   selection is active a plain tap does nothing here, since a tap there
 *   means "select" and this row cannot be.
 * - The bubble also carries the user's periods as chips (2026-09-25): one tap
 *   moves the prompt there for good — the editor's own PATCH, with Undo. The
 *   hold is the way in on desktop too; right-click stays unbound here, since
 *   on a quota chip it means −1 and Trent keeps that meaning.
 * - NO PUT-BACK. A handled prompt counts toward the slot but never joins its
 *   considered list, whose put-back is /undone (which a quota refuses). The
 *   toast's Undo is the way back.
 */

export interface QuotaPromptRowProps {
  prompt: QuotaPrompt
  /** 'surface' is the /reminders row; 'panel' the dashboard card's compact one. */
  variant?: 'surface' | 'panel'
  /** Mid-collapse after an action: struck through and inert. */
  completing?: boolean
  /** A reminder selection is active — a plain tap does nothing (see above). */
  isSelectionMode?: boolean
  /** Past the dashboard panel's narrow cap: in the DOM, shown from `xl` up. */
  hiddenWhenNarrow?: boolean
  onConsider: (prompt: QuotaPrompt) => void
  onDid: (prompt: QuotaPrompt) => void
  /** Hold / Cmd+Enter: open the quota's bubble. */
  onPeek: (prompt: QuotaPrompt) => void
  /** The collapse ended (or the row unmounted mid-collapse). */
  onLeft?: (key: string) => void
  /** Report being on screen; returns its deregistration (`useReminders`). */
  onRegister?: (key: string) => () => void
  /**
   * Render the quota's bubble, anchored to the element handed in (an inert
   * box over the row). Wrapping the row component from outside gave the
   * anchor nothing to measure, and the bubble opened off screen.
   */
  bubble?: (row: React.ReactElement) => React.ReactNode
}

/** "3/5" — the prompt's own count, as the label shows it. */
function countText(prompt: QuotaPrompt): string {
  return `${prompt.current}/${prompt.target}`
}

export function QuotaPromptRow({
  prompt,
  variant = 'surface',
  completing = false,
  isSelectionMode = false,
  hiddenWhenNarrow = false,
  onConsider,
  onDid,
  onPeek,
  onLeft,
  onRegister,
  bubble,
}: QuotaPromptRowProps) {
  const panel = variant === 'panel'
  const key = prompt.prompt_key
  const press = useLongPress({ onLongPress: () => onPeek(prompt) })

  // Same two effects as `ReminderRow`: a row that unmounts mid-collapse still
  // reports leaving (or it would hold the surface's refresh shut), and only a
  // row that is on screen may hold its place while it collapses.
  useEffect(() => {
    if (!completing || !onLeft) return
    return () => onLeft(key)
  }, [completing, onLeft, key])
  useEffect(() => onRegister?.(key), [onRegister, key])

  const onClick = (e: React.MouseEvent) => {
    if (press.didFire()) {
      e.preventDefault()
      return
    }
    if (fromRowControl(e) || completing || isSelectionMode) return
    // A held modifier is the mouse's way into a selection on this surface, and
    // a prompt has none — so it does nothing rather than consider by surprise.
    if (e.shiftKey || e.metaKey || e.ctrlKey) return
    onConsider(prompt)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget || completing) return
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onPeek(prompt)
      return
    }
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    if (!isSelectionMode) onConsider(prompt)
  }

  const row = (
    <li
      data-prompt-key={key}
      data-prompt-task={prompt.task_id}
      data-reminder-leaving={completing ? '' : undefined}
      ref={completing ? measureLeavingRow : undefined}
      tabIndex={completing ? -1 : 0}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onPointerDown={press.onPointerDown}
      onPointerUp={press.onPointerUp}
      onPointerMove={press.onPointerMove}
      onPointerLeave={press.onPointerLeave}
      onPointerCancel={press.onPointerUp}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && e.animationName === 'reminder-leaving') onLeft?.(key)
      }}
      className={cn(
        'group relative cursor-pointer items-start rounded-xl border border-transparent select-none',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        panel
          ? 'hover:bg-foreground/5 gap-2.5 px-1 py-1.5 transition-colors'
          : 'hover:bg-foreground/[0.04] gap-3 px-2 py-2.5',
        hiddenWhenNarrow ? 'hidden xl:flex' : 'flex',
        completing && 'animate-reminder-leaving pointer-events-none',
      )}
    >
      {/* The label-colour stripe, the quota chip's own (3px, green never).
          In the row's gutter (the panel's in the list's), so the circle lines
          up with the reminder rows' circles. */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute w-[3px] rounded-full',
          panel ? 'inset-y-1.5 -left-1' : 'inset-y-2.5 left-0.5',
          trackStripeClass(prompt.stripe_color),
        )}
      />
      {/* The bubble's anchor: an inert box over the whole row. The wrapper
          stops the bubble's own events (it renders in a portal, but React
          still bubbles them through here) from reaching the row, where a
          click would consider the prompt and a press would start a hold. */}
      {bubble && (
        <span
          // No box of its own: a flex item here would add a gap to the row.
          className="contents"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {bubble(<span aria-hidden="true" className="pointer-events-none absolute inset-0" />)}
        </span>
      )}
      <PromptCircle prompt={prompt} panel={panel} completing={completing} onConsider={onConsider} />
      <p
        className={cn(
          'min-w-0 flex-1 text-pretty',
          panel ? 'text-[13.5px] leading-[1.42]' : 'text-[16px] leading-6',
          completing && 'text-muted-foreground line-through',
        )}
      >
        {prompt.title}
        <span className="text-muted-foreground ml-1.5 text-[0.85em] whitespace-nowrap tabular-nums">
          &middot; {countText(prompt)}
        </span>
      </p>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          if (!completing) onDid(prompt)
        }}
        onPointerDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        aria-label={`Did "${prompt.title}" (${countText(prompt)})`}
        title="Did it — log one"
        data-prompt-did
        className={cn(
          'group/did border-foreground/25 hover:border-foreground/60 hover:bg-foreground/5 flex shrink-0 items-center justify-center rounded-[5px] border-[1.5px] transition-colors',
          panel ? 'size-[19px]' : 'mt-[3px] size-6',
        )}
      >
        <Check
          className={cn(
            'group-hover/did:text-foreground/50 text-transparent transition-colors',
            panel ? 'size-3' : 'size-3.5',
          )}
          strokeWidth={3}
        />
      </button>
    </li>
  )
  return row
}

/** The circle — "considered" — exactly the reminder row's. */
function PromptCircle({
  prompt,
  panel,
  completing,
  onConsider,
}: {
  prompt: QuotaPrompt
  panel: boolean
  completing: boolean
  onConsider: (prompt: QuotaPrompt) => void
}) {
  const size = panel ? 'size-[19px]' : 'mt-[3px] size-6'
  if (completing) {
    return (
      <span
        aria-hidden
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full bg-green-600 text-white',
          size,
        )}
      >
        <Check className={panel ? 'size-3' : 'size-3.5'} strokeWidth={3} />
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onConsider(prompt)
      }}
      onPointerDown={(e) => e.stopPropagation()}
      tabIndex={-1}
      aria-label={`Mark "${prompt.title}" as considered`}
      title="Considered"
      data-prompt-consider
      className={cn(
        'border-foreground/20 hover:border-foreground/60 hover:bg-foreground/5 flex shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors',
        size,
      )}
    >
      {!panel && (
        <Check
          className="group-hover:text-foreground/40 size-3.5 text-transparent transition-colors"
          strokeWidth={3}
        />
      )}
    </button>
  )
}

/** The leaving animation's starting height — see `measureLeavingRow` in RemindersView. */
const measureLeavingRow = (el: HTMLElement | null) => {
  if (el) el.style.setProperty('--reminder-row-h', `${el.offsetHeight}px`)
}

/** `useReminders().movePrompt`'s shape. */
type MovePrompt = (
  prompt: QuotaPrompt,
  toSlotId: number,
  save: () => Promise<void>,
) => Promise<void>

/**
 * What the period chips place. A daily row that stands for only some of the
 * quota's numbers says which — a tap moves those, not the whole quota.
 */
function periodsLabel(prompt: QuotaPrompt): string {
  const numbers = prompt.numbers ?? []
  if (numbers.length === 0 || numbers.length >= prompt.target) return 'Reminds me in'
  const names = numbers.map(ordinal)
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `The ${list} of ${prompt.target} ${names.length === 1 ? 'reminds' : 'remind'} me in`
}

/** `useQuotaMutations`' `clear` — there is no quota selection here to clear. */
const noop = () => {}

/**
 * Everything a reminder surface needs to draw its prompts: a `renderPrompt`
 * for each waiting prompt (the row, in its bubble) and the editor modal to
 * mount once. Both the /reminders surface and the dashboard's Reminders card
 * use it, so a prompt behaves the same in the two places.
 */
export function usePromptRows({
  variant = 'surface',
  completingIds,
  isSelectionMode = false,
  considerPrompt,
  didPrompt,
  movePrompt,
  rowLeft,
  registerRow,
  onUndo,
  onCompleted,
  refresh,
}: {
  variant?: 'surface' | 'panel'
  completingIds?: Set<number | string>
  isSelectionMode?: boolean
  considerPrompt: (prompt: QuotaPrompt) => void
  didPrompt: (prompt: QuotaPrompt) => void
  /** `useReminders().movePrompt` — the period chips' optimistic move. */
  movePrompt: MovePrompt
  rowLeft?: (id: string) => void
  registerRow?: (id: string) => () => void
  onUndo: () => void
  onCompleted?: () => void
  refresh: () => Promise<void>
}) {
  const detail = useQuotaPromptDetail({
    onUndo,
    onCompleted: onCompleted ?? noop,
    onRefresh: refresh,
    movePrompt,
  })
  const renderPrompt = (prompt: QuotaPrompt, extra: { hiddenWhenNarrow?: boolean } = {}) => (
    <QuotaPromptRow
      key={prompt.prompt_key}
      bubble={(row) => detail.wrap(prompt, row)}
      prompt={prompt}
      variant={variant}
      completing={completingIds?.has(prompt.prompt_key) ?? false}
      isSelectionMode={isSelectionMode}
      hiddenWhenNarrow={extra.hiddenWhenNarrow}
      onConsider={considerPrompt}
      onDid={didPrompt}
      onPeek={detail.peek}
      onLeft={rowLeft}
      onRegister={registerRow}
    />
  )
  return { renderPrompt, modal: detail.modal }
}

/**
 * A prompt's bubble and editor: which prompt's `TrackChipPopover` is open, the
 * quota it is about (fetched on the hold — a reminder surface does not hold
 * quota rows), and the `QuotaDetailModal` its Open reaches. The same wiring
 * `TrackPanel`'s chips use (`useTrackChipDetail`), with the same mutations
 * (`useQuotaMutations`), so a quota edits the same way from here as from its
 * own surfaces.
 */
export function useQuotaPromptDetail({
  onUndo,
  onCompleted,
  onRefresh,
  movePrompt,
}: {
  onUndo: () => void
  onCompleted: () => void
  onRefresh: () => Promise<void>
  movePrompt: MovePrompt
}) {
  const router = useRouter()
  const { requestNavigation } = useNavigationGuard()
  const [peekKey, setPeekKey] = useState<string | null>(null)
  const [task, setTask] = useState<Task | null>(null)
  const [editing, setEditing] = useState<Task[]>([])
  const { saveQuotas, createQuota, deleteQuotas } = useQuotaMutations({
    refresh: onRefresh,
    clear: noop,
    onUndo,
    onCompleted,
  })

  // Fetched fresh on every hold (never a copy from before an edit), and only
  // the latest hold's answer is kept — a slow response for an earlier hold
  // must not replace the one on screen.
  const latestPeek = useRef<string | null>(null)
  const peek = useCallback(async (prompt: QuotaPrompt) => {
    latestPeek.current = prompt.prompt_key
    setTask(null)
    setPeekKey(prompt.prompt_key)
    try {
      const res = await fetch(`/api/tasks/${prompt.task_id}`)
      if (!res.ok) throw new Error(`task ${res.status}`)
      const data = (await res.json()).data as Task
      if (latestPeek.current === prompt.prompt_key) setTask(data)
    } catch (err) {
      log.error('ui', 'Loading a quota for its prompt failed:', err)
      if (latestPeek.current === prompt.prompt_key) setPeekKey(null)
    }
  }, [])
  const closePeek = useCallback(() => setPeekKey(null), [])
  const { slots } = usePromptSetup()

  /**
   * A period chip: move the prompt there for good. The editor's exact write —
   * `saveQuotas`, a PATCH of the quota's whole `quota_prompt_config`, merged
   * over the one the hold just fetched (`movedPromptConfig`) — so it is
   * validated, undo-logged and toasted the way the editor's save is. The
   * bubble closes first: its row is about to re-render in another period.
   */
  const moveTo = (prompt: QuotaPrompt, quota: Task, slot: TimeSlot) => {
    setPeekKey(null)
    const config = movedPromptConfig(quota.quota_prompt_config, prompt, slot.id)
    void movePrompt(prompt, slot.id, () =>
      saveQuotas(
        [quota.id],
        { quota_prompt_config: config },
        { message: `Moved “${prompt.title}” to ${slot.label}` },
      ),
    )
  }

  /** Wrap a prompt row in its bubble. */
  const wrap = (prompt: QuotaPrompt, row: React.ReactNode) => {
    const mine = task && task.id === prompt.task_id ? task : null
    return (
      <TrackChipPopover
        key={prompt.prompt_key}
        task={mine}
        state={trackState(
          { progress_target: prompt.target, progress_current: prompt.current },
          prompt.current,
        )}
        open={peekKey === prompt.prompt_key}
        onOpenChange={(open) => !open && closePeek()}
        onOpen={(t) => {
          setPeekKey(null)
          setEditing([t])
        }}
        onDelete={(t) => {
          setPeekKey(null)
          void deleteQuotas([t])
        }}
        periods={
          mine
            ? {
                slots,
                currentId: prompt.slot_id,
                label: periodsLabel(prompt),
                onPick: (slot) => moveTo(prompt, mine, slot),
              }
            : undefined
        }
      >
        {row}
      </TrackChipPopover>
    )
  }

  const modal = (
    <QuotaDetailModal
      tasks={editing}
      open={editing.length > 0}
      onClose={() => setEditing([])}
      onSave={saveQuotas}
      onCreate={createQuota}
      onDelete={(targets) => void deleteQuotas(targets)}
      onOpenPage={(id) => {
        if (requestNavigation(`/tasks/${id}`)) router.push(`/tasks/${id}`)
      }}
    />
  )

  return { peek, wrap, modal }
}
