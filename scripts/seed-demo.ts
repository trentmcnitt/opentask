/**
 * Demo user seed script for OpenTask
 *
 * Creates a demo user with curated portfolio-style tasks:
 * - "Try It" project: interactive onboarding for visitors
 * - "Client Work" project: skill-signaling professional tasks
 * - Inbox: CTA task
 * - Quotas (§5) and reminders (§6), so the Track panel, the dashboard's
 *   Reminders panel and the Reminders page are populated rather than empty —
 *   three of the most distinctive surfaces in the app read as broken when a
 *   visitor finds nothing in them.
 *
 * Does NOT touch other users. Safe to run on a production database.
 *
 * Usage: npm run db:seed-demo
 *
 * The seedDemoUser() function is also used by reset-demo-user.ts
 * to rebuild demo data on a cron (every 4 hours).
 */

import bcrypt from 'bcrypt'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { createLabel, seedSystemLabels } from '../src/core/labels'
import { seedDefaultTimeSlots } from '../src/core/time-slots'
import { getDb, closeDb } from '../src/core/db'
import { hashToken, tokenPreview } from '../src/core/auth/token-hash'
import { deriveAnchorFields } from '../src/core/recurrence/anchor-derivation'
import { RRulePatterns, parseRRule } from '../src/core/recurrence/rrule-builder'
import { localToUtcIso, daysUntilWeekday } from './seed-utils'
import type { LabelColor } from '../src/types'

const TIMEZONE = 'America/Chicago'
const SALT_ROUNDS = 10

// Day-of-week constants (0=Mon..6=Sun) used by RRulePatterns
const MON = 0,
  THU = 3,
  SUN = 6

// Priority constants
const UNSET = 0,
  LOW = 1,
  MED = 2,
  HIGH = 3

type ProjectName = 'Inbox' | 'Client Work' | 'Try It' | 'Personal'
type ProjectMap = Record<ProjectName, number>

interface DemoTaskDef {
  title: string
  project: ProjectName
  rrule?: string
  /** Days from today for due date. Ignored when noDue is true. */
  dueOffset?: number
  hour?: number
  min?: number
  priority?: number
  notes?: string
  done?: boolean
  /** When true, task appears in trash (soft-deleted) */
  deleted?: boolean
  /** When true, skip due date computation entirely (task has no due date) */
  noDue?: boolean
  /** How many days ago the task was created (for realistic created_at). Default: 3 */
  createdDaysAgo?: number
}

// ── Task definitions ──────────────────────────────────

function getDemoTasks(): DemoTaskDef[] {
  const TRY_IT_TASKS: DemoTaskDef[] = [
    {
      title: 'Swipe right to complete this task',
      project: 'Try It',
      dueOffset: 0,
      hour: 8,
      createdDaysAgo: 0,
    },
    {
      title: 'Swipe left to snooze this task',
      project: 'Try It',
      dueOffset: 0,
      hour: 8,
      createdDaysAgo: 0,
    },
    {
      title: 'Tap this task to edit it',
      project: 'Try It',
      noDue: true,
      createdDaysAgo: 0,
    },
    {
      title: 'Long-press a task to select and bulk-edit',
      project: 'Try It',
      noDue: true,
      createdDaysAgo: 0,
    },
    {
      title: 'Tap chips at the top of the Dashboard to easily filter tasks',
      project: 'Try It',
      noDue: true,
      createdDaysAgo: 0,
      notes:
        'Tap "Inbox" to only show that project, "Medium" to only show medium priority tasks, etc.',
    },
    {
      title: "Add a task — try 'Weekly standup every Monday at 10am'",
      project: 'Try It',
      noDue: true,
      createdDaysAgo: 0,
      notes:
        'Type or paste the text above into the task input. The AI parses natural language into structured tasks with due dates, recurrence, and priority.',
    },
  ]

  const PERSONAL_TASKS: DemoTaskDef[] = [
    {
      title: 'Go for a run',
      project: 'Personal',
      rrule: RRulePatterns.weekly([MON, THU], 7, 0),
      dueOffset: daysUntilWeekday([1, 4]), // next Mon or Thu, always future
      createdDaysAgo: 0,
    },
    {
      title: 'Try that new ramen place on 5th',
      project: 'Personal',
      noDue: true,
      createdDaysAgo: 0,
    },
    {
      title: 'Cancel that free trial before it charges',
      project: 'Personal',
      dueOffset: 2,
      hour: 20,
      priority: MED,
      createdDaysAgo: 0,
    },
    {
      title: 'Plan camping trip for Memorial Day weekend',
      project: 'Personal',
      dueOffset: 5,
      hour: 18,
      priority: LOW,
      createdDaysAgo: 0,
      notes: 'Check if the state park near the lake has open sites. Need to reserve soon.',
    },
  ]

  const CLIENT_WORK_TASKS: DemoTaskDef[] = [
    {
      title: 'Prepare implementation plan for client onboarding',
      project: 'Client Work',
      dueOffset: 1,
      hour: 10,
      priority: HIGH,
      createdDaysAgo: 0,
    },
    {
      title: 'Draft project scope for RAG pipeline integration',
      project: 'Client Work',
      noDue: true,
      priority: LOW,
      createdDaysAgo: 0,
      notes:
        'Vector database evaluation needed — Pinecone vs pgvector. Client processing ~50K docs. Start with proof of concept on a smaller subset.',
    },
    {
      title: 'Client status update',
      project: 'Client Work',
      rrule: RRulePatterns.weekly([MON, THU], 10, 0),
      dueOffset: daysUntilWeekday([1, 4]), // next Mon or Thu, always future
      priority: LOW,
      createdDaysAgo: 0,
    },
  ]

  const INBOX_TASKS: DemoTaskDef[] = [
    {
      title: 'Welcome to OpenTask — explore the demo!',
      project: 'Inbox',
      noDue: true,
      createdDaysAgo: 0,
      notes: [
        'Things to try:',
        '',
        '1. Add a task in natural language — try "Buy groceries tomorrow at 5pm" or "Call dentist next Monday, it\'s important" — AI extracts the date, priority, and cleans up the title automatically',
        '2. Tap the "What\'s Next" chip to let AI pick your most important task right now',
        '3. Tap "Insights" to see AI-powered signals like Quick Win, Stale, and Act Soon',
        '4. Check out the "Try It" project for tasks you can practice swiping, selecting, and filtering on',
        "5. Install OpenTask as an app — on mobile use Add to Home Screen, on desktop use your browser's install option (Chrome/Edge)",
      ].join('\n'),
    },
  ]

  const COMPLETED_TASKS: DemoTaskDef[] = [
    {
      title: 'Deploy staging environment for client demo',
      project: 'Client Work',
      done: true,
      dueOffset: -1,
      hour: 16,
      createdDaysAgo: 1,
    },
    {
      title: 'Book flights for conference',
      project: 'Personal',
      done: true,
      dueOffset: -3,
      hour: 12,
      createdDaysAgo: 3,
    },
    {
      title: 'Set up home office monitor arm',
      project: 'Personal',
      done: true,
      dueOffset: -5,
      hour: 18,
      createdDaysAgo: 5,
    },
  ]

  const DELETED_TASKS: DemoTaskDef[] = [
    {
      title: 'Research new phone plans',
      project: 'Personal',
      deleted: true,
      noDue: true,
      createdDaysAgo: 0,
    },
    {
      title: 'Sign up for pottery class',
      project: 'Personal',
      deleted: true,
      noDue: true,
      createdDaysAgo: 0,
    },
  ]

  return [
    ...TRY_IT_TASKS,
    ...PERSONAL_TASKS,
    ...CLIENT_WORK_TASKS,
    ...INBOX_TASKS,
    ...COMPLETED_TASKS,
    ...DELETED_TASKS,
  ]
}

// ── Quota definitions (Track, REDESIGN-V03 §5) ────────

/**
 * The labels quotas are filed under, with the colour each cluster is drawn in.
 *
 * Both the Track panel and the Quotas page group by label, so a quota with no
 * label lands in an "Other" pile — five labels over eight quotas gives those
 * surfaces something to actually group. The colours go into `label_config`,
 * which is where every label colour in the app comes from.
 *
 * NEVER GREEN: green already means "met" on a Track chip, so `trackStripeClass`
 * declines a green label and falls back to neutral (see `@/lib/track`).
 */
const QUOTA_LABELS: Record<string, LabelColor> = {
  focus: 'blue',
  health: 'orange',
  learning: 'purple',
  connection: 'pink',
  admin: 'gray',
}

/**
 * A quota's rule is a BARE PERIOD RULE — "FREQ=WEEKLY", no day and no hour. It
 * names the period a count runs over rather than an occurrence to land on
 * (`isPeriodRRule` in `@/core/recurrence/rrule-builder`; validation only lets a
 * tracked task carry one). `RRulePatterns` has no builder for it on purpose —
 * every pattern there produces a schedule, which is the opposite of what a
 * quota wants.
 */
const QUOTA_RRULE = { week: 'FREQ=WEEKLY', month: 'FREQ=MONTHLY' } as const

type QuotaPeriod = keyof typeof QUOTA_RRULE

/**
 * Where a quota sits against its target, as a state rather than a number.
 *
 * This seed re-runs every four hours, forever, so a hardcoded count would read
 * as "ahead" on Monday and "hopeless" on Friday. The count is derived from how
 * far through the period we actually are — see `quotaCurrent`.
 */
type QuotaState = 'on-pace' | 'behind' | 'met' | 'open'

interface DemoQuotaDef {
  title: string
  project: ProjectName
  label: keyof typeof QUOTA_LABELS
  period: QuotaPeriod
  /** How many times per period. 1 + `is_tracked` is the "once a month" case. */
  target: number
  state: QuotaState
  notes?: string
}

/**
 * Eight quotas over five labels, deliberately spread across every state the
 * Track panel can draw: on pace, behind, met (with §5's observable overflow),
 * and a target of one — the "date night, once a month" case the schema
 * describes, which is a quota only because `is_tracked` says so.
 *
 * At least one BEHIND quota counts within a month rather than a week, because
 * early in a period nothing can be behind: on a Monday morning a weekly quota
 * has no shortfall to show yet, whichever way it is going. A month is far
 * enough along, most days, to actually lag.
 */
const DEMO_QUOTAS: DemoQuotaDef[] = [
  {
    title: 'Deep work block, no meetings',
    project: 'Client Work',
    label: 'focus',
    period: 'week',
    target: 5,
    state: 'on-pace',
    notes:
      'Ninety minutes, calendar blocked, notifications off. Counts only if nothing interrupts.',
  },
  {
    title: 'Ship one small improvement',
    project: 'Client Work',
    label: 'focus',
    period: 'week',
    target: 3,
    state: 'behind',
  },
  {
    title: 'Strength training',
    project: 'Personal',
    label: 'health',
    period: 'week',
    target: 3,
    state: 'on-pace',
  },
  {
    title: 'Walk after lunch',
    project: 'Personal',
    label: 'health',
    period: 'week',
    target: 5,
    state: 'behind',
  },
  {
    title: 'Read something outside work',
    project: 'Personal',
    label: 'learning',
    period: 'week',
    target: 2,
    state: 'on-pace',
  },
  {
    title: 'Write up what I learned',
    project: 'Personal',
    label: 'learning',
    period: 'month',
    target: 2,
    state: 'met',
    notes:
      'A page is plenty. Writing it down is what turns a week of work into something reusable.',
  },
  {
    title: 'Coffee with someone outside the team',
    project: 'Client Work',
    label: 'connection',
    period: 'month',
    target: 3,
    state: 'behind',
    notes: 'Anyone whose work you do not already understand. Half an hour, no agenda.',
  },
  {
    title: 'Review the monthly numbers',
    project: 'Client Work',
    label: 'admin',
    period: 'month',
    target: 1,
    state: 'open',
    notes:
      'Once a month is the whole target — tracked so it is counted, not scheduled as a deadline.',
  },
]

// ── Reminder definitions (the Reminders surface, §6) ──

/**
 * A reminder is a prompted THOUGHT, not a chore: completing one means "I
 * considered it", and that is its whole completion (§6). It carries no debt —
 * a missed one is simply not re-shown until its next occurrence — so these are
 * written as questions and principles rather than as things to tick off.
 */
interface DemoReminderDef {
  title: string
  project: ProjectName
  /** Local time of day. Decides which time slot it lands in (§6.0). */
  hour: number
  min: number
  priority?: number
  notes?: string
  /**
   * Whether this one is usually considered once its moment has passed.
   *
   * The considered set is computed against the clock at seed time rather than
   * baked in: at 3pm the morning thoughts read as considered and the evening
   * ones as still waiting, which is what makes the slot bar show progress
   * instead of one flat state. A few are deliberately left waiting all day so
   * that a slot whose time has come still has something in it — that is the
   * bar's third state, and without it nothing ever wears the accent.
   */
  considerWhenPast?: boolean
  /** ISO-agnostic day (0=Mon..6=Sun) for a weekly reminder; daily when omitted. */
  dow?: number
}

/**
 * Thirteen daily reminders over five slots, in uneven counts (2 / 4 / 2 / 2 / 3)
 * because the day bar renders proportional segments and even counts make it
 * look like a placeholder. One weekly reminder sits on Sunday so the Reminders
 * page's "other days" section has something in it six days out of seven.
 */
const DEMO_REMINDERS: DemoReminderDef[] = [
  // Early morning (07:00)
  {
    title: 'Name the one thing that would make today count',
    project: 'Personal',
    hour: 7,
    min: 10,
    considerWhenPast: true,
    notes:
      'If everything else slides, this is the thing that still has to happen. Pick it before the day picks for you.',
  },
  {
    title: 'Move before the first screen',
    project: 'Personal',
    hour: 7,
    min: 40,
    considerWhenPast: true,
  },
  // Morning (09:00)
  {
    title: 'Hardest thing first — the inbox can wait',
    project: 'Client Work',
    hour: 9,
    min: 0,
    priority: HIGH,
    considerWhenPast: true,
    notes:
      'Attention is at its cheapest right now. Spend it on the thing you would otherwise avoid until 4pm.',
  },
  {
    title: 'Is this mine to do, or mine to hand off?',
    project: 'Client Work',
    hour: 9,
    min: 30,
    considerWhenPast: true,
  },
  {
    title: 'What is the client actually asking for?',
    project: 'Client Work',
    hour: 10,
    min: 15,
    notes:
      'The request and the need are rarely the same sentence. Restate it in your own words before building anything.',
  },
  {
    title: 'Say the hard thing early, while it is still small',
    project: 'Client Work',
    hour: 11,
    min: 15,
    considerWhenPast: true,
  },
  // Midday (12:00)
  {
    title: 'Eat away from the desk',
    project: 'Personal',
    hour: 12,
    min: 30,
    considerWhenPast: true,
  },
  {
    title: 'Half the day is gone — is the plan still the plan?',
    project: 'Client Work',
    hour: 14,
    min: 0,
    notes: 'If the morning changed things, change the afternoon on purpose rather than by drift.',
  },
  // Afternoon (16:00)
  {
    title: 'Leave tomorrow a note about where you stopped',
    project: 'Client Work',
    hour: 16,
    min: 30,
    considerWhenPast: true,
    notes:
      "Two lines is enough: what you were doing, and the next concrete move. You are buying tomorrow's first ten minutes.",
  },
  { title: 'Close the laptop — the day is allowed to end', project: 'Personal', hour: 17, min: 30 },
  // Evening (20:30)
  {
    title: 'What went well today? Name one thing',
    project: 'Personal',
    hour: 20,
    min: 45,
    considerWhenPast: true,
    notes:
      'Not a review and not a metric — one thing that worked. A day gets remembered the way it is rehearsed.',
  },
  {
    title: "Tomorrow's first move, decided tonight",
    project: 'Personal',
    hour: 21,
    min: 15,
    priority: MED,
  },
  {
    title: "Put tomorrow's worry down — it will still be there, and you'll be sharper",
    project: 'Personal',
    hour: 22,
    min: 0,
    considerWhenPast: true,
  },
  // Weekly — off-day on six days out of seven, so "other days" is never empty
  {
    title: 'Look at the week as a whole before it starts',
    project: 'Personal',
    hour: 20,
    min: 45,
    dow: SUN,
    notes: 'Where does the week already have no room? Decide now what gives, not on Wednesday.',
  },
]

interface SeededTask {
  id: number
  title: string
  done: boolean
  deleted: boolean
}

// ── Task seeding helper ─────────────────────

function seedDemoTasks(
  db: Database.Database,
  userId: number,
  projectMap: ProjectMap,
): SeededTask[] {
  const insertTask = db.prepare(`
    INSERT INTO tasks (
      user_id, project_id, title, done, done_at, priority, due_at,
      rrule, anchor_time, anchor_dow, anchor_dom,
      original_due_at, deleted_at, archived_at, labels, notes,
      completion_count, snooze_count, first_completed_at, last_completed_at,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?
    )
  `)

  const now = DateTime.utc().toISO()!
  const tasks = getDemoTasks()
  const seededTasks: SeededTask[] = []

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    const projectId = projectMap[task.project]
    const priority = task.priority ?? UNSET
    const notes = task.notes ?? null

    // Due date computation
    let dueAt: string | null = null
    if (!task.noDue) {
      const offset = task.dueOffset ?? 0
      let h = task.hour ?? 9
      let m = task.min ?? 0
      if (task.rrule && task.hour === undefined) {
        const components = parseRRule(task.rrule)
        if (components.byhour !== undefined) h = components.byhour
        if (components.byminute !== undefined) m = components.byminute
      }
      dueAt = localToUtcIso(offset, h, m)
    }

    const anchors = deriveAnchorFields(task.rrule ?? null, dueAt, TIMEZONE)

    const done = task.done ? 1 : 0
    const doneAt = task.done ? dueAt : null
    const archivedAt = task.done ? dueAt : null
    const deletedAt = task.deleted ? now : null
    const daysAgo = task.createdDaysAgo ?? 3
    const createdAt = daysAgo === 0 ? now : localToUtcIso(-daysAgo, 10, 0)

    const result = insertTask.run(
      userId,
      projectId,
      task.title,
      done,
      doneAt,
      priority,
      dueAt,
      task.rrule ?? null,
      anchors.anchor_time,
      anchors.anchor_dow,
      anchors.anchor_dom,
      dueAt, // original_due_at — matches createTask() behavior
      deletedAt,
      archivedAt,
      '[]', // labels
      notes,
      0, // completion_count
      0, // snooze_count
      null, // first_completed_at
      null, // last_completed_at
      createdAt,
      now,
    )

    seededTasks.push({
      id: Number(result.lastInsertRowid),
      title: task.title,
      done: !!task.done,
      deleted: !!task.deleted,
    })
  }

  return seededTasks
}

// ── Quota seeding helper ────────────────────

/**
 * Where the current period started, and how far through it we are.
 *
 * The start MUST match `unitStart()` in `src/core/tasks/period-rollover.ts`
 * exactly — the rollover cron compares `progress_period_start` against the
 * start of the calendar unit by the user's clock, so an anchor that disagrees
 * would make the job close a period the moment it next runs, wiping the
 * curated counts minutes after a reset.
 */
function quotaPeriodBounds(
  period: QuotaPeriod,
  now: DateTime,
): { startIso: string; elapsed: number } {
  const start = period === 'week' ? now.startOf('week') : now.startOf('month')
  const end = period === 'week' ? start.plus({ weeks: 1 }) : start.plus({ months: 1 })
  const elapsed = (now.toMillis() - start.toMillis()) / (end.toMillis() - start.toMillis())
  return { startIso: start.toUTC().toISO()!, elapsed }
}

/**
 * The count a quota should be showing right now, from its state and how far
 * through the period we are.
 *
 * The thresholds mirror `computePace` in `src/core/tasks/progress.ts`, which
 * calls a quota behind when `current + 1 <= target * periodElapsed`:
 * - on-pace clears that comparison with one in hand, and stays below target;
 * - behind sits one under what the elapsed time expects.
 *
 * `behind` keeps a FLOOR OF ONE, which is the one place this bends away from
 * the pace maths. Early in a period the shortfall it wants to show does not
 * exist yet — the expectation is still below 1, so nothing is behind on a
 * Monday morning however you count it — and the unbent formula put a bare 0/5
 * chip on the panel for the first day or two of every week. An empty chip is
 * the very thing this seed exists to prevent, and one logged on Monday is the
 * more believable state anyway. By midweek the shortfall is real and the chip
 * reads behind on its own.
 */
function quotaCurrent(def: DemoQuotaDef, elapsed: number): number {
  switch (def.state) {
    case 'met':
      // Past halfway, one extra shows §5's observable overflow — a met quota
      // reads 3/2 rather than vanishing. Before halfway an overflowing count
      // would just look implausible.
      return def.target + (elapsed > 0.5 ? 1 : 0)
    case 'on-pace':
      return Math.min(def.target - 1, Math.round(def.target * elapsed) + 1)
    case 'behind':
      return Math.max(1, Math.floor(def.target * elapsed) - 1)
    case 'open':
      return 0
  }
}

/**
 * Quotas, with a real `progress_events` row behind every point of every count.
 *
 * A bare integer in `progress_current` would render identically today and be a
 * lie the moment anything reads the log — the events are what the count is
 * made of. They are spread evenly across the part of the period that has
 * already happened, so none is stamped in the future.
 *
 * Note what a quota does NOT get: a due date. §5 — "a quota is not a task" —
 * and the core rejects one outright; the period is carried by the rrule's FREQ
 * and by `progress_period_start`.
 */
function seedDemoQuotas(db: Database.Database, userId: number, projectMap: ProjectMap): number {
  const insertQuota = db.prepare(`
    INSERT INTO tasks (
      user_id, project_id, title, priority, due_at, rrule,
      anchor_time, anchor_dow, anchor_dom, labels, notes,
      progress_target, progress_current, progress_period_start, is_tracked,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `)
  const insertEvent = db.prepare(
    'INSERT INTO progress_events (task_id, user_id, delta, logged_at) VALUES (?, ?, 1, ?)',
  )

  const nowUtc = DateTime.utc().toISO()!
  const nowLocal = DateTime.now().setZone(TIMEZONE)

  for (const def of DEMO_QUOTAS) {
    const rrule = QUOTA_RRULE[def.period]
    const { startIso, elapsed } = quotaPeriodBounds(def.period, nowLocal)
    const current = quotaCurrent(def, elapsed)
    // A bare period rule carries no BYHOUR and no BYDAY, so every anchor comes
    // back null — which is right: a quota has no time of day to be at.
    const anchors = deriveAnchorFields(rrule, null, TIMEZONE)
    // Two months back, so a monthly quota's current period always began well
    // after the quota itself existed.
    const createdAt = localToUtcIso(-60, 9, 0)

    const result = insertQuota.run(
      userId,
      projectMap[def.project],
      def.title,
      UNSET,
      rrule,
      anchors.anchor_time,
      anchors.anchor_dow,
      anchors.anchor_dom,
      JSON.stringify([def.label]),
      def.notes ?? null,
      def.target,
      current,
      startIso,
      createdAt,
      nowUtc,
    )

    const taskId = Number(result.lastInsertRowid)
    const periodStart = DateTime.fromISO(startIso, { zone: 'utc' }).toMillis()
    const span = nowLocal.toMillis() - periodStart
    for (let i = 0; i < current; i++) {
      // Evenly through the elapsed part of the period: with 3 logged that is
      // a quarter, a half and three quarters of the way to now.
      const at = periodStart + (span * (i + 1)) / (current + 1)
      insertEvent.run(taskId, userId, DateTime.fromMillis(at, { zone: 'utc' }).toISO()!)
    }
  }

  return DEMO_QUOTAS.length
}

// ── Reminder seeding helper ─────────────────

/**
 * Reminders, some already considered today.
 *
 * WHICH ONES ARE CONSIDERED IS DECIDED AGAINST THE CLOCK, not baked in. A
 * reminder marked `considerWhenPast` is completed shortly after its moment
 * passes, so a visitor at 3pm sees the morning thoughts behind the counter and
 * the evening ones still waiting — the day bar reads as progress rather than as
 * one flat state. The demo re-seeds every four hours, so the considered set is
 * never more than that stale.
 *
 * A CONSIDERED RECURRING REMINDER IS NOT `done`. Completing one advances it to
 * its next occurrence and leaves `last_completed_at` behind; `done = 1` would
 * retire the thought permanently. Today-ness comes from the schedule (§4.6),
 * and `getConsideredToday` finds these by their completion falling on today's
 * local date — which is why `due_at` moves to tomorrow while `anchor_time`
 * stays put and keeps the row in the slot it belongs to.
 */
function seedDemoReminders(db: Database.Database, userId: number, projectMap: ProjectMap): number {
  const insertReminder = db.prepare(`
    INSERT INTO tasks (
      user_id, project_id, title, priority, due_at, rrule,
      anchor_time, anchor_dow, anchor_dom, original_due_at, labels, notes,
      is_reminder, completion_count, first_completed_at, last_completed_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 1, ?, ?, ?, ?, ?)
  `)

  /**
   * Completing a recurring task writes a `completions` row remembering the due
   * date it advanced FROM and TO, and put-back reads that row back:
   * `putBackLatestOccurrence` throws "Nothing to put back" without one, and
   * throws again if the task's `due_at` no longer equals `due_at_next`. Undo is
   * offered on every considered reminder (`RemindersView`, and the dashboard
   * panel), so a considered row seeded without this looks perfectly right and
   * then fails the moment a visitor tries to take it back. Written here exactly
   * as `executeRecurringMarkDone` writes it.
   */
  const insertCompletion = db.prepare(`
    INSERT INTO completions (task_id, user_id, completed_at, due_at_was, due_at_next)
    VALUES (?, ?, ?, ?, ?)
  `)

  const nowUtc = DateTime.utc().toISO()!
  const nowLocal = DateTime.now().setZone(TIMEZONE)
  let considered = 0

  DEMO_REMINDERS.forEach((def, index) => {
    const rrule =
      def.dow === undefined
        ? RRulePatterns.daily(def.hour, def.min)
        : RRulePatterns.weekly([def.dow], def.hour, def.min)

    // When it was considered, if it has been: a plausible few minutes after the
    // moment itself, varied per reminder so the completions aren't a rank of
    // identical timestamps. A weekly reminder is left alone — its occurrence is
    // not today six days out of seven.
    const moment = nowLocal.set({ hour: def.hour, minute: def.min, second: 0, millisecond: 0 })
    const consideredAt = moment.plus({ minutes: 9 + ((index * 7) % 31) })
    const isConsidered =
      def.considerWhenPast === true && def.dow === undefined && consideredAt < nowLocal

    // EVERY DATE HERE HAS TO BE ONE THIS REMINDER'S OWN RULE COULD PRODUCE.
    // A daily thought can land on the day the seed happens to run; a weekly one
    // cannot, and six days out of seven "today" is the wrong weekday for it.
    // So the weekly reminder's dates are measured from its own occurrences —
    // which also keeps `deriveAnchorFields` honest, since it reads the weekday
    // back off `due_at`.
    const weeklyIn = def.dow === undefined ? null : daysUntilWeekday(def.dow + 1, 0, TIMEZONE)

    // Considered ones point at tomorrow's occurrence, exactly as completing one
    // would leave them; the rest are due at their next one.
    const dueAt = localToUtcIso(isConsidered ? 1 : (weeklyIn ?? 0), def.hour, def.min)
    const anchors = deriveAnchorFields(rrule, dueAt, TIMEZONE)

    // A thought in rotation for weeks has a history behind it — but no more of
    // one than its cadence allows. A weekly rule cannot have fired 30 times in
    // the 45 days its first completion claims; it gets one per week instead.
    // For the daily ones left waiting all day, the previous completion is a few
    // days back rather than yesterday: those are the thoughts this demo user
    // tends to pass over, and "considered yesterday" would contradict the fact
    // that it is still sitting there now.
    const historyWeeks = 6
    const lastOccurrenceIn = weeklyIn !== null ? weeklyIn - 7 : null
    const completionCount = weeklyIn !== null ? historyWeeks + 1 : 11 + ((index * 5) % 23)
    const firstCompletedIn = lastOccurrenceIn !== null ? lastOccurrenceIn - historyWeeks * 7 : -45
    const previousDaysBack = def.considerWhenPast === true ? 1 : 3
    const lastCompletedAt = isConsidered
      ? consideredAt.toUTC().toISO()!
      : localToUtcIso(lastOccurrenceIn ?? -previousDaysBack, def.hour, def.min)

    const inserted = insertReminder.run(
      userId,
      projectMap[def.project],
      def.title,
      def.priority ?? UNSET,
      dueAt,
      rrule,
      anchors.anchor_time,
      anchors.anchor_dow,
      anchors.anchor_dom,
      dueAt, // original_due_at — matches createTask() behavior
      def.notes ?? null,
      completionCount,
      localToUtcIso(firstCompletedIn, def.hour, def.min), // first_completed_at
      lastCompletedAt,
      // Created BEFORE its first completion, whatever time of day it fires at:
      // an 07:10 thought first considered 45 days ago cannot have been made at
      // 09:00 that same morning.
      localToUtcIso(-60, 8, 0),
      nowUtc,
    )

    if (isConsidered) {
      insertCompletion.run(
        Number(inserted.lastInsertRowid),
        userId,
        lastCompletedAt,
        localToUtcIso(0, def.hour, def.min), // due_at_was — today's occurrence
        dueAt, // due_at_next — exactly what the row now carries, or put-back refuses
      )
      considered++
    }
  })

  return considered
}

// ── Pre-baked AI data ─────────────────────────
// Curated insights and What's Next results so the demo user sees AI features
// immediately without triggering real AI generation.

/** Curated insights keyed by task title → { score, signals, commentary } */
const DEMO_INSIGHTS: Record<string, { score: number; signals: string[]; commentary: string }> = {
  'Prepare implementation plan for client onboarding': {
    score: 88,
    signals: ['act_soon'],
    commentary: 'Due soon with high priority — prepare before the deadline',
  },
  'Cancel that free trial before it charges': {
    score: 75,
    signals: ['review'],
    commentary: 'Medium priority with a real cost if missed — worth prioritizing',
  },
  'Draft project scope for RAG pipeline integration': {
    score: 60,
    signals: ['vague'],
    commentary: 'No due date and scope is undefined — clarify requirements',
  },
  'Client status update': {
    score: 52,
    signals: [],
    commentary: 'Recurring check-in, handle when it comes up',
  },
  'Plan camping trip for Memorial Day weekend': {
    score: 45,
    signals: [],
    commentary: 'Low priority but has a due date — keep it on radar',
  },
  'Go for a run': {
    score: 30,
    signals: [],
    commentary: 'Recurring habit — low urgency, just stay consistent',
  },
  'Try that new ramen place on 5th': {
    score: 15,
    signals: ['quick_win'],
    commentary: 'Fun low-effort task with no deadline pressure',
  },
  'Welcome to OpenTask — explore the demo!': {
    score: 10,
    signals: [],
    commentary: 'Informational — no action needed',
  },
}

/** Fallback insights for Try It tasks (low scores, no signals) */
const TRY_IT_INSIGHT = {
  score: 6,
  signals: [] as string[],
  commentary: 'Onboarding step — complete at your own pace',
}

/** Titles for What's Next picks (top 3 from insights) */
const WHATS_NEXT_PICKS: { title: string; reason: string }[] = [
  {
    title: 'Prepare implementation plan for client onboarding',
    reason: 'High priority and due tomorrow — the most time-sensitive task on your list',
  },
  {
    title: 'Cancel that free trial before it charges',
    reason: 'Real cost if missed — quick action to avoid an unwanted charge',
  },
  {
    title: 'Draft project scope for RAG pipeline integration',
    reason: "No due date but important client work — good to make progress while it's fresh",
  },
]

function seedDemoInsights(db: Database.Database, userId: number, tasks: SeededTask[]): void {
  const now = DateTime.utc().toISO()!
  const stmt = db.prepare(
    `INSERT INTO ai_insights_results (user_id, task_id, score, commentary, signals, generated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )

  const activeTasks = tasks.filter((t) => !t.done && !t.deleted)
  for (const task of activeTasks) {
    const insight = DEMO_INSIGHTS[task.title] ?? TRY_IT_INSIGHT
    const signals = insight.signals.length > 0 ? JSON.stringify(insight.signals) : null
    stmt.run(userId, task.id, insight.score, insight.commentary, signals, now)
  }
  console.log(`  Pre-baked insights for ${activeTasks.length} tasks`)
}

function seedDemoWhatsNext(db: Database.Database, userId: number, tasks: SeededTask[]): void {
  const now = DateTime.utc().toISO()!
  const tasksByTitle = new Map(tasks.map((t) => [t.title, t]))

  const whatsNextTasks = WHATS_NEXT_PICKS.map((pick) => {
    const task = tasksByTitle.get(pick.title)
    if (!task) throw new Error(`What's Next pick not found: "${pick.title}"`)
    return { task_id: task.id, reason: pick.reason }
  })

  const output = JSON.stringify({
    tasks: whatsNextTasks,
    summary: "Here's what needs attention today",
    generated_at: now,
  })

  db.prepare(
    `INSERT INTO ai_activity_log (user_id, task_id, action, status, input, output, model, duration_ms, provider, created_at)
     VALUES (?, NULL, 'whats_next', 'success', ?, ?, 'demo', 0, 'prebaked', ?)`,
  ).run(userId, `${tasks.filter((t) => !t.done && !t.deleted).length} tasks`, output, now)

  console.log(`  Pre-baked What's Next with ${whatsNextTasks.length} picks`)
}

// ── Exported seed functions ─────────────────

export interface SeedDemoOptions {
  username?: string
  password?: string
  email?: string
}

/**
 * Seed projects, API token, and tasks for an existing user.
 * Used by reset-demo-user.ts to re-seed data without recreating the user row
 * (preserving the user ID so JWT sessions stay valid).
 */
export function seedDemoData(
  db: Database.Database,
  userId: number,
  username: string = 'demo',
): void {
  // Create projects
  const insertProject = db.prepare(
    `INSERT INTO projects (name, owner_id, shared, sort_order, color) VALUES (?, ?, 0, ?, ?)`,
  )
  const projects: { name: ProjectName; order: number; color: string }[] = [
    { name: 'Inbox', order: 0, color: 'blue' },
    { name: 'Try It', order: 1, color: 'green' },
    { name: 'Personal', order: 2, color: 'purple' },
    { name: 'Client Work', order: 3, color: 'orange' },
  ]

  const projectMap = {} as ProjectMap
  for (const p of projects) {
    const result = insertProject.run(p.name, userId, p.order, p.color)
    projectMap[p.name] = Number(result.lastInsertRowid)
    console.log(`  Project: ${p.name} (ID: ${result.lastInsertRowid})`)
  }

  // Create API token
  const rawToken = `${username}-token-` + '0'.repeat(64 - username.length - 7)
  const hashed = hashToken(rawToken)
  const preview = tokenPreview(rawToken)
  db.prepare(
    `INSERT INTO api_tokens (user_id, token, token_preview, name) VALUES (?, ?, ?, ?)`,
  ).run(userId, hashed, preview, `${username} Token`)
  console.log(`  API token created`)

  // Set priority display preferences
  const priorityDisplay = JSON.stringify({
    trailingDot: true,
    badgeStyle: 'icons',
    colorTitle: false,
    rightBorder: false,
    colorCheckbox: false,
  })
  db.prepare('UPDATE users SET priority_display = ? WHERE id = ?').run(priorityDisplay, userId)
  console.log(`  Priority display configured`)

  // Ensure AI features use API mode (not SDK) so the demo works with the server's
  // configured API provider (e.g., xAI/Grok) without requiring Claude Code installed.
  db.prepare(
    `UPDATE users SET ai_mode = 'on', ai_enrichment_mode = 'api',
     ai_quicktake_mode = 'api', ai_whats_next_mode = 'api', ai_insights_mode = 'api'
     WHERE id = ?`,
  ).run(userId)
  console.log(`  AI features set to API mode`)

  // Register the labels the quotas are filed under, and colour them.
  //
  // Here rather than in seedDemoUser() because a reset re-runs only this
  // function — and it never deletes the `labels` rows, so both calls have to
  // be idempotent. createLabel() returns the existing row for a name it
  // already has, and label_config is an overwrite.
  for (const name of Object.keys(QUOTA_LABELS)) createLabel(userId, name)
  const labelConfig = Object.entries(QUOTA_LABELS).map(([name, color]) => ({ name, color }))
  db.prepare('UPDATE users SET label_config = ? WHERE id = ?').run(
    JSON.stringify(labelConfig),
    userId,
  )
  console.log(`  Registered ${labelConfig.length} quota labels`)

  // Seed tasks
  const seededTasks = seedDemoTasks(db, userId, projectMap)
  console.log(`  Inserted ${seededTasks.length} tasks`)

  // Quotas (§5) and reminders (§6). Deliberately NOT part of `seededTasks`:
  // they are not tasks, they never appear in the dashboard's lists, and giving
  // them a pre-baked insight would hang "Onboarding step — complete at your
  // own pace" off a quota.
  const quotaCount = seedDemoQuotas(db, userId, projectMap)
  console.log(`  Inserted ${quotaCount} quotas`)
  const consideredCount = seedDemoReminders(db, userId, projectMap)
  console.log(
    `  Inserted ${DEMO_REMINDERS.length} reminders (${consideredCount} already considered today)`,
  )

  // Pre-bake AI data so demo user sees insights and What's Next without triggering AI
  seedDemoInsights(db, userId, seededTasks)
  seedDemoWhatsNext(db, userId, seededTasks)
}

/**
 * Seed a complete demo user (user row + data) into the database.
 * Used for initial creation. For daily resets, use seedDemoData() instead.
 *
 * @returns The user's ID
 */
export async function seedDemoUser(
  db: Database.Database,
  options: SeedDemoOptions = {},
): Promise<number> {
  const username = options.username ?? 'demo'
  const password = options.password ?? username
  const email = options.email ?? `${username}@opentask.app`

  // Create user
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
  const userResult = db
    .prepare(
      `INSERT INTO users (email, name, password_hash, timezone, notifications_enabled, is_demo)
       VALUES (?, ?, ?, ?, ?, 1)`,
    )
    .run(email, username, passwordHash, TIMEZONE, 0)
  const userId = Number(userResult.lastInsertRowid)
  console.log(`  User "${username}" created (ID: ${userId})`)

  // Register the system label vocabulary (§7.2)
  seedSystemLabels(userId)
  seedDefaultTimeSlots(userId)

  seedDemoData(db, userId, username)

  return userId
}

// ── CLI entrypoint ──────────────────────────

async function main(): Promise<void> {
  console.log('Seeding demo user...')
  const db = getDb()

  const existing = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get('demo') as
    | { id: number }
    | undefined

  if (existing) {
    console.error('Demo user already exists (ID: ' + existing.id + '). Use db:reset-demo instead.')
    closeDb()
    process.exit(1)
  }

  await seedDemoUser(db)

  const taskCount = (
    db
      .prepare(
        'SELECT COUNT(*) as c FROM tasks WHERE user_id = (SELECT id FROM users WHERE name = ?)',
      )
      .get('demo') as { c: number }
  ).c
  console.log(`\nDemo seed complete! ${taskCount} tasks created.`)

  closeDb()
}

// Only run main() when executed directly (not when imported by reset-demo-user.ts)
const isDirectRun =
  process.argv[1]?.endsWith('seed-demo.ts') || process.argv[1]?.endsWith('seed-demo.js')
if (isDirectRun) {
  main().catch((err) => {
    console.error('Demo seed failed:', err)
    process.exit(1)
  })
}
