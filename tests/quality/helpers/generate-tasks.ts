/**
 * Realistic task list generator for AI insights quality testing
 *
 * Generates task lists at configurable scale with realistic distributions
 * of priorities, ages, projects, labels, and recurrence patterns.
 *
 * Anchor tasks (hand-crafted, injected at known IDs in the 9001+ range)
 * can be mixed in so that insights_expectations can reference them by ID.
 *
 * Realism features:
 * - Semantic label matching (labels match task content, not random)
 * - Dictation/Siri artifact titles (~3-5% of tasks)
 * - Notes on 10-15% of tasks (contextual, reference info, partial dictation)
 * - Snoozed tasks with due_at !== original_due_at
 * - Diverse time-of-day ranges (not hardcoded hours)
 * - Full RRULE variety (yearly, quarterly, weekdays-only)
 * - Life domain coverage (hobbies, seasonal, pets, social, travel)
 */

import { DateTime } from 'luxon'
import type { TaskSummary } from '@/core/ai/types'

export interface TaskGeneratorConfig {
  /** Total number of generated tasks (excludes anchor tasks) */
  count: number
  /** % routine, clear, on-track tasks */
  wellOrganized: number
  /** % 3+ weeks old, P0, no due date */
  stale: number
  /** % 1-3 weeks old, borderline */
  borderline: number
  /** % overdue recurring (mix within/beyond cycle) */
  recurringOverdue: number
  /** % P3-4 with deadlines */
  highPriority: number
  /** % small concrete tasks */
  quickWin: number
  /** % unclear titles */
  vague: number
  /** % wrong priority for content */
  misprioritized: number
}

// ---------------------------------------------------------------------------
// Title pools — realistic task titles by category
// ---------------------------------------------------------------------------

const WELL_ORGANIZED_TITLES = [
  'Team standup',
  'Weekly 1:1 with manager',
  'Submit timesheet',
  'Water indoor plants',
  'Pay rent',
  'Submit weekly report',
  'Review sprint backlog',
  'Send status update',
  'Check email inbox',
  'Review pull requests',
  'Update project board',
  'Run weekly backup',
  'Check server health',
  'Morning vitamins',
  'Evening walk',
  'Read for 30 minutes',
  'Review calendar for tomorrow',
  'Plan meals for the week',
  'Take out recycling',
  'Water garden',
  'Check tire pressure',
  'Walk the dog',
  'Feed the fish',
  'Make bed',
  'Empty dishwasher',
  'Sort mail',
  'Review bank statements',
  'Charge devices overnight',
  'Prep lunch for tomorrow',
  'Quick tidy of living room',
  'Stretch routine',
  'Practice guitar for 15 min',
  'Duolingo daily lesson',
  'Check weather for tomorrow',
  'Respond to team messages',
  'Clear browser tabs',
  'Update work journal',
  'Review todo list priorities',
  'Log daily expenses',
  'Quick desk cleanup',
  // Hobbies, creative, social, seasonal, pets, kids
  'Yoga class',
  'Photography club meetup',
  'Pack lunch for field trip',
  'Send birthday party invites',
  'Prep Thanksgiving side dish list',
  'Drop off library books',
  'Schedule vet appointment for Luna',
  "Kids' soccer practice carpool",
]

const STALE_TITLES = [
  'Organize the garage',
  'Research new laptop',
  'Update resume',
  'Sort through old clothes',
  'Fix the leaky faucet',
  'Look into refinancing',
  'Cancel unused subscriptions',
  'Reorganize the pantry',
  'Donate old electronics',
  'Clean out the attic',
  'Repaint the bathroom',
  'Set up home office ergonomics',
  'Research investment options',
  'Find a new dentist',
  'Update emergency contacts',
  'Back up old photos',
  'Organize digital files',
  'Research vacation spots',
  'Fix the squeaky door',
  'Replace smoke detector batteries',
  'Clean gutters',
  'Research meal prep services',
  'Organize bookshelf',
  'Fix garage door opener',
  'Look into home warranty',
  // Hobbies, seasonal, creative, self-care
  'Start the garden beds for spring',
  'Book summer vacation flights',
  'Frame the concert poster',
  'Set up the NAS backup server',
  'Look into music lessons for Sarah',
]

const BORDERLINE_TITLES = [
  'Schedule dentist appointment',
  'Return library books',
  'Order new shelf brackets',
  'Call about insurance claim',
  'Follow up with contractor',
  'Research standing desks',
  'Get oil change',
  'Return Amazon package',
  'Fix towel rack in bathroom',
  'Buy replacement air filters',
  'Schedule car inspection',
  'Set up automatic bill pay',
  'Research new phone plan',
  'Buy birthday gift for dad',
  'Fix cracked phone screen',
]

const RECURRING_OVERDUE_TITLES = [
  'Weekly meal prep',
  'Monthly budget review',
  'Clean the bathroom',
  'Vacuum the house',
  'Mow the lawn',
  'Water outdoor plants',
  'Review and file receipts',
  'Clean the fridge',
  'Change bed sheets',
  'Deep clean kitchen',
  'Backup phone photos',
  'Check car fluids',
  'Wipe kitchen counters',
  'Organize desk drawers',
  'Clean bathroom mirror',
]

const HIGH_PRIORITY_TITLES = [
  'File insurance claim',
  'Submit tax documents',
  'Renew car registration',
  'RSVP to wedding',
  'Renew passport',
  'Pay property taxes',
  'Submit expense report',
  'Review contractor bids',
  'Sign lease renewal',
  'Schedule surgery consultation',
  'File home warranty claim',
  'Submit grant application',
]

const QUICK_WIN_TITLES = [
  'Unsubscribe from mailing lists',
  'Update phone password',
  'Download bank statement',
  'RSVP to party',
  'Cancel free trial',
  'Set up 2FA on email',
  'Bookmark reference link',
  'Send quick thank-you text',
  'Archive old emails',
  'Update billing address',
  'Export contacts backup',
  'Delete unused apps',
  // Social, quick tasks
  'Text happy birthday to uncle',
  'Venmo Jake for dinner',
]

const VAGUE_TITLES = [
  'Thing',
  'Check on that',
  'Follow up',
  'Look into it',
  'Deal with the situation',
  'Fix the issue',
  'Handle that thing from Tuesday',
  'Do the thing',
  'Remember to check',
  'Ask about it',
  'Figure out the problem',
  'Finish what I started',
]

const MISPRIORITIZED_TITLES = [
  'Clean the entire house top to bottom',
  'Organize sock drawer',
  'Buy new pens',
  'Rearrange bookshelf by color',
  'Sort recipes folder',
  'Alphabetize spice rack',
  'Color-code closet',
  'Relabel all storage bins',
  'Reorganize junk drawer',
  'Iron curtains',
]

const FILLER_TITLES = [
  'Pick up groceries',
  'Call Mom',
  'Get haircut',
  'Buy birthday card',
  'Take clothes to dry cleaner',
  'Buy new lightbulbs',
  'Drop off donation bag',
  'Get spare key made',
  'Buy wrapping paper',
  'Pick up prescription',
  // Seasonal, social, kids, travel
  'Order Christmas gifts',
  'RSVP to dinner party',
  'Text Jake back about Saturday',
  'Bring cupcakes to school Friday',
  'Charge the camping lantern',
]

// ---------------------------------------------------------------------------
// Dictation/Siri artifact titles
//
// Real tasks come through Siri dictation with homophones, missing words,
// run-togethers, stream-of-consciousness phrasing, and garbled speech.
// ~3-5% of generated tasks get one of these titles to stress-test the AI.
// ---------------------------------------------------------------------------

const DICTATION_TITLES = [
  'By paper towels at target',
  'Send that email too Mike',
  'Schedule appointment Dr maybe Wednesday',
  'The plumber about the thinking',
  'Pickup drycleaning',
  'Followup with contractor',
  'Oh yeah need to call the vet about the dog thing',
  'Cancel Jim subscription',
  'Check on the renew for insurance',
  'Get the kids from practice dont forget',
  'Return the thing from amazon the blue one',
  'Remind me to call the bank about the fee thing',
  'Buy new shoes for the kids there growing fast',
  'Fix the toilet its running again',
  'That recipe Sarah sent me try it this week',
  'Need to figure out the wifi situation',
  'Pay the electric its overdo',
  'Order more have filters for the furnace',
  'Pickup flowers for anniversary dont forget this time',
  'Look into weather we need new tires',
]

// ---------------------------------------------------------------------------
// Notes pools — realistic notes content by category
//
// Target: 10-15% of tasks have notes. Notes add context that makes the AI's
// job harder (and more realistic): reference numbers, partial info, dictation
// artifacts, and contextual clues the AI should incorporate into scoring.
// ---------------------------------------------------------------------------

const NOTES_CONTEXTUAL = [
  'Sarah mentioned this at the team lunch',
  'Saw the ad on Craigslist',
  'Mike recommended this place',
  'Landlord said to handle by end of month',
  'Manager brought this up in 1:1',
  'Neighbor mentioned a good contractor',
]

const NOTES_REFERENCE = [
  'Call 512-555-1234',
  'Acct #A-4829',
  'Confirmation number: 8HX2K9',
  'Policy #TK-441128',
  'Ref: invoice 2026-0142',
  'Order #9928-XL',
]

const NOTES_INSTRUCTIONS = [
  'Use the blue folder, not the red one',
  'Need the original receipt',
  'Has to be done before 5pm',
  'Ask for extension if needed',
  'Check the back of the filing cabinet first',
  'Use the side entrance, main door is broken',
]

const NOTES_DICTATION = [
  'the one near the...',
  'Mike said something about',
  'I think its the third one or maybe',
  'dont forget the thing with the',
  'the place on oak street or was it elm',
]

const NOTES_SHOPPING = [
  'eggs, milk, bread, paper towels',
  'get the organic kind this time',
  'check if Costco has it first',
  'need the large size, not medium',
]

const NOTES_DEADLINE = [
  'Late fees start after the 15th',
  'Filing window closes March 1',
  'Enrollment deadline is end of February',
  'Grace period ends next week',
  'Discount expires Friday',
]

const ALL_NOTES = [
  ...NOTES_CONTEXTUAL,
  ...NOTES_REFERENCE,
  ...NOTES_INSTRUCTIONS,
  ...NOTES_DICTATION,
  ...NOTES_SHOPPING,
  ...NOTES_DEADLINE,
]

const PROJECTS = ['Work', 'Home', 'Fitness', 'Side Project', 'Family', null, null, null]
const LABELS_POOL = [
  'home',
  'work',
  'errand',
  'finance',
  'health',
  'car',
  'family',
  'career',
  'learning',
  'social',
]

// ---------------------------------------------------------------------------
// Semantic label matching
//
// Maps keywords found in task titles to appropriate labels. Replaces the old
// pickRandomLabels which could assign "car" to "Team standup". Falls back to
// random if no keywords match. 30% chance of no labels (realistic).
// ---------------------------------------------------------------------------

const LABEL_KEYWORDS: Record<string, string[]> = {
  home: [
    'garage',
    'fence',
    'kitchen',
    'bathroom',
    'house',
    'closet',
    'pantry',
    'plants',
    'garden',
    'attic',
    'door',
    'gutter',
    'shelf',
    'bed',
    'dishwasher',
    'fridge',
    'living room',
    'desk',
    'mirror',
    'towel',
    'smoke detector',
    'lightbulb',
    'curtain',
    'bookshelf',
    'drawer',
    'counter',
    'recycling',
    'mail',
    'laundry',
    'vacuum',
    'mow',
    'lawn',
    'plumber',
    'wifi',
    'furnace',
    'toilet',
  ],
  work: [
    'standup',
    'report',
    'meeting',
    'project',
    'team',
    'sprint',
    'status',
    'timesheet',
    'pull request',
    'server',
    'backup',
    'manager',
    'email inbox',
    'work journal',
    'slides',
    'grant',
  ],
  finance: [
    'pay',
    'bill',
    'tax',
    'insurance',
    'budget',
    'bank',
    'refinanc',
    'expense',
    'property tax',
    'receipt',
    'investment',
    'billing',
    'subscription',
    'lease',
    'electric',
    'rent',
    'statement',
  ],
  health: [
    'doctor',
    'dentist',
    'vitamin',
    'physical',
    'prescription',
    'surgery',
    'yoga',
    'stretch',
    'walk',
    'fitness',
    'gym',
  ],
  car: ['tire', 'oil change', 'registration', 'car', 'inspection', 'fluids'],
  errand: [
    'pick up',
    'drop off',
    'buy',
    'grocery',
    'dry clean',
    'return',
    'haircut',
    'key made',
    'wrapping paper',
    'donation',
  ],
  family: [
    'mom',
    'dad',
    'birthday',
    'wedding',
    'family',
    'uncle',
    'kids',
    'school',
    'carpool',
    'soccer',
    'field trip',
    'anniversary',
  ],
  career: ['resume', 'linkedin', 'interview', 'recruiter', 'portfolio'],
  learning: ['duolingo', 'read', 'guitar', 'book', 'chapter', 'lesson', 'music lesson'],
  social: ['rsvp', 'party', 'dinner', 'jake', 'thank-you', 'thank you', 'meetup', 'photography'],
}

function pickLabelsForTitle(title: string, rng: () => number): string[] {
  if (rng() < 0.3) return [] // 30% chance of no labels

  const titleLower = title.toLowerCase()
  const matched: string[] = []

  for (const [label, keywords] of Object.entries(LABEL_KEYWORDS)) {
    for (const kw of keywords) {
      if (titleLower.includes(kw)) {
        matched.push(label)
        break
      }
    }
  }

  if (matched.length === 0) {
    // No keyword match — fall back to random
    return rng() < 0.5 ? [pickRandom(LABELS_POOL, rng)] : []
  }

  // Return first match, occasionally add a second
  if (matched.length > 1 && rng() < 0.15) {
    return [matched[0], matched[1]]
  }
  return [matched[0]]
}

const RRULE_OPTIONS = [
  'FREQ=DAILY',
  'FREQ=WEEKLY;BYDAY=MO',
  'FREQ=WEEKLY;BYDAY=MO,WE,FR',
  'FREQ=WEEKLY;BYDAY=TU,TH',
  'FREQ=WEEKLY;BYDAY=MO',
  'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO',
  'FREQ=MONTHLY;BYMONTHDAY=1',
  'FREQ=MONTHLY;BYMONTHDAY=15',
  // Expanded patterns
  'FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1',
  'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1',
  'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  'FREQ=MONTHLY;BYDAY=1FR',
]

// ---------------------------------------------------------------------------
// Seeded random for deterministic generation
// ---------------------------------------------------------------------------

/**
 * Simple seeded PRNG (xoshiro128**) for deterministic task generation.
 * Ensures the same config produces the same task list every time.
 */
function createRng(seed: number): () => number {
  let s0 = seed | 0
  let s1 = (seed * 1664525 + 1013904223) | 0
  let s2 = (seed * 214013 + 2531011) | 0
  let s3 = (seed * 48271) | 0

  return () => {
    const result = (((s1 * 5) << 7) * 9) | 0
    const t = s1 << 9
    s2 ^= s0
    s3 ^= s1
    s1 ^= s2
    s0 ^= s3
    s2 ^= t
    s3 = (s3 << 11) | (s3 >>> 21)
    return (result >>> 0) / 4294967296
  }
}

function pickRandom<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)]
}

/** Random hour within a range (inclusive) */
function randomHour(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

/** Pick a random note from the pool, or null */
function maybeNote(rng: () => number, probability: number): string | null {
  return rng() < probability ? pickRandom(ALL_NOTES, rng) : null
}

/** Possibly replace title with a dictation artifact (~5% chance) */
function maybeDictationTitle(title: string, rng: () => number): string {
  return rng() < 0.05 ? pickRandom(DICTATION_TITLES, rng) : title
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Generate a realistic task list with configurable composition.
 *
 * Generated tasks use IDs 1-count. Anchor tasks (if provided) are injected
 * with their original IDs preserved (use 9001+ range to avoid collisions).
 */
export function generateRealisticTaskList(
  config: TaskGeneratorConfig,
  timezone: string,
  anchorTasks?: TaskSummary[],
): TaskSummary[] {
  const rng = createRng(42)
  const now = DateTime.now().setZone(timezone)

  // Calculate counts per category
  const counts = distributeCategories(config)
  const tasks: TaskSummary[] = []
  let nextId = 1

  // Generate tasks by category
  for (let i = 0; i < counts.wellOrganized; i++) {
    tasks.push(makeWellOrganized(nextId++, now, timezone, rng))
  }
  for (let i = 0; i < counts.stale; i++) {
    tasks.push(makeStale(nextId++, now, rng))
  }
  for (let i = 0; i < counts.borderline; i++) {
    tasks.push(makeBorderline(nextId++, now, timezone, rng))
  }
  for (let i = 0; i < counts.recurringOverdue; i++) {
    tasks.push(makeRecurringOverdue(nextId++, now, timezone, rng))
  }
  for (let i = 0; i < counts.highPriority; i++) {
    tasks.push(makeHighPriority(nextId++, now, timezone, rng))
  }
  for (let i = 0; i < counts.quickWin; i++) {
    tasks.push(makeQuickWin(nextId++, now, rng))
  }
  for (let i = 0; i < counts.vague; i++) {
    tasks.push(makeVague(nextId++, now, rng))
  }
  for (let i = 0; i < counts.misprioritized; i++) {
    tasks.push(makeMisprioritized(nextId++, now, timezone, rng))
  }

  // Fill remaining with generic filler
  while (tasks.length < config.count) {
    tasks.push(makeFiller(nextId++, now, timezone, rng))
  }

  // Inject anchor tasks
  if (anchorTasks) {
    tasks.push(...anchorTasks)
  }

  // Shuffle deterministically so categories aren't clustered
  for (let i = tasks.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[tasks[i], tasks[j]] = [tasks[j], tasks[i]]
  }

  return tasks
}

function distributeCategories(config: TaskGeneratorConfig) {
  const total = config.count
  const wellOrganized = Math.round((config.wellOrganized / 100) * total)
  const stale = Math.round((config.stale / 100) * total)
  const borderline = Math.round((config.borderline / 100) * total)
  const recurringOverdue = Math.round((config.recurringOverdue / 100) * total)
  const highPriority = Math.round((config.highPriority / 100) * total)
  const quickWin = Math.round((config.quickWin / 100) * total)
  const vague = Math.round((config.vague / 100) * total)
  const misprioritized = Math.round((config.misprioritized / 100) * total)
  return {
    wellOrganized,
    stale,
    borderline,
    recurringOverdue,
    highPriority,
    quickWin,
    vague,
    misprioritized,
  }
}

// ---------------------------------------------------------------------------
// Category builders
// ---------------------------------------------------------------------------

function makeWellOrganized(
  id: number,
  now: DateTime,
  timezone: string,
  rng: () => number,
): TaskSummary {
  const isRecurring = rng() < 0.6
  const title = maybeDictationTitle(pickRandom(WELL_ORGANIZED_TITLES, rng), rng)
  const createdDaysAgo = Math.floor(rng() * 40) + 1
  const created = now.minus({ days: createdDaysAgo })
  const dueDaysFromNow = Math.floor(rng() * 5) - 1 // -1 to 3 days
  const dueAt = now.plus({ days: dueDaysFromNow }).set({ hour: randomHour(rng, 7, 21) })

  // 15% chance of being snoozed (original_due_at 1-5 days before due_at)
  const isSnoozed = rng() < 0.15
  const originalDueAt = isSnoozed ? dueAt.minus({ days: Math.floor(rng() * 5) + 1 }) : dueAt

  return {
    id,
    title,
    priority: rng() < 0.3 ? 2 : rng() < 0.5 ? 1 : 0,
    due_at: dueAt.toUTC().toISO()!,
    original_due_at: originalDueAt.toUTC().toISO()!,
    created_at: created.toUTC().toISO()!,
    labels: pickLabelsForTitle(title, rng),
    project_name: pickRandom(PROJECTS, rng),
    is_recurring: isRecurring,
    rrule: isRecurring ? pickRandom(RRULE_OPTIONS, rng) : null,
    notes: maybeNote(rng, 0.1),
    recurrence_mode: 'from_due',
  }
}

function makeStale(id: number, now: DateTime, rng: () => number): TaskSummary {
  const title = pickRandom(STALE_TITLES, rng)
  const createdDaysAgo = 21 + Math.floor(rng() * 70) // 3-12 weeks ago
  const created = now.minus({ days: createdDaysAgo })

  return {
    id,
    title,
    priority: rng() < 0.8 ? 0 : 1,
    due_at: null,
    original_due_at: null,
    created_at: created.toUTC().toISO()!,
    labels: pickLabelsForTitle(title, rng),
    project_name: pickRandom(PROJECTS, rng),
    is_recurring: false,
    rrule: null,
    notes: maybeNote(rng, 0.15),
    recurrence_mode: 'from_due',
  }
}

function makeBorderline(
  id: number,
  now: DateTime,
  timezone: string,
  rng: () => number,
): TaskSummary {
  const title = maybeDictationTitle(pickRandom(BORDERLINE_TITLES, rng), rng)
  const createdDaysAgo = 7 + Math.floor(rng() * 14) // 1-3 weeks ago
  const created = now.minus({ days: createdDaysAgo })
  const hasDue = rng() < 0.4
  const dueAt = hasDue
    ? now.minus({ days: Math.floor(rng() * 5) }).set({ hour: randomHour(rng, 7, 21) })
    : null

  // 15% of tasks with due dates are snoozed
  const isSnoozed = hasDue && dueAt && rng() < 0.15
  const originalDueAt = isSnoozed ? dueAt.minus({ days: Math.floor(rng() * 5) + 1 }) : dueAt

  return {
    id,
    title,
    priority: rng() < 0.7 ? 0 : 1,
    due_at: dueAt?.toUTC().toISO() ?? null,
    original_due_at: originalDueAt?.toUTC().toISO() ?? null,
    created_at: created.toUTC().toISO()!,
    labels: pickLabelsForTitle(title, rng),
    project_name: pickRandom(PROJECTS, rng),
    is_recurring: false,
    rrule: null,
    notes: maybeNote(rng, 0.2),
    recurrence_mode: 'from_due',
  }
}

function makeRecurringOverdue(
  id: number,
  now: DateTime,
  timezone: string,
  rng: () => number,
): TaskSummary {
  const title = pickRandom(RECURRING_OVERDUE_TITLES, rng)
  const createdDaysAgo = 30 + Math.floor(rng() * 60)
  const created = now.minus({ days: createdDaysAgo })
  // Mix of within-cycle and multi-cycle overdue
  const overdueDays = rng() < 0.5 ? Math.floor(rng() * 3) + 1 : 7 + Math.floor(rng() * 21)
  const dueAt = now.minus({ days: overdueDays }).set({ hour: randomHour(rng, 6, 22) })
  const rrule = pickRandom(RRULE_OPTIONS, rng)
  const isFromCompletion = rng() < 0.3

  return {
    id,
    title,
    priority: rng() < 0.7 ? 0 : rng() < 0.5 ? 1 : 2,
    due_at: dueAt.toUTC().toISO()!,
    original_due_at: dueAt.toUTC().toISO()!,
    created_at: created.toUTC().toISO()!,
    labels: pickLabelsForTitle(title, rng),
    project_name: pickRandom(PROJECTS, rng),
    is_recurring: true,
    rrule,
    notes: maybeNote(rng, 0.1),
    recurrence_mode: isFromCompletion ? 'from_completion' : 'from_due',
  }
}

function makeHighPriority(
  id: number,
  now: DateTime,
  timezone: string,
  rng: () => number,
): TaskSummary {
  const title = pickRandom(HIGH_PRIORITY_TITLES, rng)
  const createdDaysAgo = 5 + Math.floor(rng() * 20)
  const created = now.minus({ days: createdDaysAgo })
  // Mix of upcoming and slightly passed deadlines
  const dueDaysFromNow = Math.floor(rng() * 10) - 3 // -3 to 6 days
  const dueAt = now.plus({ days: dueDaysFromNow }).set({ hour: randomHour(rng, 8, 22) })

  return {
    id,
    title,
    priority: rng() < 0.3 ? 4 : 3,
    due_at: dueAt.toUTC().toISO()!,
    original_due_at: dueAt.toUTC().toISO()!,
    created_at: created.toUTC().toISO()!,
    labels: pickLabelsForTitle(title, rng),
    project_name: pickRandom(PROJECTS, rng),
    is_recurring: false,
    rrule: null,
    notes: rng() < 0.4 ? pickRandom(NOTES_DEADLINE, rng) : null,
    recurrence_mode: 'from_due',
  }
}

function makeQuickWin(id: number, now: DateTime, rng: () => number): TaskSummary {
  const title = pickRandom(QUICK_WIN_TITLES, rng)
  const createdDaysAgo = Math.floor(rng() * 14) + 1
  const created = now.minus({ days: createdDaysAgo })

  return {
    id,
    title,
    priority: 0,
    due_at: null,
    original_due_at: null,
    created_at: created.toUTC().toISO()!,
    labels: pickLabelsForTitle(title, rng),
    project_name: null,
    is_recurring: false,
    rrule: null,
    notes: maybeNote(rng, 0.15),
    recurrence_mode: 'from_due',
  }
}

function makeVague(id: number, now: DateTime, rng: () => number): TaskSummary {
  const title = pickRandom(VAGUE_TITLES, rng)
  const createdDaysAgo = 7 + Math.floor(rng() * 30)
  const created = now.minus({ days: createdDaysAgo })

  return {
    id,
    title,
    priority: 0,
    due_at: null,
    original_due_at: null,
    created_at: created.toUTC().toISO()!,
    labels: [],
    project_name: null,
    is_recurring: false,
    rrule: null,
    notes: null,
    recurrence_mode: 'from_due',
  }
}

function makeMisprioritized(
  id: number,
  now: DateTime,
  timezone: string,
  rng: () => number,
): TaskSummary {
  const title = pickRandom(MISPRIORITIZED_TITLES, rng)
  const createdDaysAgo = Math.floor(rng() * 10) + 1
  const created = now.minus({ days: createdDaysAgo })
  const dueAt = now.plus({ days: Math.floor(rng() * 5) + 1 }).set({ hour: randomHour(rng, 8, 22) })

  return {
    id,
    title,
    priority: 4, // P4 for mundane tasks = misprioritized
    due_at: dueAt.toUTC().toISO()!,
    original_due_at: dueAt.toUTC().toISO()!,
    created_at: created.toUTC().toISO()!,
    labels: pickLabelsForTitle(title, rng),
    project_name: pickRandom(PROJECTS, rng),
    is_recurring: false,
    rrule: null,
    notes: null,
    recurrence_mode: 'from_due',
  }
}

function makeFiller(id: number, now: DateTime, timezone: string, rng: () => number): TaskSummary {
  const title = maybeDictationTitle(pickRandom(FILLER_TITLES, rng), rng)
  const createdDaysAgo = Math.floor(rng() * 7) + 1
  const created = now.minus({ days: createdDaysAgo })
  const dueAt = now.plus({ days: Math.floor(rng() * 3) }).set({ hour: randomHour(rng, 7, 21) })

  return {
    id,
    title,
    priority: rng() < 0.5 ? 0 : 1,
    due_at: dueAt.toUTC().toISO()!,
    original_due_at: dueAt.toUTC().toISO()!,
    created_at: created.toUTC().toISO()!,
    labels: pickLabelsForTitle(title, rng),
    project_name: pickRandom(PROJECTS, rng),
    is_recurring: false,
    rrule: null,
    notes: maybeNote(rng, 0.1),
    recurrence_mode: 'from_due',
  }
}
