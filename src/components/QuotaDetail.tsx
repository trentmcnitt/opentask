'use client'

import { useMemo, useState, type MutableRefObject } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  trackState,
  quotaFreqOf,
  quotaLabelOf,
  quotaPeriodOf,
  quotaRule,
  QUOTA_INTERVAL_MAX,
  QUOTA_PERIODS,
  type QuotaFreq,
} from '@/lib/track'
import { QuotaPromptSection, usePromptDraft } from '@/components/QuotaPromptField'
import { QuotaRecord } from '@/components/QuotaRecord'
import { PriorityChips } from '@/components/PriorityChips'
import {
  QuotaPromptBulkField,
  useBulkPromptDraft,
  type BulkPromptDraft,
} from '@/components/QuotaPromptBulkField'
import { isReservedLabel } from '@/lib/label-vocabulary'
import { useDomainLabels } from '@/hooks/useDomainLabels'
import { useStagedEditor } from '@/hooks/useStagedEditor'
import { useLabelConfig } from '@/components/PreferencesProvider'
import { getLabelClasses } from '@/lib/label-colors'
import type { QuotaPromptConfig, Task } from '@/types'

/**
 * The editor for a quota (REDESIGN-V03 §5) — "eat beef four times a week".
 *
 * Deliberately shaped like `ReminderDetail`, which is the sibling this should
 * have been copied from in the first place: one component that handles one
 * quota, several at once, or a new one, rendered full-size by the page and
 * inside `QuotaDetailModal` everywhere else. Where the two differ, it is
 * because a quota differs — not because this was written separately.
 *
 * A quota is never late and never notifies (`overdue-checker.ts` and
 * `currently-due.ts` both exclude tracked items), so there is no date here, no
 * snooze and no Done. Editing several applies only what is touched: a target
 * left alone stays per-quota, and a period the selection disagrees about shows
 * nothing pressed until one is chosen.
 *
 * A quota carries no `due_at` at all since 2026-09-08 (§5, Trent: "a quota is
 * not a task"): the server refuses to stamp one, refuses to accept one, and
 * the startup migration cleared the stale dates these rows used to hold.
 */

/**
 * The period a quota is being edited against. `null` means either "the
 * selection disagrees" or "this quota has no period at all" — both real states,
 * and both are why this is nullable rather than defaulting to WEEKLY. It used
 * to default, which silently rewrote a yearly or period-less quota to weekly
 * the first time its target was touched.
 */
type QuotaPeriod = QuotaFreq

/**
 * The label being edited. THREE states, and they are all different things:
 * a name, `null` for "no label", and `undefined` for "the selection disagrees".
 * Collapsing the last two would make it impossible to clear the label off a
 * mixed selection — the same trap the nullable `period` above documents.
 */
type QuotaLabelChoice = string | null | undefined

export interface QuotaCreateDraft {
  title: string
}

/** What a save carries. `ids` is empty when creating. */
export interface QuotaChanges {
  title?: string
  notes?: string | null
  progress_target?: number
  is_tracked?: true
  rrule?: string
  /** Always zero or one entry — a quota has ONE label (§5, Trent 2026-09-08). */
  labels?: string[]
  /** §7.2's opt-in: register a name the registry has never seen, in this write. */
  create_label?: true
  /** Quota reminders (2026-09-24): the "Remind me daily" section. Sent only when touched. */
  quota_prompt_config?: QuotaPromptConfig | null
  /** Paces the period's nag while its prompt waits (2026-10-22). Sent only when touched. */
  priority?: number
}

export interface QuotaDetailProps {
  /** The quota(s) being edited. Empty with `create` set is the new-quota form. */
  tasks: Task[]
  create?: QuotaCreateDraft | null
  /** One or several: save in one request. Rejects on failure so edits are kept. */
  onSave?: (changes: QuotaChanges) => void | Promise<void>
  onCreate?: (changes: QuotaChanges) => void | Promise<void>
  onDelete?: () => void
  /** Modal host only: dismiss, dropping staged edits. */
  onCancel?: () => void
  /** Modal host only: continue on the full page. */
  onOpenPage?: () => void
  /** Modal host only: show the "Quota" eyebrow, since no page header says so. */
  showKind?: boolean
  onDirtyChange?: (dirty: boolean) => void
  saveRef?: MutableRefObject<(() => Promise<void> | void) | null>
}

export function QuotaDetail({
  tasks,
  create,
  onSave,
  onCreate,
  onDelete,
  onCancel,
  onOpenPage,
  showKind = false,
  onDirtyChange,
  saveRef,
}: QuotaDetailProps) {
  const creating = tasks.length === 0 && !!create
  const single = tasks.length === 1 ? tasks[0] : null
  // One quota on screen (editing it, or a new one): the per-quota fields show.
  const oneQuota = creating || single !== null

  /** What the selection agrees on; '' / null where it does not. */
  const base = useMemo(
    () => describeBase({ creating, create, tasks, single }),
    [creating, create, tasks, single],
  )

  const [title, setTitle] = useState(base.title)
  const [target, setTarget] = useState(base.target)
  const [period, setPeriod] = useState<QuotaPeriod | null>(base.period)
  const [interval, setPeriodInterval] = useState<number | null>(base.interval)
  const [label, setLabel] = useState<QuotaLabelChoice>(base.label)
  const [notes, setNotes] = useState(base.notes)
  const [priority, setPriority] = useState<number | null>(base.priority)
  const { prompt, section } = useEditorPrompt(single, tasks, oneQuota, {
    period,
    interval,
    touched: period !== base.period || interval !== base.interval,
  })

  // Choosing ANOTHER period starts it at every 1 ("Every week" means every
  // week); pressing the chip that is already pressed changes nothing, so a
  // fortnight is not flattened by a stray tap on its own chip.
  const choosePeriod = (next: QuotaPeriod) => {
    if (next === period) return
    setPeriod(next)
    setPeriodInterval(1)
  }

  // The registry is the option list. `reload` runs after a save that registered
  // a new name, so the next quota edited in the same session is offered it.
  const { labels: registeredLabels, reload: reloadLabels } = useDomainLabels()

  // The staged fields, and what they amount to (`describeDraft`).
  const draft = { title, target, period, interval, label, notes, priority }
  const draftState = describeDraft({ creating, base, draft, prompt })
  const { targetNumber, targetTouched, dirty, targetOk, canSave } = draftState

  // The in-flight guard (a second tap while saving does nothing), the dirty
  // and unmount-clean reports, beforeunload and the saveRef registration all
  // come from useStagedEditor.
  // Not memoized: useStagedEditor holds the latest `save` in a ref.
  async function save() {
    if (!canSave) return
    try {
      const changes = quotaChangesFor({ creating, draft, draftState, prompt, registeredLabels })
      if (creating) await onCreate?.(changes)
      else await onSave?.(changes)
      // The write just minted a label; the option list is now one short.
      if (changes.create_label) reloadLabels()
      // Adopt what was actually SENT, not what was typed. The request trims,
      // so a stray trailing space left `base` and the field disagreeing
      // forever: a fully saved quota kept its blue stripe and kept raising the
      // unsaved-changes guard.
      setTitle((t) => t.trim())
      setNotes((n) => n.trim())
    } catch {
      // The host has already reported it. Swallowing here is what lets the
      // unsaved-changes dialog finish its own close — a rejection escaping
      // this left that dialog up forever with an unhandled rejection behind
      // it. The staged edits are deliberately kept so the save can be retried.
    }
  }

  const { saving, runSave: handleSave } = useStagedEditor({
    dirty,
    onDirtyChange,
    saveRef,
    save,
  })

  function handleReset() {
    setTitle(base.title)
    setTarget(base.target)
    setPeriod(base.period)
    setPeriodInterval(base.interval)
    setLabel(base.label)
    setNotes(base.notes)
    setPriority(base.priority)
    prompt.reset()
  }

  return (
    <div className="space-y-4" data-quota-detail={single?.id ?? (creating ? 'new' : 'many')}>
      {showKind && (
        <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          {creating ? 'New quota' : single ? 'Quota' : `${tasks.length} quotas`}
        </p>
      )}

      {single && <QuotaRecord task={single} state={trackState(single)} />}

      {oneQuota && <TitleField value={title} onChange={setTitle} autoFocus={creating} />}

      {!creating && !single && (
        <p className="text-muted-foreground text-sm">
          Editing {tasks.length} quotas. Only what you change is applied.
        </p>
      )}

      <CadenceField
        target={target}
        onTargetChange={setTarget}
        period={period}
        onPeriodChange={choosePeriod}
        interval={interval}
        onIntervalChange={setPeriodInterval}
        showError={targetTouched && !targetOk}
      />

      <LabelField value={label} onChange={setLabel} registered={registeredLabels} />

      <EditorPromptSection {...section} target={targetNumber} />

      <PriorityField value={priority} onChange={setPriority} />

      {oneQuota && <NotesField value={notes} onChange={setNotes} />}

      {single && <QuotaStats task={single} />}

      <QuotaActions
        creating={creating}
        canSave={canSave && !saving}
        saving={saving}
        dirty={dirty}
        onSave={() => void handleSave()}
        onReset={handleReset}
        onCancel={onCancel}
        onOpenPage={onOpenPage}
        onDelete={onDelete}
      />
    </div>
  )
}

/**
 * Quota reminders' staged state. One quota (or a new one) stages its whole
 * config; a selection stages only the fields changed, which the server merges
 * into each quota's own config (`QuotaPromptBulkField`). Both hooks always run
 * — hooks cannot be conditional — and `prompt` is whichever this editor shows.
 */
function useEditorPrompt(
  single: Task | null,
  tasks: Task[],
  oneQuota: boolean,
  draft: { period: QuotaPeriod | null; interval: number | null; touched: boolean },
) {
  const { period, interval, touched: periodTouched } = draft
  const singlePrompt = usePromptDraft(single)
  const bulkPrompt = useBulkPromptDraft(oneQuota ? [] : tasks, period, periodTouched, interval)
  return {
    prompt: oneQuota ? singlePrompt : bulkPrompt,
    section: { oneQuota, singlePrompt, bulkPrompt, period, interval, periodTouched, single },
  }
}

/** The "Remind me daily" section: one quota's full editor, or the multi-edit's. */
function EditorPromptSection({
  oneQuota,
  singlePrompt,
  bulkPrompt,
  period,
  interval,
  periodTouched,
  single,
  target,
}: {
  oneQuota: boolean
  singlePrompt: ReturnType<typeof usePromptDraft>
  bulkPrompt: BulkPromptDraft
  period: QuotaPeriod | null
  interval: number | null
  periodTouched: boolean
  single: Task | null
  target: number
}) {
  if (!oneQuota) return <QuotaPromptBulkField draft={bulkPrompt} />
  return (
    <QuotaPromptSection
      value={singlePrompt.config}
      onChange={singlePrompt.setConfig}
      period={period}
      interval={interval}
      periodTouched={periodTouched}
      task={single}
      target={target}
    />
  )
}

/**
 * "N times · every week", shared by every mode of the editor.
 *
 * The chips pick the period's UNIT and are pressed by FREQ alone; the "every
 * N" stepper under them (`IntervalStepper`, 2026-10-16) picks how many of it
 * — "every 2 weeks" is "Every week" pressed with 2 in the stepper. Not a
 * second number in front of the chips: "[1] times every [2] weeks" puts two
 * bare numbers side by side, and the first is the one people take for the
 * interval (the design doc's reading of Trent's ask).
 */
function CadenceField({
  target,
  onTargetChange,
  period,
  onPeriodChange,
  interval,
  onIntervalChange,
  showError,
}: {
  target: string
  onTargetChange: (value: string) => void
  period: QuotaPeriod | null
  onPeriodChange: (value: QuotaPeriod) => void
  /** Null: the selection's intervals disagree ("—"). */
  interval: number | null
  onIntervalChange: (value: number) => void
  showError: boolean
}) {
  const n = Number.parseInt(target, 10)
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">How often</legend>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Times per period"
          inputMode="numeric"
          value={target}
          onChange={(e) => onTargetChange(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="—"
          className="w-20 text-center text-[16px] tabular-nums"
        />
        <span className="text-muted-foreground text-sm">{n === 1 ? 'time' : 'times'}</span>
        <div className="flex flex-wrap gap-1.5">
          {QUOTA_PERIODS.map(({ freq, editor }) => (
            <button
              key={freq}
              type="button"
              onClick={() => onPeriodChange(freq)}
              aria-pressed={period === freq}
              data-period-chip={freq}
              className={cn(
                'rounded-full border px-3 py-1 text-sm transition-colors',
                period === freq
                  ? 'border-foreground bg-foreground text-background'
                  : 'hover:border-foreground/40',
              )}
            >
              {editor}
            </button>
          ))}
        </div>
      </div>
      {period !== null && QUOTA_INTERVAL_MAX[period] > 1 && (
        <IntervalStepper period={period} value={interval} onChange={onIntervalChange} />
      )}
      {showError && (
        <p className="text-destructive text-xs">A target is a whole number from 1 to 1000.</p>
      )}
    </fieldset>
  )
}

/**
 * "every [−] 2 [+] weeks" — how many of the pressed period one quota period
 * spans (interval quotas, 2026-10-16). Always shown under the pressed chip,
 * at 1 too ("every 1 week"), so it can be found without knowing to look for
 * it; a yearly quota has none (every year is the only choice). The range is
 * the server's cap (`QUOTA_INTERVAL_MAX`): 1–30 days, 1–12 weeks, 1–12
 * months. `null` is a multi-edit whose quotas disagree — it shows "—", and
 * either button starts it from 1.
 */
function IntervalStepper({
  period,
  value,
  onChange,
}: {
  period: QuotaPeriod
  value: number | null
  onChange: (value: number) => void
}) {
  const max = QUOTA_INTERVAL_MAX[period]
  const unit = period === 'DAILY' ? 'day' : QUOTA_PERIODS.find((p) => p.freq === period)!.word
  const shown = value ?? 1
  const step = (delta: 1 | -1) =>
    onChange(value === null ? 1 : Math.min(max, Math.max(1, value + delta)))
  const stepClass =
    'hover:border-foreground/40 flex size-7 items-center justify-center rounded-full border text-sm disabled:opacity-40'
  return (
    <div className="flex items-center gap-2 text-sm" data-interval-stepper={period}>
      <span className="text-muted-foreground">every</span>
      <button
        type="button"
        aria-label={`Fewer ${unit}s per period`}
        onClick={() => step(-1)}
        disabled={value !== null && value <= 1}
        className={stepClass}
      >
        −
      </button>
      <output
        aria-live="polite"
        aria-label={value === null ? 'Mixed' : `Every ${value} ${unit}${value === 1 ? '' : 's'}`}
        data-interval-value={value ?? ''}
        className="w-6 text-center font-medium tabular-nums"
      >
        {value === null ? '—' : value}
      </output>
      <button
        type="button"
        aria-label={`More ${unit}s per period`}
        onClick={() => step(1)}
        disabled={value !== null && value >= max}
        className={stepClass}
      >
        +
      </button>
      <span className="text-muted-foreground">
        {unit}
        {value === null || shown !== 1 ? 's' : ''}
      </span>
    </div>
  )
}

/**
 * The quota's ONE label — the grouping the Quotas page reads.
 *
 * Trent, 2026-09-08: "I think we need to have one label for quotas… there's a
 * bunch of stuff for the kids and there are other things." So this is
 * single-select, not the task editor's multi-label chip bar: picking a second
 * label replaces the first rather than adding to it, because the page files
 * each quota in exactly one place.
 *
 * Options are the DOMAIN facet of the label registry (§7.2) — the `ai-*`
 * operational labels are machinery and are never offered. "None" is a real
 * choice and sits first. A name that is not in the registry can be typed, and
 * is registered by the save itself (`create_label`); it is added to the chips
 * immediately so the pressed state has something to be pressed on.
 *
 * Chips rather than a select, matching `CadenceField` directly above it: this
 * editor's whole vocabulary is chips, and a thirteen-label registry wraps into
 * two lines. Colours come from `label_config` through `getLabelClasses`, the
 * same call the filter bar and the task editor make, so a label looks the same
 * everywhere it appears.
 */
function LabelField({
  value,
  onChange,
  registered,
}: {
  value: QuotaLabelChoice
  onChange: (value: string | null) => void
  registered: string[]
}) {
  const { labelConfig } = useLabelConfig()
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')

  // The current value is always offered, even when the registry has never
  // heard of it: a quota carrying a legacy label must be able to keep it, and
  // a name typed a moment ago must show as chosen before the registry reloads.
  //
  // Except a RESERVED one. `ai-*` labels are machinery — enrichment writes
  // `ai-failed`, creation writes `ai-to-process` — and a quota that happens to
  // carry one is not thereby filed under it. Offering it as a chip invited the
  // user to hand-assign a processing state; `quotaLabelOf` skips them for the
  // same reason, so such a quota reads as unlabelled here and "None" is what
  // shows as chosen.
  const options = useMemo(() => {
    const names = new Set(registered.filter((n) => !isReservedLabel(n)))
    if (value && !isReservedLabel(value)) names.add(value)
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [registered, value])

  function commitDraft() {
    const typed = draft.trim()
    setTyping(false)
    setDraft('')
    if (!typed) return
    // Typing a name the registry already has in another case reuses ITS
    // spelling rather than creating a variant. The registry's UNIQUE is
    // case-sensitive, so "Kids" typed against an existing "kids" would become a
    // second row, a second chip and — before `groupByLabel` started keying
    // case-insensitively — a second group with an identical header. Fixing the
    // grouping hides that; this stops making them.
    const existing = registered.find((n) => n.toLowerCase() === typed.toLowerCase())
    onChange(existing ?? typed)
  }

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Label</legend>
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Mixed selection: nothing is pressed, and the em dash says why —
            the same mark the task panel uses for a mixed field. */}
        {value === undefined && <span className="text-muted-foreground text-sm">—</span>}
        <LabelChip
          name="None"
          pressed={value === null}
          onClick={() => onChange(null)}
          testValue="none"
        />
        {options.map((name) => (
          <LabelChip
            key={name}
            name={name}
            pressed={value === name}
            onClick={() => onChange(name)}
            colorClasses={getLabelClasses(name, labelConfig)}
            testValue={name}
          />
        ))}
        {typing ? (
          <Input
            aria-label="New label"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // Blur commits rather than cancels: on a phone, "type the name then
            // reach for Save" is the ordinary gesture, and throwing the name
            // away at that moment would look like the field ignoring the user.
            // Escape is the way out, and it is the only way out.
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitDraft()
              }
              if (e.key === 'Escape') {
                setTyping(false)
                setDraft('')
              }
            }}
            placeholder="New label"
            className="h-8 w-32 text-[16px]"
          />
        ) : (
          <LabelChip name="+ New" pressed={false} onClick={() => setTyping(true)} testValue="new" />
        )}
      </div>
    </fieldset>
  )
}

function LabelChip({
  name,
  pressed,
  onClick,
  colorClasses,
  testValue,
}: {
  name: string
  pressed: boolean
  onClick: () => void
  colorClasses?: string | null
  testValue: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      data-quota-label-chip={testValue}
      className={cn(
        'rounded-full border px-3 py-1 text-sm transition-colors',
        pressed
          ? 'border-foreground bg-foreground text-background'
          : colorClasses
            ? `${colorClasses} border-current/20`
            : 'hover:border-foreground/40',
      )}
    >
      {name}
    </button>
  )
}

/**
 * The reminder editor's priority row (`PriorityChips`, shared): a quota's
 * priority paces its period's nag while its prompt waits (`slot-nags.ts`, a
 * prompt counts at its quota's priority). Headed by a `<legend>` like every
 * other field here, not the reminder's uppercase heading and dirty dot —
 * this editor's dirtiness is the card's stripe. Pressing the chip already
 * pressed changes nothing (the base again is not a change).
 */
function PriorityField({
  value,
  onChange,
}: {
  value: number | null
  onChange: (value: number) => void
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Priority</legend>
      <PriorityChips value={value} onSelect={onChange} kind="quota" />
    </fieldset>
  )
}

/** The read-only history. "Never yet" is a real answer, and usually the useful one. */
function QuotaStats({ task }: { task: Task }) {
  const state = trackState(task)
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3 text-sm">
      <div>
        <dt className="text-muted-foreground text-xs">Logged so far</dt>
        <dd className="tabular-nums">
          <span className="font-medium">{state.current}</span> of {state.target}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground text-xs">Periods met</dt>
        <dd className="tabular-nums">
          {task.completion_count > 0 ? `${task.completion_count}×` : 'Never yet'}
        </dd>
      </div>
    </dl>
  )
}

function QuotaActions({
  creating,
  canSave,
  saving,
  dirty,
  onSave,
  onReset,
  onCancel,
  onOpenPage,
  onDelete,
}: {
  creating: boolean
  canSave: boolean
  saving: boolean
  dirty: boolean
  onSave: () => void
  onReset: () => void
  onCancel?: () => void
  onOpenPage?: () => void
  onDelete?: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-3">
      <Button onClick={onSave} disabled={!canSave}>
        {saving ? 'Saving…' : creating ? 'Create' : 'Save'}
      </Button>
      {!creating && (
        <Button variant="outline" onClick={onReset} disabled={!dirty}>
          Reset
        </Button>
      )}
      {onCancel && (
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      )}
      {onOpenPage && (
        <Button variant="ghost" onClick={onOpenPage} className="ml-auto">
          Open full page
        </Button>
      )}
      {onDelete && !creating && (
        <Button
          variant="ghost"
          onClick={onDelete}
          className={cn('text-destructive', !onOpenPage && 'ml-auto')}
        >
          Move to Trash
        </Button>
      )}
    </div>
  )
}

/**
 * What the editor OPENS on: the stored state, reduced across the selection.
 *
 * Every field has to answer three things rather than two — a shared value, a
 * shared absence, and disagreement — and it is the middle one that keeps
 * getting lost: a period-less quota once read back as weekly, so editing its
 * target rewrote its schedule. `null` therefore means "genuinely none" and is
 * a real answer; only `undefined` (label) or an empty string (target) means
 * "they differ, do not touch this".
 *
 * Module-level and pure, next to `describeDraft`, which does the same job for
 * the edited half — the component stays layout plus state.
 */
function describeBase({
  creating,
  create,
  tasks,
  single,
}: {
  creating: boolean
  create?: QuotaCreateDraft | null
  tasks: Task[]
  single: Task | null
}) {
  if (creating)
    return {
      title: create?.title ?? '',
      target: '3',
      period: 'WEEKLY' as QuotaPeriod | null,
      interval: 1 as number | null,
      // A new quota starts unlabelled — `null`, not `undefined`: nothing is in
      // disagreement, the answer is simply "none".
      label: null as QuotaLabelChoice,
      notes: '',
      priority: 0 as number | null,
      allPeriodless: false,
    }
  const targets = new Set(tasks.map((t) => String(Math.max(1, t.progress_target ?? 1))))
  const periods = new Set(tasks.map((t) => quotaFreqOf(t.rrule)))
  // The interval apart from the FREQ, so the chip a fortnight presses is
  // "Every week" and a selection mixing every week with every 2 weeks presses
  // "Every week" with "—" in the stepper.
  const intervals = new Set(tasks.map((t) => quotaPeriodOf(t.rrule)?.interval ?? 1))
  const labels = new Set(tasks.map(quotaLabelOf))
  const priorities = new Set(tasks.map((t) => t.priority ?? 0))
  return {
    title: single?.title ?? '',
    target: targets.size === 1 ? [...targets][0] : '',
    period: periods.size === 1 ? [...periods][0] : null,
    interval: intervals.size === 1 ? ([...intervals][0] as number | null) : null,
    // One agreed label (or one agreed "none"); `undefined` when they differ, so
    // picking "None" on a mixed selection still reads as a change.
    label: (labels.size === 1 ? [...labels][0] : undefined) as QuotaLabelChoice,
    notes: single?.notes ?? '',
    // One agreed priority, or null when they differ: no chip pressed.
    priority: priorities.size === 1 ? ([...priorities][0] as number | null) : null,
    // Every selected quota genuinely has no period, as opposed to the selection
    // disagreeing about which one it is.
    allPeriodless: periods.size === 1 && [...periods][0] === null,
  }
}

/** The fields one editing session stages. */
interface QuotaDraft {
  title: string
  target: string
  period: QuotaPeriod | null
  interval: number | null
  label: QuotaLabelChoice
  notes: string
  priority: number | null
}

/**
 * What a save sends: only what was touched (and, creating, everything).
 * Module-level and pure, beside `describeDraft`, whose answer it reads.
 */
function quotaChangesFor({
  creating,
  draft,
  draftState,
  prompt,
  registeredLabels,
}: {
  creating: boolean
  draft: QuotaDraft
  draftState: ReturnType<typeof describeDraft>
  prompt: { touched: boolean; config: QuotaPromptConfig | null }
  registeredLabels: string[]
}): QuotaChanges {
  const changes: QuotaChanges = {}
  if (creating || draftState.titleTouched) changes.title = draft.title.trim()
  if (creating || draftState.notesTouched) changes.notes = draft.notes.trim() || null
  if (creating || draftState.targetTouched) {
    changes.progress_target = draftState.targetNumber
    changes.is_tracked = true
  }
  // The rule goes ONLY when the period was actually changed.
  //
  // Sending it on any schedule edit flattened whatever else the rule carried:
  // a quota on FREQ=WEEKLY;INTERVAL=2 silently became every week, and a BYDAY
  // was dropped. (It also made the server re-derive anchors and recompute a
  // `due_at` behind the editor's back — that half is now fixed at the source:
  // a tracked row never gets a computed date.)
  //
  // It also means a quota with NO period, and a selection that disagrees
  // about its period, can both have their target edited while each keeps its
  // own rule. `is_tracked` alone satisfies the server's rule for a bare FREQ,
  // so nothing has to be invented to make the request legal.
  //
  // INTERVAL QUOTAS (2026-10-16): the rule is canonical — `FREQ=X`, plus
  // `;INTERVAL=N` above 1 (`quotaRule`; the server refuses the other
  // order). A touched period always has an interval: choosing a chip sets
  // it to 1, and the stepper sets it directly. A selection whose intervals
  // disagree shows "—" and sends nothing until one of the two is touched.
  if (creating || draftState.periodTouched) {
    changes.is_tracked = true
    if (draft.period !== null) changes.rrule = quotaRule(draft.period, draft.interval ?? 1)
  }
  // The label goes ONLY when it was actually chosen, for the same reason the
  // rule does: six quotas on this corpus still carry TWO labels from before
  // one-label-per-quota, and the migration deliberately left them alone.
  // Editing such a quota's target must not quietly drop its second label —
  // but choosing a label does, which is the point of the rule.
  if (draftState.labelTouched && draft.label !== undefined) {
    changes.labels = draft.label ? [draft.label] : []
    // §7.2: an unknown label is refused unless the write says to create it.
    // This is the flag the API documents for exactly this case, rather than
    // a separate round-trip to the registry endpoint.
    if (draft.label && !registeredLabels.includes(draft.label)) changes.create_label = true
  }
  // Only a touched section is sent: an untouched quota keeps a NULL config
  // ("follow the defaults"), so a later change of the default period in
  // Settings still moves it.
  if (prompt.touched) changes.quota_prompt_config = prompt.config
  // Only when chosen: a selection that disagrees keeps each quota's own.
  if (draftState.priorityTouched && draft.priority !== null) changes.priority = draft.priority
  return changes
}

/**
 * What the draft is, and whether it can be saved — pulled out of the component
 * because it is nearly all of its branching.
 *
 * Creating needs every field. Editing needs only what is being changed to be
 * valid, and a schedule edit needs BOTH halves: validation refuses a bare
 * `FREQ=` rule that does not also say the task is tracked — which `is_tracked`
 * on its own satisfies, so a target and a period do NOT have to travel
 * together, and deliberately don't: see quotaChangesFor.
 */
function describeDraft({
  creating,
  base,
  draft,
  prompt,
}: {
  creating: boolean
  base: ReturnType<typeof describeBase>
  draft: QuotaDraft
  /** The "Remind me daily" section changed (compared by the component). */
  prompt?: { touched: boolean }
}) {
  const { title, target, period, interval, label, notes, priority } = draft
  const targetNumber = Number.parseInt(target, 10)
  const targetTouched = target !== base.target
  // The period is the FREQ and the interval together: changing only the
  // "every N" stepper is a period change, and sends the rule.
  const periodTouched = period !== base.period || interval !== base.interval
  const titleTouched = title !== base.title
  const notesTouched = notes !== base.notes
  const labelTouched = label !== base.label
  const priorityTouched = priority !== base.priority
  const dirty =
    titleTouched ||
    notesTouched ||
    targetTouched ||
    periodTouched ||
    labelTouched ||
    priorityTouched ||
    !!prompt?.touched
  const targetOk = target.length > 0 && targetNumber >= 1 && targetNumber <= 1000
  // Creating needs a title, a valid target and a period. Editing needs only
  // what is being changed to be valid — a period-less quota, and a selection
  // that disagrees about its period, must both stay editable, and they do
  // because an untouched period is simply not sent.
  const canSave = creating
    ? title.trim().length > 0 && targetOk && period !== null
    : dirty && (!targetTouched || targetOk)
  return {
    targetNumber,
    titleTouched,
    notesTouched,
    targetTouched,
    periodTouched,
    labelTouched,
    priorityTouched,
    dirty,
    targetOk,
    canSave,
  }
}

function TitleField({
  value,
  onChange,
  autoFocus,
}: {
  value: string
  onChange: (v: string) => void
  autoFocus: boolean
}) {
  return (
    <div className="space-y-2">
      <label htmlFor="quota-title" className="text-sm font-medium">
        Title
      </label>
      <Input
        id="quota-title"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="What are you counting?"
        className="text-[16px]"
      />
    </div>
  )
}

function NotesField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <label htmlFor="quota-notes" className="text-sm font-medium">
        Notes
      </label>
      <Textarea
        id="quota-notes"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder="What does this one actually mean?"
        className="resize-none text-[16px]"
      />
    </div>
  )
}
