/**
 * Task creation
 */

import { TARGET_SET_FIELD } from './target-set'
import { getTargetContext } from './target-context'
import {
  DECK_REFUSAL_MESSAGES,
  capAtDeadline,
  deckDayProblem,
  deckRefusal,
  deckSkip,
  leadDaysProblem,
  leadFor,
  occurrenceDates,
  resolveTarget,
  type LeadContext,
  type RelativeTarget,
  type TargetContext,
} from '@/lib/task-segments'
import { dayBoundaryForUser, rolloverTimeForUser } from './rollover-time'
import {
  REPEAT_END_MESSAGES,
  assertRuleOnDeadline,
  createAnchor,
  repeatEndProblem,
  resolveRelativeTarget,
} from './repeat-schedule'
import { taskQueueEnabled } from './task-queue'
import {
  RELATIVE_KIND_MESSAGE,
  assertOneOffRelative,
  linkAfter,
  linkTargetTime,
  sendsRelative,
} from './relative-target'
import { getDb, withTransaction } from '@/core/db'
import type { RepeatAnchor, Task, TaskCreateInput } from '@/types'
import { nowUtc } from '@/core/recurrence'
import {
  computeFirstOccurrence,
  deriveAnchorFields,
  fillRuleTime,
  rollPassedFirstOccurrence,
} from '@/core/recurrence'
import { logAction, createTaskSnapshot } from '@/core/undo'
import { logActivity } from '@/core/activity'
import { emitSyncEvent, emitTaskCreatedEvent } from '@/lib/sync-events'
import { dispatchWebhookEvent } from '@/core/webhooks/dispatch'
import { getInboxId } from '@/core/projects'
import { syncBadgeCount } from '@/core/notifications/dismiss'
import { formatTaskResponse } from '@/lib/format-task'
import { incrementDailyStat } from '@/core/stats'
import { AppError, NotFoundError, ForbiddenError, ValidationError } from '@/core/errors'
import {
  QUOTA_DUE_DATE_MESSAGE,
  QUOTA_INTERVAL_MESSAGE,
  QUOTA_PERIOD_MESSAGE,
} from '@/core/validation'
import { isTracked, quotaIntervalAllowed, quotaPeriodOf } from '@/lib/track'
import { assertPromptSlotsOwned, defaultReminderRule } from '@/core/time-slots'
import { getTaskById } from './read'
import { quotaAnchorNow } from './period-rollover'
import { getUserFeatureModes, isAIEnabled } from '@/core/ai'
import { QUOTA_PROVISIONAL_RULE } from '@/core/ai/quota-enrichment'
import { validateLabelsExist, PROVENANCE_LABELS } from '@/core/labels'

// The reads used to live here. Re-exported so existing `./create` imports keep
// working; new code imports from `./read`.
export { getTaskById, getTasks } from './read'
export type { GetTasksOptions, TaskKind } from './read'

export interface CreateTaskOptions {
  userId: number
  userTimezone: string
  input: TaskCreateInput
  /**
   * `false`: never queue AI enrichment for this row (no `ai-to-process`),
   * whatever the server's AI setting and the input's shape. For the seed
   * scripts (`seedTasks` in scripts/seed-utils.ts): their invented data is
   * final as written, and a title-only seed row would otherwise be rewritten
   * by the server's enrichment cron. Not on the wire. Default: enrichment
   * runs as it always has.
   */
  enrichment?: boolean
}

/**
 * A new quota's two refusals (§5): it has no due date (QUOTA_DUE_DATE_MESSAGE),
 * and it always has a period (QUOTA_PERIOD_MESSAGE, 2026-09-25) whose
 * INTERVAL is in range (QUOTA_INTERVAL_MESSAGE, 2026-10-16).
 */
function assertQuotaShape(input: TaskCreateInput): void {
  if (input.due_at) throw new ValidationError(QUOTA_DUE_DATE_MESSAGE)
  if (quotaPeriodOf(input.rrule) === null) throw new ValidationError(QUOTA_PERIOD_MESSAGE)
  if (!quotaIntervalAllowed(input.rrule)) throw new ValidationError(QUOTA_INTERVAL_MESSAGE)
}

/**
 * Title-only (enrichment's trigger) is judged on what the CALLER sent, before
 * any server default fills in an rrule (the default reminder slot, a quota's
 * provisional period) — otherwise a title-only reminder would stop qualifying
 * for enrichment the moment it got its default slot. A deadline or horizon the
 * caller set is structured input too: enrichment must not overwrite a desk's
 * explicit deadline with its own reading. So is a quota's count above 1
 * (quota enrichment, 2026-10-24): the caller already said how many.
 */
function isTitleOnlyInput(input: TaskCreateInput): boolean {
  return (
    !input.due_at &&
    (input.priority ?? 0) === 0 &&
    !input.labels?.length &&
    !input.rrule &&
    !input.deadline_at &&
    !input.horizon &&
    // A deck is the caller's own plan (On deck, 2026-10-20): enrichment must
    // not land a target on it (a target would take it straight off deck).
    !input.on_deck_day &&
    (input.progress_target ?? 1) <= 1
  )
}

/** Will this new row get `ai-to-process` — AI on, the owner's enrichment on, and title-only or `enrich`? */
function enrichmentWillRun(userId: number, input: TaskCreateInput): boolean {
  if (!isAIEnabled()) return false
  if (!isTitleOnlyInput(input) && input.enrich !== true) return false
  return getUserFeatureModes(userId).enrichment !== 'off'
}

/**
 * Does the new row get `ai-to-process` (createTask)? AI on, the caller has not
 * opted out (`enrichment: false`, the seeds), and title-only or `enrich`.
 */
function queuesEnrichment(
  options: CreateTaskOptions,
  isTitleOnly: boolean,
  input: TaskCreateInput,
): boolean {
  if (options.enrichment === false || !isAIEnabled()) return false
  return isTitleOnly || input.enrich === true
}

/**
 * A QUOTA FROM WORDS (quota enrichment, 2026-10-24; plan APPROVED 10-22): a
 * caller that declares a quota with no rule — an Apple Shortcut POSTing
 * `{title: "eggs twice a week", is_tracked: true}` — gets it at once with the
 * PROVISIONAL period (`QUOTA_PROVISIONAL_RULE`, weekly, target 1), the way a
 * rule-less reminder gets its default slot (`scheduleFor`), and enrichment
 * then reads the count, period and reminder period from the words. Only when
 * enrichment will actually run: without it the raw sentence at once a week is
 * worse than an error, so the 400 stays — saying how to avoid it. An explicit
 * `rrule: null` is not "unsaid": it is refused as before (`assertQuotaShape`).
 */
function withProvisionalQuotaRule(
  userId: number,
  input: TaskCreateInput,
  enrichment: boolean,
): TaskCreateInput {
  const tracked = isTracked({
    is_tracked: input.is_tracked ?? false,
    progress_target: input.progress_target ?? 1,
  })
  if (!tracked || input.rrule !== undefined) return input
  if (!enrichment || !enrichmentWillRun(userId, input)) {
    throw new ValidationError(
      `${QUOTA_PERIOD_MESSAGE}, or turn on AI enrichment to have the period read from the title`,
    )
  }
  return { ...input, rrule: QUOTA_PROVISIONAL_RULE }
}

/**
 * DEFAULT REMINDER SLOT (Trent, 2026-09-28: "Adding a reminder should be just
 * like adding a task"). A reminder created with no schedule — an Apple
 * Shortcut POSTing `{title, is_reminder: true}`, or the Reminders quick add —
 * lands at once in the user's default reminder slot, daily at its start
 * (`defaultReminderRule`), never in "Anytime". Enrichment still runs on it
 * (the ai-to-process trigger in createTask) and moves it if the text names a time or
 * cadence; if AI is off or enrichment fails, it stays in the default slot.
 *
 * Only an OMITTED rrule gets the default. An explicit `rrule: null` is the
 * reminder editor's one-time thought ("once"), a deliberate "no schedule",
 * and a caller-supplied rule ("FREQ=DAILY;BYHOUR=9") or due_at is respected
 * as sent. A user with no slots at all gets no default (null) — the
 * reminder stays unscheduled, as before.
 */
function scheduleFor(
  userId: number,
  input: TaskCreateInput,
  tracked: boolean,
): string | null | undefined {
  if (input.is_reminder !== true || input.rrule !== undefined || input.due_at || tracked) {
    return input.rrule
  }
  return defaultReminderRule(userId) ?? undefined
}

/**
 * The rule the new row stores: `scheduleFor`'s, with its time of day filled
 * in (every non-quota rule has one, `fillRuleTime`: the time of a date sent
 * with it, else the user's Morning time). Before the first occurrence is
 * computed — a timeless rule would start at local midnight, a period late.
 */
function timedSchedule(
  userId: number,
  input: TaskCreateInput,
  tracked: boolean,
  ctx: TargetContext,
  timezone: string,
  anchor: RepeatAnchor,
): string | null | undefined {
  return fillRuleTime(scheduleFor(userId, input, tracked), tracked, {
    // A deadline-anchored rule repeats the DEADLINE (2026-10-21): its time.
    requestDueAt: (anchor === 'deadline' ? input.deadline_at : input.due_at) ?? null,
    morningTime: ctx.morningTime,
    timezone,
  })
}

/** A new repeating task's dates and schedule (`occurrenceDates` for a deadline-anchored one). */
interface FirstDates {
  dueAt: string | null
  occurrenceAt: string | null
  deadlineAt: string | null
  auto: boolean
  relative: RelativeTarget | null
  /** The deadlines page's lead day (2026-10-22, `leadFor`), or null. */
  leadFrom: string | null
  /** The lead override (`lead_days`) — never on a reminder or a quota. */
  leadDays: number | null
}

/**
 * A NEW DEADLINE-ANCHORED REPEAT (2026-10-21, `repeat-schedule.ts`): the rule
 * walks the deadline. Its first occurrence is the deadline sent — or, already
 * past, the rule's next (`firstDueAt`, judged on the DEADLINE: A4) — and the
 * target is derived from it. A target derived already past while the deadline
 * is ahead is simply over target at birth (ruling Q10). A `target_at` sent
 * WITH the offsets is this first occurrence's moved target (capped at the
 * deadline); without them it gives the offsets (their inverse).
 */
function deadlineAnchoredDates(
  input: TaskCreateInput,
  rrule: string,
  ctx: TargetContext,
  timezone: string,
  lead: LeadContext,
  dayStart: string,
): FirstDates {
  const given = input.deadline_at!
  assertRuleOnDeadline(rrule, null, given, timezone)
  const first = firstDueAt(given, rrule, false, timezone, dayStart)!
  const sent =
    input.target_days_before !== undefined && input.target_time !== undefined
      ? { days_before: input.target_days_before, time: input.target_time }
      : null
  const relative = resolveRelativeTarget({
    sent,
    targetAt: sent ? null : (input.due_at ?? null),
    givenDeadline: given,
    rule: { rrule, recurrence_mode: input.recurrence_mode ?? 'from_due', anchor_time: null },
    firstDeadline: first,
    timezone,
    morningTime: ctx.morningTime,
    // The deadlines page (switch on, L1): no default relative target.
    leads: taskQueueEnabled(),
  })
  const recurrenceMode = input.recurrence_mode ?? 'from_due'
  // A lead override must be shorter than the rule's wait (`leadDaysProblem`)
  // — with a relative target too since the Upcoming split (2026-10-25): the
  // lead is then the Later day ahead of each occurrence's target.
  const leadProblem = leadDaysProblem(
    input.lead_days ?? null,
    { rrule, recurrence_mode: recurrenceMode, anchor_time: null },
    first,
    timezone,
  )
  if (leadProblem) throw new ValidationError(leadProblem)
  const dates = occurrenceDates(
    {
      rrule,
      repeat_anchor: 'deadline',
      target_days_before: relative?.days_before ?? null,
      target_time: relative?.time ?? null,
      lead_days: input.lead_days ?? null,
      recurrence_mode: recurrenceMode,
      anchor_time: null,
    },
    first,
    timezone,
    lead,
  )
  const dueAt = sent && input.due_at ? capAtDeadline(input.due_at, first) : dates.targetAt
  return {
    dueAt,
    occurrenceAt: first,
    deadlineAt: dates.deadlineAt,
    auto: false,
    relative,
    leadFrom: dates.leadFrom,
    leadDays: input.lead_days ?? null,
  }
}

/**
 * A new task's first date (a quota's is null, decided by the caller):
 * - a repeating task with no date → its first occurrence from now
 *   (`computeFirstOccurrence`, the creation day is day 0);
 * - a repeating task given a date already past (earlier today or any earlier
 *   day) → its next occurrence (`rollPassedFirstOccurrence`, 2026-10-16, the
 *   same ruling): weekly Fri 5 PM made Fri 8:30 PM → next Friday; the 15th of
 *   every month made on the 16th → next month's 15th. Not over target at birth.
 *   Not a reminder: today's occurrence, even past its slot, is still today's
 *   to consider on the Reminders screen (a missed one is not re-shown later);
 * - anything else → the date as given.
 * A quota never gets here: its rrule is a bare period rule ("FREQ=WEEKLY"),
 * which names the period the count runs over, not a day to occur on.
 */
function firstDueAt(
  given: string | null,
  rrule: string | null | undefined,
  isReminder: boolean,
  timezone: string,
  /** The user's day boundary: a rule with no date starts on the OpenTask day. */
  dayStart: string,
): string | null {
  if (!rrule) return given
  if (!given)
    return computeFirstOccurrence(rrule, null, timezone, new Date(), dayStart).toISOString()
  if (isReminder) return given
  const due = new Date(given)
  const first = rollPassedFirstOccurrence(rrule, due, timezone, new Date(), dayStart)
  return first.getTime() === due.getTime() ? given : first.toISOString()
}

/**
 * A new task's dates when its rule (if any) walks the TARGET: the first date
 * (`firstDueAt`), its scheduled occurrence (§6: the first date), and — §8,
 * 2026-10-12 — a deadline with no target gets the stored automatic one; a
 * target is never after the deadline (`resolveTarget` decides both). A
 * ONE-OFF created with offsets (relative targets, 2026-10-24) gets its
 * target DERIVED from its deadline (`relativeTargetAt`, through
 * `resolveTarget`): judged first by `assertOneOffRelative` (every 400).
 */
function targetAnchoredDates(
  input: TaskCreateInput,
  rrule: string | null | undefined,
  tracked: boolean,
  ctx: TargetContext,
  timezone: string,
  lead: LeadContext,
  dayStart: string,
): FirstDates {
  const dueAt = tracked
    ? null
    : firstDueAt(input.due_at ?? null, rrule, !!input.is_reminder, timezone, dayStart)
  const deadlineAt = tracked ? null : (input.deadline_at ?? null)
  assertRepeatLead(input, rrule, dueAt, tracked, timezone)
  const autoEligible = !rrule && !tracked && !input.is_reminder
  const relative = createRelative(input, rrule, !tracked && !input.is_reminder, deadlineAt, ctx)
  const target = resolveTarget(
    {
      dueAt,
      // A relative target is derived, never sent (ruling 7 refuses both).
      dueWritten: relative === null,
      wasAuto: false,
      deadlineAt,
      deadlineChanged: false,
      autoEligible,
      // The deadlines page (switch on): no automatic target; a lead day.
      leads: taskQueueEnabled(),
      ...(autoEligible ? { relative, relativeWritten: relative !== null } : {}),
    },
    ctx,
  )
  // A one-off's lead day (the deadlines page, 2026-10-22): written whenever
  // it has a deadline — dormant while it has a target.
  const leadFrom =
    rrule || tracked || input.is_reminder
      ? null
      : leadFor(
          { ...NO_SCHEDULE, deadline_at: input.deadline_at ?? null, lead_days: input.lead_days },
          timezone,
          lead,
        )
  return {
    dueAt: target.dueAt,
    occurrenceAt: rrule && !tracked ? dueAt : null,
    deadlineAt: input.deadline_at ?? null,
    auto: target.auto,
    relative: target.relative ?? null,
    leadFrom,
    leadDays: tracked || input.is_reminder ? null : (input.lead_days ?? null),
  }
}

/**
 * A target-anchored repeat's lead override (the Later day ahead of each
 * occurrence, 2026-10-25) must be shorter than its rule's wait, walked from
 * its first occurrence (`leadDaysProblem`, a 400). Nothing to judge on a
 * one-off, a quota, a reminder or a rule with no date.
 */
function assertRepeatLead(
  input: TaskCreateInput,
  rrule: string | null | undefined,
  first: string | null,
  tracked: boolean,
  timezone: string,
): void {
  if (!rrule || !first || tracked || input.is_reminder) return
  const problem = leadDaysProblem(
    input.lead_days ?? null,
    { rrule, recurrence_mode: input.recurrence_mode ?? 'from_due', anchor_time: null },
    first,
    timezone,
  )
  if (problem) throw new ValidationError(problem)
}

/**
 * A new ONE-OFF's relative target (2026-10-24): the offsets sent, after the
 * 400s (`assertOneOffRelative`), or null. A repeat's are `deadlineAnchoredDates`'.
 */
function createRelative(
  input: TaskCreateInput,
  rrule: string | null | undefined,
  ordinary: boolean,
  deadlineAt: string | null,
  ctx: TargetContext,
): RelativeTarget | null {
  // A reminder (given its default period's rule) or a quota: refused, never
  // dropped. A target-anchored repeat's are refused by `createAnchor`.
  if (!ordinary && sendsRelative(input)) throw new ValidationError(RELATIVE_KIND_MESSAGE)
  if (rrule) return null
  const stored = { target_days_before: null, target_time: null }
  const w = { stored, ordinary, deadlineAt, timezone: ctx.timezone }
  return assertOneOffRelative(input, w) ?? null
}

/** No relative target yet (a new row), for `linkAfter`. */
const NO_LINK = { target_slot_id: null, target_time: null }

/** A one-off's schedule fields, for `leadFor`. */
const NO_SCHEDULE = {
  rrule: null,
  repeat_anchor: null,
  target_days_before: null,
  target_time: null,
} as const

/**
 * Create a new task
 *
 * @returns The created task
 */
export function createTask(options: CreateTaskOptions): Task {
  const { userId, userTimezone } = options
  const db = getDb()
  // Relative targets (2026-10-24): a sent period sets the time first (the
  // creator's own periods — the creator is the owner).
  const linked = linkTargetTime(userId, options.input)
  // A quota declared with no rule gets its provisional period (2026-10-24).
  const input = withProvisionalQuotaRule(userId, linked.input, options.enrichment !== false)

  // Get user's inbox project if no project_id specified
  let projectId = input.project_id
  if (!projectId) {
    const inboxId = getInboxId(userId)
    if (inboxId === null) {
      throw new Error('User inbox project not found')
    }
    projectId = inboxId
  }

  // Validate project exists and user has access
  const project = db
    .prepare('SELECT id, owner_id, shared FROM projects WHERE id = ?')
    .get(projectId) as { id: number; owner_id: number; shared: number } | undefined
  if (!project) {
    throw new NotFoundError('Project not found')
  }
  if (project.owner_id !== userId && project.shared !== 1) {
    throw new ForbiddenError('Access denied to project')
  }

  // §5: a quota is not a task — it has no due date (see QUOTA_DUE_DATE_MESSAGE).
  // Asked of the row being created, not of one field: `progress_target > 1`
  // opts in by itself, `is_tracked` marks a quota whose target is 1.
  const tracked = isTracked({
    is_tracked: input.is_tracked ?? false,
    progress_target: input.progress_target ?? 1,
  })
  if (tracked) assertQuotaShape(input)

  // Judged on what the CALLER sent (`isTitleOnlyInput`), before the server's
  // defaults — the reminder slot below, a quota's provisional period above.
  const isTitleOnly = isTitleOnlyInput(linked.input)

  const targetCtx = getTargetContext(userId)
  // 2026-10-21: what the rule's instant is — the deadline when a rule comes
  // with one (`createAnchor`, the 400s that need no dates).
  const anchor = createAnchor(input, input.rrule, {
    isReminder: !!input.is_reminder,
    isTracked: tracked,
  })
  const rrule = timedSchedule(userId, input, tracked, targetCtx, userTimezone, anchor)
  const onDeckDay = input.on_deck_day ?? null
  if (onDeckDay) assertCreateDeck(input, onDeckDay, rrule, tracked, targetCtx, userId)

  const lead: LeadContext = { rolloverTime: rolloverTimeForUser(userId), now: new Date() }
  const dayStart = dayBoundaryForUser(userId)
  const first =
    anchor === 'deadline' && rrule
      ? deadlineAnchoredDates(input, rrule, targetCtx, userTimezone, lead, dayStart)
      : targetAnchoredDates(input, rrule, tracked, targetCtx, userTimezone, lead, dayStart)
  const dueAt = first.dueAt
  const relative = first.relative ?? { days_before: null, time: null }
  // Repeat ends (2026-10-22): judged against the first occurrence.
  assertCreateEnd(input, rrule, first.occurrenceAt, tracked, userTimezone, dayStart)

  // Derive anchor fields from rrule
  let anchorTime: string | null = null
  let anchorDow: number | null = null
  let anchorDom: number | null = null

  if (rrule) {
    const anchors = deriveAnchorFields(rrule, dueAt, userTimezone)
    anchorTime = anchors.anchor_time
    anchorDow = anchors.anchor_dow
    anchorDom = anchors.anchor_dom
  }

  const now = nowUtc()

  // If AI is enabled and the task is title-only (`isTitleOnly`, above), add the
  // ai-to-process trigger label.
  const taskLabels = [...(input.labels ?? [])]

  // §7.2: the registry gates labels the caller supplied. Check before the
  // machine-added labels below are appended — `ai-to-process` and the
  // provenance flags are ours, not the caller's, and holding them to the
  // "did you mean to create this?" rule would be nonsense.
  validateLabelsExist(userId, taskLabels, [], input.create_label === true)
  // The owner is the creator; nothing is stored yet, so every id is new.
  assertPromptSlotsOwned(userId, input.quota_prompt_config, null)

  // Provenance flags spare automated callers from typing behavior-bearing
  // labels as free text (§7.2).
  if (input.ai_proposed && !taskLabels.includes(PROVENANCE_LABELS.proposed)) {
    taskLabels.push(PROVENANCE_LABELS.proposed)
  }
  if (input.ai_added && !taskLabels.includes(PROVENANCE_LABELS.added)) {
    taskLabels.push(PROVENANCE_LABELS.added)
  }

  // `enrich` lets a caller opt in explicitly even when it sent structured
  // fields that disqualify it from title-only. (The Reminders quick add used to
  // need it for the schedule it sent; it now sends only the title and the
  // server's default slot does not count against title-only, but it still
  // sets `enrich` — harmless, and explicit about intent.)
  if (queuesEnrichment(options, isTitleOnly, input)) {
    taskLabels.push('ai-to-process')
  }
  const labelsJson = JSON.stringify(taskLabels)

  // Execute insert and undo log in a transaction
  const createdTask = withTransaction((tx) => {
    // Insert the task
    // Set original_due_at = due_at when creating with a due date, so the field
    // always tracks the "occurrence origin" timestamp (not just snooze state).
    const result = tx
      .prepare(
        `
      INSERT INTO tasks (
        user_id, project_id, title, original_title, short_title, done, priority, due_at, original_due_at,
        rrule, recurrence_mode, anchor_time, anchor_dow, anchor_dom,
        repeat_anchor, target_days_before, target_time, target_slot_id, repeat_count, repeat_until,
        auto_snooze_minutes, labels, notes, progress_target, is_reminder, is_tracked,
        quota_prompt_config, deadline_at, horizon, horizon_set_at, ${TARGET_SET_FIELD},
        target_auto, occurrence_at, progress_period_start, on_deck_day, lead_days, lead_from,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        userId,
        projectId,
        input.title,
        input.title, // original_title — preserve raw input for enrichment retry
        input.short_title ?? null,
        input.priority ?? 0,
        dueAt,
        dueAt, // original_due_at = due_at (null if no due date)
        rrule ?? null,
        input.recurrence_mode ?? 'from_due',
        anchorTime,
        anchorDow,
        anchorDom,
        anchor,
        relative.days_before,
        relative.time,
        linkAfter(NO_LINK, first.relative, linked.link),
        input.repeat_count ?? null,
        input.repeat_until ?? null,
        input.auto_snooze_minutes ?? null,
        labelsJson,
        input.notes ?? null,
        // §5: setting a target above 1 at creation is the whole opt-in gesture.
        input.progress_target ?? 1,
        input.is_reminder ? 1 : 0,
        input.is_tracked ? 1 : 0,
        // NULL unless the caller chose: "the defaults for its period" must stay
        // representable, so a YEARLY quota is off and a weekly one on without
        // anything being baked in at creation.
        input.quota_prompt_config ? JSON.stringify(input.quota_prompt_config) : null,
        first.deadlineAt,
        input.horizon ?? null,
        input.horizon ? now : null,
        // Upcoming (2026-10-12): a new task's target, if any, was set as it
        // was made — every task gets the stamp, so a later first target is
        // the only thing that moves it (src/core/tasks/target-set.ts).
        now,
        first.auto ? 1 : 0,
        first.occurrenceAt,
        // Interval quotas (2026-10-16): a quota's period is anchored as it is
        // made — this unit's start, in the owner's clock — not lazily by the
        // rollover's first pass (`quotaAnchorNow`).
        tracked ? quotaAnchorNow(userId, rrule) : null,
        // On deck (2026-10-20): checked by `assertCreateDeck` above.
        onDeckDay,
        // The deadlines page (2026-10-22): the override and the lead day.
        first.leadDays,
        first.leadFrom,
        now,
        now,
      )

    const taskId = Number(result.lastInsertRowid)

    // Fetch the created task
    const task = getTaskById(taskId)
    if (!task) {
      throw new Error('Failed to retrieve created task')
    }

    // Log to undo - for create, before_state is empty, after_state is the task
    // On undo, we'll soft-delete the task
    const snapshot = createTaskSnapshot(
      { id: taskId }, // before_state is essentially empty
      task,
      [
        'id',
        'title',
        'project_id',
        'due_at',
        'deadline_at',
        'horizon',
        'on_deck_day',
        'rrule',
        'repeat_count',
        'repeat_until',
        'priority',
        'labels',
        'notes',
      ],
    )

    logAction(userId, 'create', `Created "${input.title}"`, ['created'], [snapshot])

    logActivity({
      userId,
      taskId,
      action: 'create',
      fields: snapshot.after_state
        ? Object.keys(snapshot.after_state).filter((k) => k !== 'id')
        : [],
      after: snapshot.after_state,
    })

    // Increment daily stats
    incrementDailyStat(userId, 'tasks_created', userTimezone)

    return task
  })

  emitSyncEvent(userId)
  emitTaskCreatedEvent(userId, { taskId: createdTask.id, title: createdTask.title })
  syncBadgeIfBornOverdue(userId, createdTask)
  dispatchWebhookEvent(userId, 'task.created', {
    task: formatTaskResponse(createdTask, userTimezone),
  })

  return createdTask
}

/**
 * CREATE ON DECK (2026-10-20; docs/TASK-MODEL.md § On deck) — the same checks
 * as a deck write (`prepareDeck` in collect-field-changes.ts), on the row
 * being made: the task queue switch (409 off), never with a target (the
 * schema refuses it too), one-offs only, a calendar day today or later, and
 * the A1 rule against a deadline sent in the same body (its automatic target,
 * computed now, must be ahead and on a later day than the deck).
 */
function assertCreateDeck(
  input: TaskCreateInput,
  day: string,
  rrule: string | null | undefined,
  tracked: boolean,
  ctx: TargetContext,
  userId: number,
): void {
  if (!taskQueueEnabled()) {
    throw new AppError('On deck needs the task queue, which is off on this server', 409, 'CONFLICT')
  }
  if (input.due_at) {
    throw new ValidationError('A task is on deck or has a target, not both')
  }
  // One-offs only at creation, still (2026-10-20): a repeating task is decked
  // for its CURRENT occurrence, and a task being made has none yet — deck it
  // once it exists.
  const skip = rrule
    ? 'recurring'
    : deckSkip({ is_reminder: !!input.is_reminder, is_tracked: tracked })
  if (skip) throw new ValidationError(`Only a one-off task can go on deck (this is ${skip})`)
  const now = new Date()
  const problem = deckDayProblem(day, ctx.timezone, now, dayBoundaryForUser(userId))
  if (problem) throw new ValidationError(problem)
  // A1 (2026-10-22): the deck day at most the deadline's OpenTask day.
  const refusal = deckRefusal(
    { deadline_at: input.deadline_at ?? null },
    day,
    ctx,
    now,
    rolloverTimeForUser(userId),
  )
  if (refusal) throw new ValidationError(DECK_REFUSAL_MESSAGES[refusal])
}

/**
 * REPEAT ENDS on create (2026-10-22): the end sent, judged against the
 * FIRST occurrence (after a passed first date rolled on, `firstDueAt`);
 * the count starts at 0 used (`repeatEndProblem`, every 400).
 */
function assertCreateEnd(
  input: TaskCreateInput,
  rrule: string | null | undefined,
  firstOccurrence: string | null,
  tracked: boolean,
  timezone: string,
  dayStart: string,
): void {
  const count = input.repeat_count ?? null
  const until = input.repeat_until ?? null
  const problem = repeatEndProblem(
    {
      count,
      until,
      used: 0,
      countWritten: count !== null,
      untilWritten: until !== null,
      walkWritten: true,
      occurrenceAt: firstOccurrence,
      hasRule: !!rrule,
      isReminder: !!input.is_reminder,
      isTracked: tracked,
    },
    timezone,
    new Date(),
    dayStart,
  )
  if (problem) throw new ValidationError(REPEAT_END_MESSAGES[problem])
}

/**
 * A task created already overdue changes the app-icon badge now; without this
 * the badge would wait for the overdue checker's next run.
 */
function syncBadgeIfBornOverdue(userId: number, task: Task): void {
  if (task.due_at && new Date(task.due_at) < new Date()) syncBadgeCount(userId)
}
