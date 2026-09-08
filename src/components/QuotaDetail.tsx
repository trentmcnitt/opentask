'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { trackState, quotaFreqOf, quotaLabelOf, QUOTA_PERIODS, type QuotaFreq } from '@/lib/track'
import { useDomainLabels } from '@/hooks/useDomainLabels'
import { useLabelConfig } from '@/components/PreferencesProvider'
import { getLabelClasses } from '@/lib/label-colors'
import type { Task } from '@/types'

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

  /** What the selection agrees on; '' / null where it does not. */
  const base = useMemo(
    () => describeBase({ creating, create, tasks, single }),
    [creating, create, tasks, single],
  )

  const [title, setTitle] = useState(base.title)
  const [target, setTarget] = useState(base.target)
  const [period, setPeriod] = useState<QuotaPeriod | null>(base.period)
  const [label, setLabel] = useState<QuotaLabelChoice>(base.label)
  const [notes, setNotes] = useState(base.notes)

  // The registry is the option list. `reload` runs after a save that registered
  // a new name, so the next quota edited in the same session is offered it.
  const { labels: registeredLabels, reload: reloadLabels } = useDomainLabels()

  const {
    targetNumber,
    titleTouched,
    notesTouched,
    targetTouched,
    periodTouched,
    labelTouched,
    dirty,
    targetOk,
    canSave,
  } = describeDraft({ creating, base, title, target, period, label, notes })

  // Report dirtiness, and report clean on the way out: the modal unmounts this
  // when it closes, and without the unmount clear the host stayed "dirty" until
  // the next mount's effect ran — one frame of blue stripe and a disabled drag
  // every time it reopened. ReminderDetail does the same through a ref.
  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange
  }, [onDirtyChange])
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => {
    return () => onDirtyChangeRef.current?.(false)
  }, [])

  const buildChanges = useCallback((): QuotaChanges => {
    const changes: QuotaChanges = {}
    if (creating || titleTouched) changes.title = title.trim()
    if (creating || notesTouched) changes.notes = notes.trim() || null
    if (creating || targetTouched) {
      changes.progress_target = targetNumber
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
    if (creating || periodTouched) {
      changes.is_tracked = true
      if (period !== null) changes.rrule = `FREQ=${period}`
    }
    // The label goes ONLY when it was actually chosen, for the same reason the
    // rule does: six quotas on this corpus still carry TWO labels from before
    // one-label-per-quota, and the migration deliberately left them alone.
    // Editing such a quota's target must not quietly drop its second label —
    // but choosing a label does, which is the point of the rule.
    if (labelTouched && label !== undefined) {
      changes.labels = label ? [label] : []
      // §7.2: an unknown label is refused unless the write says to create it.
      // This is the flag the API documents for exactly this case, rather than
      // a separate round-trip to the registry endpoint.
      if (label && !registeredLabels.includes(label)) changes.create_label = true
    }
    return changes
  }, [
    creating,
    titleTouched,
    notesTouched,
    targetTouched,
    periodTouched,
    labelTouched,
    title,
    notes,
    targetNumber,
    period,
    label,
    registeredLabels,
  ])

  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    // `saving` is the in-flight guard as well as the label: the modal only
    // closes once the request resolves, so without it two taps on a slow
    // connection made two quotas — or two PATCHes and two undo entries.
    if (!canSave || saving) return
    setSaving(true)
    try {
      const changes = buildChanges()
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
    } finally {
      setSaving(false)
    }
  }, [canSave, saving, buildChanges, creating, onCreate, onSave, reloadLabels])

  useEffect(() => {
    if (!saveRef) return
    saveRef.current = handleSave
    return () => {
      saveRef.current = null
    }
  }, [saveRef, handleSave])

  function handleReset() {
    setTitle(base.title)
    setTarget(base.target)
    setPeriod(base.period)
    setLabel(base.label)
    setNotes(base.notes)
  }

  return (
    <div className="space-y-4" data-quota-detail={single?.id ?? (creating ? 'new' : 'many')}>
      {showKind && (
        <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          {creating ? 'New quota' : single ? 'Quota' : `${tasks.length} quotas`}
        </p>
      )}

      {(creating || single) && (
        <TitleField value={title} onChange={setTitle} autoFocus={creating} />
      )}

      {!creating && !single && (
        <p className="text-muted-foreground text-sm">
          Editing {tasks.length} quotas. Only what you change is applied.
        </p>
      )}

      <CadenceField
        target={target}
        onTargetChange={setTarget}
        period={period}
        onPeriodChange={setPeriod}
        showError={targetTouched && !targetOk}
      />

      <LabelField value={label} onChange={setLabel} registered={registeredLabels} />

      {(creating || single) && <NotesField value={notes} onChange={setNotes} />}

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

/** "N times · every week", shared by every mode of the editor. */
function CadenceField({
  target,
  onTargetChange,
  period,
  onPeriodChange,
  showError,
}: {
  target: string
  onTargetChange: (value: string) => void
  period: QuotaPeriod | null
  onPeriodChange: (value: QuotaPeriod) => void
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
      {showError && (
        <p className="text-destructive text-xs">A target is a whole number from 1 to 1000.</p>
      )}
    </fieldset>
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
  const options = useMemo(() => {
    const names = new Set(registered)
    if (value) names.add(value)
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  }, [registered, value])

  function commitDraft() {
    const name = draft.trim()
    setTyping(false)
    setDraft('')
    if (name) onChange(name)
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
      // A new quota starts unlabelled — `null`, not `undefined`: nothing is in
      // disagreement, the answer is simply "none".
      label: null as QuotaLabelChoice,
      notes: '',
      allPeriodless: false,
    }
  const targets = new Set(tasks.map((t) => String(Math.max(1, t.progress_target ?? 1))))
  const periods = new Set(tasks.map((t) => quotaFreqOf(t.rrule)))
  const labels = new Set(tasks.map(quotaLabelOf))
  return {
    title: single?.title ?? '',
    target: targets.size === 1 ? [...targets][0] : '',
    period: periods.size === 1 ? [...periods][0] : null,
    // One agreed label (or one agreed "none"); `undefined` when they differ, so
    // picking "None" on a mixed selection still reads as a change.
    label: (labels.size === 1 ? [...labels][0] : undefined) as QuotaLabelChoice,
    notes: single?.notes ?? '',
    // Every selected quota genuinely has no period, as opposed to the selection
    // disagreeing about which one it is.
    allPeriodless: periods.size === 1 && [...periods][0] === null,
  }
}

/**
 * What the draft is, and whether it can be saved — pulled out of the component
 * because it is nearly all of its branching.
 *
 * Creating needs every field. Editing needs only what is being changed to be
 * valid, and a schedule edit needs BOTH halves: validation refuses a bare
 * `FREQ=` rule that does not also say the task is tracked — which `is_tracked`
 * on its own satisfies, so a target and a period do NOT have to travel
 * together, and deliberately don't: see buildChanges.
 */
function describeDraft({
  creating,
  base,
  title,
  target,
  period,
  label,
  notes,
}: {
  creating: boolean
  base: {
    title: string
    target: string
    period: QuotaPeriod | null
    label: QuotaLabelChoice
    notes: string
    allPeriodless: boolean
  }
  title: string
  target: string
  period: QuotaPeriod | null
  label: QuotaLabelChoice
  notes: string
}) {
  const targetNumber = Number.parseInt(target, 10)
  const targetTouched = target !== base.target
  const periodTouched = period !== base.period
  const titleTouched = title !== base.title
  const notesTouched = notes !== base.notes
  const labelTouched = label !== base.label
  const dirty = titleTouched || notesTouched || targetTouched || periodTouched || labelTouched
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
