/**
 * Screenshot sample account — a fresh, throwaway database with one user whose
 * data covers every surface the product screenshots show.
 *
 *   OPENTASK_SCREENSHOT_NOW=2026-09-15T09:41:00-05:00 TZ=America/Chicago \
 *   NODE_OPTIONS="--require ./scripts/screenshots/freeze-clock.cjs" \
 *   OPENTASK_DB_PATH=.tmp/screenshots/<run>/screenshots.db \
 *     npx tsx scripts/screenshots/seed.ts
 *
 * Normally run by scripts/screenshots/run.sh (see docs/SCREENSHOTS.md).
 *
 * EVERYTHING IS RELATIVE TO THE FROZEN CLOCK. The preload shifts Date so "now"
 * is OPENTASK_SCREENSHOT_NOW, and every date below is an offset from it — so
 * two runs produce the same account, and the server (started under the same
 * preload) sees the same day. Refuses to run without it: a seed against the
 * real clock would drift from the captures.
 *
 * All data is invented and generic (this repo is public): a professional's
 * tasks, reminders and quotas. No real account's titles belong here.
 *
 * Shape borrowed from scripts/seed-demo.ts (raw inserts, reminders with
 * completion rows, quotas with progress events, pre-baked AI data); not
 * imported from it, because the demo's content is written for a visitor
 * poking at a live demo, and this one is written for a still picture.
 */

import fs from 'node:fs'
import path from 'node:path'
import bcrypt from 'bcrypt'
import type Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { getDb, closeDb } from '../../src/core/db'
import { createLabel, seedSystemLabels } from '../../src/core/labels'
import { seedDefaultTimeSlots } from '../../src/core/time-slots'
import { hashToken, tokenPreview } from '../../src/core/auth/token-hash'
import { deriveAnchorFields } from '../../src/core/recurrence/anchor-derivation'
import { RRulePatterns } from '../../src/core/recurrence/rrule-builder'
import { localToUtc } from '../../src/core/recurrence/timezone'
import { startOfWeek, WEEK_START_DEFAULT } from '../../src/lib/week-start'
import type { LabelColor } from '../../src/types'
import { SCREENSHOT_USER } from './account'

const TZ = SCREENSHOT_USER.timezone

// Day-of-week for RRulePatterns (0=Mon..6=Sun)
const MON = 0,
  TUE = 1,
  WED = 2,
  THU = 3,
  FRI = 4

// Priorities
const P_NONE = 0,
  P_LOW = 1,
  P_MED = 2,
  P_HIGH = 3,
  P_URGENT = 4

function now(): DateTime {
  return DateTime.now().setZone(TZ)
}

/** UTC ISO for a local wall-clock time `days` from today. */
function at(days: number, hour: number, minute = 0): string {
  return localToUtc(now().plus({ days }).set({ hour, minute, second: 0, millisecond: 0 }))
}

function minutesAgo(minutes: number): string {
  return now().minus({ minutes }).toUTC().toISO()!
}

// ── Projects and labels ──────────────────────────────

type ProjectName = 'Inbox' | 'Work' | 'Personal' | 'Home' | 'Finance'

const PROJECTS: { name: ProjectName; color: LabelColor }[] = [
  { name: 'Inbox', color: 'blue' },
  { name: 'Work', color: 'orange' },
  { name: 'Personal', color: 'purple' },
  { name: 'Home', color: 'green' },
  { name: 'Finance', color: 'pink' },
]

/** Labels on ordinary tasks and on quotas. Never green on a quota label (green = met). */
const LABELS: Record<string, LabelColor> = {
  calls: 'blue',
  errand: 'yellow',
  'deep-work': 'purple',
  quick: 'gray',
  health: 'orange',
  // Its own label so "Read for 30 minutes" (learning) leads Today's quotas:
  // the dashboard and the watch order a period's quotas by label, A–Z.
  mobility: 'orange',
  focus: 'blue',
  learning: 'purple',
  connection: 'pink',
}

// ── Tasks ─────────────────────────────────────────────

interface TaskDef {
  title: string
  project: ProjectName
  /** [days from today, hour, minute]; omitted = no due date. */
  due?: [number, number, number?]
  priority?: number
  labels?: string[]
  rrule?: string
  notes?: string
  /** Minutes before now it was created (default: some days back). */
  createdMinutesAgo?: number
  /** Completed earlier today (a one-off, done). */
  doneToday?: [number, number]
  insight?: { score: number; signals?: string[]; commentary: string }
}

const TASKS: TaskDef[] = [
  // Overdue
  {
    title: 'Submit August expense report',
    project: 'Work',
    due: [-1, 17],
    priority: P_MED,
    labels: ['quick'],
    insight: {
      score: 82,
      signals: ['act_soon'],
      commentary: 'A day late and it blocks reimbursement — ten minutes clears it',
    },
  },
  {
    title: 'Reply to the vendor about contract terms',
    project: 'Work',
    due: [0, 8, 30],
    priority: P_HIGH,
    labels: ['calls'],
    notes: 'They asked about the renewal clause and the payment schedule. Legal signed off Friday.',
    insight: {
      score: 88,
      signals: ['act_soon'],
      commentary: 'High priority and already past due — answer before the 11:00 call',
    },
  },
  {
    title: 'Renew car registration',
    project: 'Personal',
    due: [-3, 9],
    priority: P_LOW,
    labels: ['errand'],
    insight: {
      score: 64,
      signals: ['stale'],
      commentary: 'Snoozed three days running — the online form takes five minutes',
    },
  },

  // Today
  {
    title: 'File Q3 estimated taxes',
    project: 'Finance',
    due: [0, 16],
    priority: P_URGENT,
    notes: 'Use last quarter’s worksheet. Payment confirmation goes in the tax folder.',
    insight: {
      score: 95,
      signals: ['act_soon'],
      commentary: 'Hard deadline today — penalties start tomorrow',
    },
  },
  {
    title: 'Team standup',
    project: 'Work',
    due: [0, 10, 30],
    rrule: RRulePatterns.weekly([MON, TUE, WED, THU, FRI], 10, 30),
    insight: { score: 40, commentary: 'Daily routine — nothing to prepare' },
  },
  {
    title: 'Draft Q4 budget review',
    project: 'Work',
    due: [0, 14],
    priority: P_HIGH,
    labels: ['deep-work'],
    notes: 'Compare actuals against plan for Q3 and flag the three largest variances.',
    insight: {
      score: 79,
      signals: ['review'],
      commentary: 'Needs a focused block — the afternoon is still open',
    },
  },
  {
    title: 'Call the insurance company about the claim',
    project: 'Personal',
    due: [0, 15, 30],
    priority: P_MED,
    labels: ['calls'],
    insight: { score: 58, commentary: 'Phone lines close at 5 — call before the end of the day' },
  },
  {
    title: 'Pick up dry cleaning',
    project: 'Personal',
    due: [0, 17, 30],
    labels: ['errand'],
    notes: 'Ticket is in the glovebox.',
    insight: {
      score: 22,
      signals: ['quick_win'],
      commentary: 'On the way home — pairs with the grocery run',
    },
  },
  {
    title: 'Water the plants',
    project: 'Home',
    due: [0, 18, 30],
    rrule: 'FREQ=DAILY;INTERVAL=3;BYHOUR=18;BYMINUTE=30',
    insight: { score: 15, commentary: 'Every three days — low effort' },
  },

  // This week
  {
    title: 'Prepare slides for the quarterly review',
    project: 'Work',
    due: [2, 9],
    priority: P_HIGH,
    labels: ['deep-work'],
    insight: {
      score: 74,
      signals: ['act_soon'],
      commentary: 'Due Thursday morning — the budget draft feeds into it',
    },
  },
  {
    title: 'Renew passport',
    project: 'Personal',
    due: [3, 12],
    priority: P_MED,
    labels: ['errand'],
    notes: 'Photo, old passport and the form. Processing is 6–8 weeks.',
    insight: {
      score: 61,
      signals: ['act_soon'],
      commentary: 'Processing takes weeks — start before the trip gets close',
    },
  },
  {
    title: 'Cancel the unused streaming subscription',
    project: 'Finance',
    due: [2, 20],
    priority: P_LOW,
    labels: ['quick'],
    insight: {
      score: 47,
      signals: ['quick_win'],
      commentary: 'Renews Friday — two minutes saves the monthly charge',
    },
  },
  {
    title: 'Take out recycling',
    project: 'Home',
    due: [1, 19],
    rrule: RRulePatterns.weekly([WED], 19, 0),
    insight: { score: 18, commentary: 'Weekly chore, Wednesday night' },
  },
  {
    title: 'Schedule an oil change',
    project: 'Personal',
    due: [4, 10],
    labels: ['errand'],
    insight: { score: 30, commentary: 'Saturday morning slot is usually open' },
  },
  {
    title: 'Send thank-you notes after the offsite',
    project: 'Work',
    due: [1, 11],
    priority: P_LOW,
    insight: { score: 44, commentary: 'Best sent while the offsite is still fresh' },
  },
  {
    title: 'Weekly planning',
    project: 'Personal',
    due: [6, 8, 30],
    rrule: RRulePatterns.weekly([MON], 8, 30),
    insight: { score: 35, commentary: 'Recurring Monday review — keeps the week on track' },
  },
  {
    title: 'Pay the credit card bill',
    project: 'Finance',
    due: [5, 9],
    priority: P_MED,
    rrule: 'FREQ=MONTHLY;BYMONTHDAY=20;BYHOUR=9;BYMINUTE=0',
    insight: { score: 52, commentary: 'Autopay is off this month — pay by the 20th' },
  },
  {
    title: 'Back up the laptop',
    project: 'Home',
    due: [12, 20],
    rrule: 'FREQ=MONTHLY;BYMONTHDAY=27;BYHOUR=20;BYMINUTE=0',
    insight: { score: 20, commentary: 'Monthly routine — run it overnight' },
  },
  {
    title: 'Plan a weekend hike',
    project: 'Personal',
    due: [4, 9],
    priority: P_LOW,
    insight: { score: 26, commentary: 'Check the forecast Thursday' },
  },
  {
    title: 'Review pull requests for the billing service',
    project: 'Work',
    due: [1, 13],
    priority: P_MED,
    labels: ['deep-work'],
    insight: { score: 57, commentary: 'Two reviews are waiting on you' },
  },
  {
    title: 'Book a dentist cleaning',
    project: 'Personal',
    due: [7, 9],
    labels: ['calls'],
    insight: { score: 33, commentary: 'Six months since the last visit' },
  },

  // No due date
  {
    title: 'Research standing desks',
    project: 'Home',
    priority: P_LOW,
    notes: 'Budget around $500. Needs to fit the 55-inch alcove.',
    insight: {
      score: 12,
      signals: ['vague'],
      commentary: 'No date and no decision criteria yet — narrow it to three options',
    },
  },
  {
    title: 'Update resume with the last two projects',
    project: 'Personal',
    insight: {
      score: 28,
      signals: ['stale'],
      commentary: 'Sitting for weeks — an hour would do it',
    },
  },
  {
    title: 'Order printer ink',
    project: 'Home',
    labels: ['quick'],
    insight: { score: 17, signals: ['quick_win'], commentary: 'Two-minute order' },
  },
  {
    title: 'Set up a shared family calendar',
    project: 'Home',
    insight: { score: 21, signals: ['vague'], commentary: 'Pick one app first' },
  },
  {
    title: 'Outline the onboarding guide for new hires',
    project: 'Work',
    priority: P_MED,
    labels: ['deep-work'],
    insight: { score: 49, commentary: 'Two new starters next month — worth starting now' },
  },
  {
    title: 'Compare high-yield savings accounts',
    project: 'Finance',
    priority: P_LOW,
    insight: { score: 24, commentary: 'Rates changed last week' },
  },
  {
    title: 'Read the product strategy memo',
    project: 'Inbox',
    insight: { score: 38, commentary: 'Shared yesterday; the discussion is Thursday' },
  },
  {
    title: 'Try the new ramen place downtown',
    project: 'Inbox',
    insight: { score: 8, commentary: 'No pressure — a nice one for Friday' },
  },

  // Just added (the dashboard's "Just added" card: created in the last 10 minutes)
  {
    title: 'Book flights for the October conference',
    project: 'Personal',
    due: [3, 9],
    priority: P_MED,
    createdMinutesAgo: 2,
  },
  {
    title: 'Ask facilities about the broken badge reader',
    project: 'Work',
    due: [0, 13],
    createdMinutesAgo: 6,
  },

  // Done earlier today
  {
    title: 'Confirm the dentist appointment time',
    project: 'Personal',
    due: [0, 8],
    doneToday: [8, 12],
  },
  {
    title: 'Send the weekly status update',
    project: 'Work',
    due: [0, 9],
    priority: P_MED,
    doneToday: [9, 5],
  },
]

// ── Reminders (§6) ────────────────────────────────────

interface ReminderDef {
  title: string
  project: ProjectName
  hour: number
  min: number
  priority?: number
  notes?: string
  /** Considered today, if its moment has passed. */
  considered?: boolean
}

/**
 * Over the five default periods, in uneven counts. At the frozen 9:41 AM:
 * Early morning (07:00) is finished, Morning (09:00) is under way with one
 * considered, the rest haven't started — every state the period bar draws.
 */
const REMINDERS: ReminderDef[] = [
  // Early morning
  { title: 'Drink a glass of water', project: 'Personal', hour: 7, min: 0, considered: true },
  {
    title: 'Name the one thing that would make today count',
    project: 'Personal',
    hour: 7,
    min: 15,
    considered: true,
    notes: 'If everything else slides, this is the thing that still has to happen.',
  },
  { title: 'Take vitamins', project: 'Personal', hour: 7, min: 30, considered: true },
  // Morning
  {
    title: 'Check the calendar for today’s meetings',
    project: 'Work',
    hour: 9,
    min: 0,
    considered: true,
  },
  {
    title: 'Hardest thing first — the inbox can wait',
    project: 'Work',
    hour: 9,
    min: 15,
    priority: P_HIGH,
    notes: 'Attention is cheapest now. Spend it on the thing you would otherwise avoid.',
  },
  { title: 'Stand up and stretch', project: 'Personal', hour: 10, min: 30 },
  { title: 'Is this mine to do, or mine to hand off?', project: 'Work', hour: 11, min: 0 },
  // Midday
  { title: 'Eat lunch away from the desk', project: 'Personal', hour: 12, min: 30 },
  {
    title: 'Half the day is gone — is the plan still the plan?',
    project: 'Work',
    hour: 14,
    min: 0,
  },
  // Afternoon
  {
    title: 'Leave tomorrow a note about where you stopped',
    project: 'Work',
    hour: 16,
    min: 30,
    notes: 'Two lines: what you were doing, and the next concrete move.',
  },
  { title: 'Close the laptop — the day is allowed to end', project: 'Personal', hour: 17, min: 30 },
  // Evening
  { title: 'What went well today? Name one thing', project: 'Personal', hour: 20, min: 45 },
  { title: 'Lay out clothes for tomorrow', project: 'Home', hour: 21, min: 0 },
  { title: 'Phone on the charger, outside the bedroom', project: 'Home', hour: 21, min: 30 },
]

// ── Quotas (§5) ───────────────────────────────────────

type QuotaPeriod = 'day' | 'week' | 'month'
const QUOTA_RRULE: Record<QuotaPeriod, string> = {
  day: 'FREQ=DAILY',
  week: 'FREQ=WEEKLY',
  month: 'FREQ=MONTHLY',
}

interface QuotaDef {
  title: string
  project: ProjectName
  label: string
  period: QuotaPeriod
  target: number
  current: number
  notes?: string
  /**
   * The period (by label) its prompt shows in. Without one, every unmet
   * quota prompts in the user's default — the first period — and crowds it.
   */
  promptIn?: string
  /** Daily quotas: the period for prompt #1, #2, ... */
  promptNumbers?: string[]
}

/** Unmet quotas also surface as prompts in a reminder period (quota-prompts.ts). */
const QUOTAS: QuotaDef[] = [
  {
    title: 'Stretch for ten minutes',
    project: 'Personal',
    label: 'mobility',
    period: 'day',
    target: 2,
    current: 1,
    promptNumbers: ['Morning', 'Afternoon'],
  },
  {
    title: 'Read for 30 minutes',
    project: 'Personal',
    label: 'learning',
    period: 'day',
    target: 1,
    current: 0,
    promptIn: 'Evening',
  },
  {
    title: 'Deep work block, no meetings',
    project: 'Work',
    label: 'focus',
    period: 'week',
    target: 5,
    current: 2,
    notes: 'Ninety minutes, calendar blocked, notifications off.',
    promptIn: 'Morning',
  },
  {
    title: 'Workout',
    project: 'Personal',
    label: 'health',
    period: 'week',
    target: 3,
    current: 1,
    promptIn: 'Afternoon',
  },
  {
    title: 'Cook dinner at home',
    project: 'Home',
    label: 'health',
    period: 'week',
    target: 4,
    current: 4,
  },
  {
    title: 'Call a friend or family member',
    project: 'Personal',
    label: 'connection',
    period: 'month',
    target: 4,
    current: 2,
    promptIn: 'Midday',
  },
  {
    title: 'Write up what I learned',
    project: 'Work',
    label: 'learning',
    period: 'month',
    target: 2,
    current: 1,
    promptIn: 'Evening',
  },
  {
    title: 'Review the monthly budget',
    project: 'Finance',
    label: 'focus',
    period: 'month',
    target: 1,
    current: 1,
  },
]

// ── Seeding ──────────────────────────────────────────

function seedProjects(db: Database.Database, userId: number): Record<ProjectName, number> {
  const insert = db.prepare(
    'INSERT INTO projects (name, owner_id, shared, sort_order, color, created_at) VALUES (?, ?, 0, ?, ?, ?)',
  )
  const map = {} as Record<ProjectName, number>
  PROJECTS.forEach((p, i) => {
    map[p.name] = Number(insert.run(p.name, userId, i, p.color, at(-90, 9)).lastInsertRowid)
  })
  return map
}

function seedTasks(
  db: Database.Database,
  userId: number,
  projects: Record<ProjectName, number>,
): void {
  const insertTask = db.prepare(`
    INSERT INTO tasks (
      user_id, project_id, title, done, done_at, priority, due_at,
      rrule, anchor_time, anchor_dow, anchor_dom, original_due_at, archived_at,
      labels, notes, completion_count, last_completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertCompletion = db.prepare(
    'INSERT INTO completions (task_id, user_id, completed_at, due_at_was, due_at_next) VALUES (?, ?, ?, ?, NULL)',
  )
  const insertInsight = db.prepare(
    `INSERT INTO ai_insights_results (user_id, task_id, score, commentary, signals, generated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const generatedAt = at(0, 3, 30)

  TASKS.forEach((t, index) => {
    const dueAt = t.due ? at(t.due[0], t.due[1], t.due[2] ?? 0) : null
    const anchors = deriveAnchorFields(t.rrule ?? null, dueAt, TZ)
    const doneAt = t.doneToday ? at(0, t.doneToday[0], t.doneToday[1]) : null
    // Spread creation over the last few weeks, so Newest has a real order.
    const createdAt =
      t.createdMinutesAgo !== undefined
        ? minutesAgo(t.createdMinutesAgo)
        : at(-(2 + ((index * 5) % 26)), 8 + (index % 9), (index * 13) % 60)
    const result = insertTask.run(
      userId,
      projects[t.project],
      t.title,
      doneAt ? 1 : 0,
      doneAt,
      t.priority ?? P_NONE,
      dueAt,
      t.rrule ?? null,
      anchors.anchor_time,
      anchors.anchor_dow,
      anchors.anchor_dom,
      dueAt,
      doneAt,
      JSON.stringify(t.labels ?? []),
      t.notes ?? null,
      doneAt ? 1 : 0,
      doneAt,
      createdAt,
      createdAt,
    )
    const taskId = Number(result.lastInsertRowid)
    if (doneAt) insertCompletion.run(taskId, userId, doneAt, dueAt)
    if (t.insight) {
      insertInsight.run(
        userId,
        taskId,
        t.insight.score,
        t.insight.commentary,
        t.insight.signals?.length ? JSON.stringify(t.insight.signals) : null,
        generatedAt,
      )
    }
  })

  // What's Next: the top three by score, as the scheduled job would write it.
  const picks = TASKS.map((t) => ({ t }))
    .filter(({ t }) => t.insight && !t.doneToday)
    .sort((a, b) => b.t.insight!.score - a.t.insight!.score)
    .slice(0, 3)
  const ids = db.prepare('SELECT id, title FROM tasks WHERE user_id = ?').all(userId) as {
    id: number
    title: string
  }[]
  const idByTitle = new Map(ids.map((r) => [r.title, r.id]))
  const output = JSON.stringify({
    tasks: picks.map(({ t }) => ({
      task_id: idByTitle.get(t.title),
      reason: t.insight!.commentary,
    })),
    summary: 'Taxes are due today; the vendor reply and expense report are already late.',
    generated_at: generatedAt,
  })
  db.prepare(
    `INSERT INTO ai_activity_log (user_id, task_id, action, status, input, output, model, duration_ms, provider, created_at)
     VALUES (?, NULL, 'whats_next', 'success', ?, ?, 'screenshots', 0, 'prebaked', ?)`,
  ).run(userId, `${TASKS.length} tasks`, output, generatedAt)
}

function seedReminders(
  db: Database.Database,
  userId: number,
  projects: Record<ProjectName, number>,
): void {
  const insert = db.prepare(`
    INSERT INTO tasks (
      user_id, project_id, title, priority, due_at, rrule,
      anchor_time, anchor_dow, anchor_dom, original_due_at, labels, notes,
      is_reminder, completion_count, first_completed_at, last_completed_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 1, ?, ?, ?, ?, ?)
  `)
  // Put-back reads this row (see seed-demo.ts's seedDemoReminders).
  const insertCompletion = db.prepare(
    'INSERT INTO completions (task_id, user_id, completed_at, due_at_was, due_at_next) VALUES (?, ?, ?, ?, ?)',
  )
  REMINDERS.forEach((r, index) => {
    const rrule = RRulePatterns.daily(r.hour, r.min)
    const considered = r.considered === true
    const consideredAt = at(0, r.hour, r.min + 4 + (index % 5))
    const dueAt = at(considered ? 1 : 0, r.hour, r.min)
    const anchors = deriveAnchorFields(rrule, dueAt, TZ)
    const lastCompleted = considered ? consideredAt : at(-1, r.hour, r.min + 5)
    const inserted = insert.run(
      userId,
      projects[r.project],
      r.title,
      r.priority ?? P_NONE,
      dueAt,
      rrule,
      anchors.anchor_time,
      anchors.anchor_dow,
      anchors.anchor_dom,
      dueAt,
      r.notes ?? null,
      20 + index,
      at(-40, r.hour, r.min),
      lastCompleted,
      at(-45, 8),
      at(-45, 8),
    )
    if (considered) {
      insertCompletion.run(
        Number(inserted.lastInsertRowid),
        userId,
        consideredAt,
        at(0, r.hour, r.min),
        dueAt,
      )
    }
  })
}

function periodStart(period: QuotaPeriod): DateTime {
  const n = now()
  if (period === 'day') return n.startOf('day')
  if (period === 'week') return startOfWeek(n, WEEK_START_DEFAULT)
  return n.startOf('month')
}

function seedQuotas(
  db: Database.Database,
  userId: number,
  projects: Record<ProjectName, number>,
): void {
  const insert = db.prepare(`
    INSERT INTO tasks (
      user_id, project_id, title, priority, due_at, rrule,
      anchor_time, anchor_dow, anchor_dom, labels, notes,
      progress_target, progress_current, progress_period_start, is_tracked,
      quota_prompt_config, created_at, updated_at
    ) VALUES (?, ?, ?, 0, NULL, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `)
  const insertEvent = db.prepare(
    'INSERT INTO progress_events (task_id, user_id, delta, logged_at) VALUES (?, ?, 1, ?)',
  )
  const slots = db.prepare('SELECT id, label FROM time_slots WHERE user_id = ?').all(userId) as {
    id: number
    label: string
  }[]
  const slotId = (label: string): number => {
    const slot = slots.find((s) => s.label === label)
    if (!slot) throw new Error(`No period labelled "${label}"`)
    return slot.id
  }
  for (const q of QUOTAS) {
    const promptConfig = q.promptNumbers
      ? { numbers: Object.fromEntries(q.promptNumbers.map((l, i) => [String(i + 1), slotId(l)])) }
      : q.promptIn
        ? { slot_id: slotId(q.promptIn) }
        : null
    // Must equal period-rollover.ts's unitStart() for the frozen day, or the
    // rollover at server start closes the period and zeroes the count.
    const start = periodStart(q.period)
    const result = insert.run(
      userId,
      projects[q.project],
      q.title,
      QUOTA_RRULE[q.period],
      JSON.stringify([q.label]),
      q.notes ?? null,
      q.target,
      q.current,
      start.toUTC().toISO()!,
      promptConfig ? JSON.stringify(promptConfig) : null,
      at(-60, 9),
      at(-60, 9),
    )
    const id = Number(result.lastInsertRowid)
    const span = now().toMillis() - start.toMillis()
    for (let i = 0; i < q.current; i++) {
      const when = start.toMillis() + (span * (i + 1)) / (q.current + 1)
      insertEvent.run(id, userId, DateTime.fromMillis(when, { zone: 'utc' }).toISO()!)
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.OPENTASK_SCREENSHOT_NOW) {
    throw new Error(
      'OPENTASK_SCREENSHOT_NOW is not set — run this through scripts/screenshots/run.sh',
    )
  }
  const dbPath = process.env.OPENTASK_DB_PATH
  if (!dbPath) throw new Error('OPENTASK_DB_PATH is not set')
  // A fresh database every run.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true })

  const db = getDb()
  const u = SCREENSHOT_USER
  const userId = Number(
    db
      .prepare(
        `INSERT INTO users (email, name, password_hash, timezone, notifications_enabled, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(u.email, u.username, await bcrypt.hash(u.password, 10), u.timezone, at(-90, 9))
      .lastInsertRowid,
  )
  seedSystemLabels(userId)
  seedDefaultTimeSlots(userId)
  for (const name of Object.keys(LABELS)) createLabel(userId, name)
  db.prepare('UPDATE users SET label_config = ? WHERE id = ?').run(
    JSON.stringify(Object.entries(LABELS).map(([name, color]) => ({ name, color }))),
    userId,
  )
  // AI on, in API mode: run.sh points the API provider at a dead loopback
  // address, and the pre-baked results below are what the UI shows.
  db.prepare(
    `UPDATE users SET ai_mode = 'on', ai_enrichment_mode = 'api', ai_quicktake_mode = 'api',
       ai_whats_next_mode = 'api', ai_insights_mode = 'api' WHERE id = ?`,
  ).run(userId)
  db.prepare(
    "INSERT INTO api_tokens (user_id, token, token_preview, name) VALUES (?, ?, ?, 'Screenshots')",
  ).run(userId, hashToken(u.token), tokenPreview(u.token))

  const projects = seedProjects(db, userId)
  seedTasks(db, userId, projects)
  seedReminders(db, userId, projects)
  seedQuotas(db, userId, projects)

  const count = (
    db.prepare('SELECT COUNT(*) c FROM tasks WHERE user_id = ?').get(userId) as {
      c: number
    }
  ).c
  console.log(`Seeded "${u.username}" at ${now().toISO()} — ${count} rows in tasks → ${dbPath}`)
  closeDb()
}

main().catch((err) => {
  console.error('Screenshot seed failed:', err)
  process.exit(1)
})
