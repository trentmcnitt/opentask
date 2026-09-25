'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Eye } from 'lucide-react'
import { cn, fromRowControl } from '@/lib/utils'
import { freqLabel, trackState, trackStripeClass } from '@/lib/track'
import { movedPromptConfig, ordinal, type QuotaPrompt } from '@/lib/quota-prompts'
import type { TimeSlot } from '@/lib/time-slot-assign'
import { useLongPress } from '@/hooks/useLongPress'
import { useQuotaMutations } from '@/hooks/useQuotaMutations'
import { useNavigationGuard } from '@/components/NavigationGuardProvider'
import { TrackChipPopover } from '@/components/TrackChipPopover'
import { NotesMarker } from '@/components/NotesMarker'
import { Checkbox } from '@/components/ui/checkbox'
import { QuotaDetailModal } from '@/components/QuotaDetailModal'
import { usePromptSetup } from '@/components/QuotaPromptField'
import { log } from '@/lib/logger'
import { showToast } from '@/lib/toast'
import type { Task } from '@/types'

/**
 * A quota PROMPT on a reminder surface (quota reminders, 2026-09-24).
 *
 * An unmet quota also shows up in a reminder period each day, so it gets the
 * attention a reminder gets. It is drawn AS a reminder row — the sibling is
 * `ReminderRow` in RemindersView.tsx (and `PanelRow` in the dashboard panel),
 * and everything not listed here is copied from it: the whole-row tap, the
 * struck-through collapse, the 16px (panel: 13.5px) wrapping title, never
 * truncated.
 *
 * WHAT DIFFERS, AND WHY
 * - TWO ACTIONS. Ticking a reminder means "considered", not "did it" (Trent's
 *   final decision). So the EYE and a tap on the row CONSIDER it — handled
 *   for today, nothing logged — and a SQUARE checkbox on the right, beside the
 *   count, is "did it": progress, and considered too. Square because it is a
 *   different verb, and a checkbox is what "I did this" looks like everywhere
 *   else.
 * - AN EYE WHERE A REMINDER HAS ITS CIRCLE (2026-09-25). Same place, size and
 *   tap target, same verb. Trent habitually tapped the left circle meaning
 *   "done", but on a prompt it means "seen" — the eye says so. Outline and
 *   muted while waiting; filled green (the circle's considered look) as the
 *   row collapses.
 * - A thin left stripe in the quota's label colour — the same stripe a quota
 *   chip wears (`trackStripeClass`: green is never spent, since green means
 *   "met"). The colour is resolved by the server (`stripe_color`).
 * - The label carries progress and the period it covers, "Daily Walks · 1/2
 *   today" — never "#1". Trent, 2026-09-25: "Clean bedroom fans · 0/1" did not
 *   say whether that was today's one or this month's. The words are the Quotas
 *   panel's own section headings (`freqLabel`), so the two never disagree; a
 *   period-less quota shows the count alone.
 * - SELECTABLE BESIDE REMINDERS, keyed by `prompt_key` (2026-09-25; before
 *   that, not selectable at all). A daily quota can wait in several periods
 *   at once, one row per number, so the task id would not say WHICH row. The
 *   click gestures are the reminder row's: in selection mode a tap toggles,
 *   Cmd/Ctrl-click toggles, Shift-click extends the range across reminders and
 *   prompts alike, and the circle turns into the same checkbox. The selection
 *   bar keeps a quota safe: Considered covers prompts (as considered, never
 *   +1), Details opens the QUOTA editor only when every selected row is a
 *   prompt, and Trash is not offered while any prompt is selected — a prompt
 *   row must never be the way a quota gets deleted.
 * - THE HOLD IS NOT "SELECT". On a reminder row a hold turns selection on; on
 *   a prompt it opens the quota's own bubble — `TrackChipPopover`, the quota
 *   long-press everywhere else — whose Open reaches `QuotaDetailModal`, and
 *   whose period chips are the only way to move one prompt. Cmd/Ctrl+Enter
 *   opens it from the keyboard. So on a phone a selection starts on a
 *   reminder, and prompts join it with a tap.
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
  /** A selection is active — a tap toggles this row's place in it (see above). */
  isSelectionMode?: boolean
  /** This row is in the selection. */
  selected?: boolean
  /** Add or remove this row (by `prompt_key`). Absent: the row is not selectable. */
  onSelect?: (prompt: QuotaPrompt) => void
  /** Shift-click: extend the selection from its anchor to this row. */
  onRangeSelect?: (prompt: QuotaPrompt) => void
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

/** "3/5 this week" — the prompt's own count and its period, as the label shows it. */
function countText(prompt: QuotaPrompt): string {
  const period = freqLabel(prompt.period)
  return `${prompt.current}/${prompt.target}${period ? ` ${period}` : ''}`
}

export function QuotaPromptRow({
  prompt,
  variant = 'surface',
  completing = false,
  isSelectionMode = false,
  selected = false,
  hiddenWhenNarrow = false,
  onConsider,
  onDid,
  onSelect,
  onRangeSelect,
  onPeek,
  onLeft,
  onRegister,
  bubble,
}: QuotaPromptRowProps) {
  const panel = variant === 'panel'
  const key = prompt.prompt_key
  // Selection mode on a surface where this row can join it.
  const selecting = isSelectionMode && onSelect !== undefined
  const { press, onClick, onKeyDown } = usePromptRowGestures({
    prompt,
    completing,
    isSelectionMode,
    onConsider,
    onSelect,
    onRangeSelect,
    onPeek,
  })

  // Same two effects as `ReminderRow`: a row that unmounts mid-collapse still
  // reports leaving (or it would hold the surface's refresh shut), and only a
  // row that is on screen may hold its place while it collapses.
  useEffect(() => {
    if (!completing || !onLeft) return
    return () => onLeft(key)
  }, [completing, onLeft, key])
  useEffect(() => onRegister?.(key), [onRegister, key])

  const row = (
    <li
      data-prompt-key={key}
      data-prompt-task={prompt.task_id}
      role={onSelect ? 'option' : undefined}
      aria-selected={onSelect ? selected : undefined}
      data-reminder-leaving={completing ? '' : undefined}
      ref={completing ? measureLeavingRow : undefined}
      aria-disabled={completing || undefined}
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
      className={promptRowClasses({ panel, selected, hiddenWhenNarrow, completing })}
    >
      {/* The label-colour stripe, the quota chip's own (3px, green never).
          In the row's gutter (the panel's in the list's), so the eye lines
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
      <PromptEye
        prompt={prompt}
        panel={panel}
        completing={completing}
        selection={selecting ? { selected, onToggle: () => onSelect(prompt) } : null}
        onConsider={onConsider}
      />
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
        {/* The quota's notes, marked exactly as a reminder row marks its own
            (2026-09-25) — after the count, as a reminder's comes after its
            cadence mark. The bubble a hold opens is where they are read. */}
        {prompt.has_notes && <NotesMarker />}
      </p>
      <PromptDidButton
        prompt={prompt}
        panel={panel}
        completing={completing}
        selecting={selecting}
        onDid={onDid}
      />
    </li>
  )
  return row
}

/** The square — "did it": logs one, and considers the prompt too. */
function PromptDidButton({
  prompt,
  panel,
  completing,
  selecting,
  onDid,
}: {
  prompt: QuotaPrompt
  panel: boolean
  completing: boolean
  selecting: boolean
  onDid: (prompt: QuotaPrompt) => void
}) {
  return (
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
      // While selecting, the row offers only its checkbox, as a reminder
      // row does — kept in the layout (invisible) so nothing shifts.
      disabled={selecting}
      className={cn(
        selecting && 'invisible',
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
  )
}

/**
 * What a pointer and a key mean on a prompt row — `useReminderRowGestures`'
 * rules (RemindersView), except the hold, which opens the quota's bubble
 * (see the component's docblock). Its own hook for the same reason as the
 * reminder row's: the row is near ESLint's function-length limit.
 */
function usePromptRowGestures({
  prompt,
  completing,
  isSelectionMode,
  onConsider,
  onSelect,
  onRangeSelect,
  onPeek,
}: Pick<QuotaPromptRowProps, 'prompt' | 'onConsider' | 'onSelect' | 'onRangeSelect' | 'onPeek'> & {
  completing: boolean
  isSelectionMode: boolean
}) {
  const press = useLongPress({ onLongPress: () => onPeek(prompt) })
  const onClick = (e: React.MouseEvent) => {
    if (press.didFire()) {
      e.preventDefault()
      return
    }
    if (fromRowControl(e) || completing) return
    // The reminder row's rule: a held modifier never considers — it is the
    // mouse's way into a selection. Where there is no selection to join (the
    // dashboard card), a modifier-click and a selection-mode tap do nothing.
    if (e.shiftKey) onRangeSelect?.(prompt)
    else if (e.metaKey || e.ctrlKey || isSelectionMode) onSelect?.(prompt)
    else onConsider(prompt)
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
    if (isSelectionMode) onSelect?.(prompt)
    else onConsider(prompt)
  }
  return { press, onClick, onKeyDown }
}

/**
 * The eye — "considered" (seen) — in the reminder row's circle's exact box:
 * same size, same place, same tap target, and the same selection-mode
 * checkbox (`ReminderRowMarker`). Only the glyph differs (see the docblock).
 * Waiting: an outline eye in the circle's muted tone. Considered (the
 * collapse): a filled green eye — the circle's green disc, as an eye — with
 * its pupil ring knocked out in white, like SF Symbols' `eye.fill`.
 */
function PromptEye({
  prompt,
  panel,
  completing,
  selection,
  onConsider,
}: {
  prompt: QuotaPrompt
  panel: boolean
  completing: boolean
  /** In selection mode: the checkbox's state and toggle. */
  selection: { selected: boolean; onToggle: () => void } | null
  onConsider: (prompt: QuotaPrompt) => void
}) {
  const size = panel ? 'size-[19px]' : 'mt-[3px] size-6'
  const glyph = panel ? 'size-[19px]' : 'size-6'
  if (completing) {
    return (
      <span
        aria-hidden
        className={cn('flex shrink-0 items-center justify-center text-green-600', size)}
      >
        <Eye className={cn(glyph, 'fill-green-600 [&>circle]:stroke-white')} strokeWidth={1.75} />
      </span>
    )
  }
  if (selection) {
    return (
      <Checkbox
        checked={selection.selected}
        onCheckedChange={selection.onToggle}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={`Select "${prompt.title}"`}
        className={cn('shrink-0', size)}
      />
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
        'text-foreground/20 hover:text-foreground/60 hover:bg-foreground/5 flex shrink-0 items-center justify-center rounded-md transition-colors',
        size,
      )}
    >
      <Eye className={glyph} strokeWidth={1.5} />
    </button>
  )
}

/** The row's classes — the reminder row's (`reminderRowClasses`), in both sizes. */
function promptRowClasses({
  panel,
  selected,
  hiddenWhenNarrow,
  completing,
}: {
  panel: boolean
  selected: boolean
  hiddenWhenNarrow: boolean
  completing: boolean
}): string {
  const hover = panel ? 'hover:bg-foreground/5' : 'hover:bg-foreground/[0.04]'
  return cn(
    'group relative cursor-pointer items-start rounded-xl border border-transparent select-none',
    'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
    panel ? 'gap-2.5 px-1 py-1.5 transition-colors' : 'gap-3 px-2 py-2.5',
    selected ? 'ring-ring bg-accent ring-2' : hover,
    hiddenWhenNarrow ? 'hidden xl:flex' : 'flex',
    completing && 'animate-reminder-leaving pointer-events-none',
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
  selectedIds,
  onSelect,
  onRangeSelect,
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
  /** The surface's selection (reminder ids and prompt keys). Absent: not selectable. */
  selectedIds?: Set<number | string>
  onSelect?: (prompt: QuotaPrompt) => void
  onRangeSelect?: (prompt: QuotaPrompt) => void
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
      selected={selectedIds?.has(prompt.prompt_key) ?? false}
      onSelect={onSelect}
      onRangeSelect={onRangeSelect}
      hiddenWhenNarrow={extra.hiddenWhenNarrow}
      onConsider={considerPrompt}
      onDid={didPrompt}
      onPeek={detail.peek}
      onLeft={rowLeft}
      onRegister={registerRow}
    />
  )
  return { renderPrompt, openQuotas: detail.openQuotas, modal: detail.modal }
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

  /**
   * The selection bar's Details, when every selected row is a prompt: the
   * quotas behind them in the quota editor — several at once is its
   * multi-edit, with the "Remind me daily" switch and period pickers. A daily
   * quota's prompts share one task, so they are deduped to one quota each.
   * Fetched fresh, like the hold's, so the editor never starts from a copy
   * older than the last edit.
   */
  const openQuotas = useCallback(async (prompts: QuotaPrompt[]) => {
    const ids = [...new Set(prompts.map((p) => p.task_id))]
    try {
      const tasks = await Promise.all(
        ids.map(async (id) => {
          const res = await fetch(`/api/tasks/${id}`)
          if (!res.ok) throw new Error(`task ${res.status}`)
          return (await res.json()).data as Task
        }),
      )
      setEditing(tasks)
    } catch (err) {
      log.error('ui', 'Loading quotas for their prompts failed:', err)
      showToast({ message: 'Could not open the quotas', type: 'error' })
    }
  }, [])
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
                label: periodsLabel(prompt),
                rows: [
                  {
                    key: prompt.prompt_key,
                    label: periodsLabel(prompt),
                    currentId: prompt.slot_id,
                    onPick: (slot) => moveTo(prompt, mine, slot),
                  },
                ],
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

  return { peek, wrap, openQuotas, modal }
}
