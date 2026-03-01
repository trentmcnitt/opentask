/**
 * Large-list AI Insights scenarios
 *
 * Tests insights quality at realistic production scale. These scenarios use
 * the task generator to create lists of 50-600 tasks with hand-crafted
 * "anchor tasks" (IDs 9001+) whose scores and signals can be verified
 * deterministically.
 *
 * Gate: scenarios with > 100 tasks only run when QUALITY_TEST_LARGE=true.
 */

import type { AITestScenario } from '../types'
import type { TaskSummary } from '@/core/ai/types'
import { generateRealisticTaskList } from '../helpers/generate-tasks'
import { daysAgo, daysAgoAt, weeksAgo, monthsAgo, daysFromNowAt } from '../helpers/dates'

// ---------------------------------------------------------------------------
// Anchor tasks — hand-crafted with known expected behavior
// IDs in 9001+ range to avoid collision with generated tasks.
// ---------------------------------------------------------------------------

const tz = 'America/Chicago'

const STALE_ANCHORS: TaskSummary[] = [
  {
    id: 9001,
    title: 'Research new health insurance plans',
    priority: 0,
    due_at: null,
    original_due_at: null,
    created_at: monthsAgo(4),
    labels: ['finance'],
    project_name: null,
    is_recurring: false,
    rrule: null,
    notes: null,
    recurrence_mode: 'from_due',
  },
  {
    id: 9002,
    title: 'Fix the broken fence gate',
    priority: 0,
    due_at: null,
    original_due_at: null,
    created_at: monthsAgo(5),
    labels: ['home'],
    project_name: null,
    is_recurring: false,
    rrule: null,
    notes: null,
    recurrence_mode: 'from_due',
  },
  {
    id: 9003,
    title: 'Look into solar panel options',
    priority: 1,
    due_at: null,
    original_due_at: null,
    created_at: monthsAgo(3),
    labels: ['home'],
    project_name: null,
    is_recurring: false,
    rrule: null,
    notes: null,
    recurrence_mode: 'from_due',
  },
]

const P4_ANCHORS: TaskSummary[] = [
  {
    id: 9010,
    title: 'URGENT: Deploy hotfix to production',
    priority: 4,
    due_at: daysAgoAt(1, 14, 0, tz),
    original_due_at: daysAgoAt(1, 14, 0, tz),
    created_at: daysAgo(1),
    labels: ['work'],
    project_name: 'Work',
    is_recurring: false,
    rrule: null,
    notes: null,
    recurrence_mode: 'from_due',
  },
  {
    id: 9011,
    title: 'CRITICAL: Fix payment processing error',
    priority: 4,
    due_at: daysAgoAt(2, 16, 0, tz),
    original_due_at: daysAgoAt(2, 16, 0, tz),
    created_at: daysAgo(2),
    labels: ['work'],
    project_name: 'Work',
    is_recurring: false,
    rrule: null,
    notes: null,
    recurrence_mode: 'from_due',
  },
]

const VAGUE_ANCHORS: TaskSummary[] = [
  {
    id: 9020,
    title: 'That thing',
    priority: 0,
    due_at: null,
    original_due_at: null,
    created_at: weeksAgo(6),
    labels: [],
    project_name: null,
    is_recurring: false,
    rrule: null,
    notes: null,
    recurrence_mode: 'from_due',
  },
  {
    id: 9021,
    title: 'Check',
    priority: 0,
    due_at: null,
    original_due_at: null,
    created_at: weeksAgo(7),
    labels: [],
    project_name: null,
    is_recurring: false,
    rrule: null,
    notes: null,
    recurrence_mode: 'from_due',
  },
]

const WELL_ORGANIZED_ANCHORS: TaskSummary[] = [
  {
    id: 9030,
    title: 'Weekly team standup',
    priority: 2,
    due_at: daysFromNowAt(2, 9, 0, tz),
    original_due_at: daysFromNowAt(2, 9, 0, tz),
    created_at: monthsAgo(2),
    labels: ['work'],
    project_name: 'Work',
    is_recurring: true,
    rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    notes: null,
    recurrence_mode: 'from_due',
  },
  {
    id: 9031,
    title: 'Pay electric bill',
    priority: 3,
    due_at: daysFromNowAt(4, 16, 0, tz),
    original_due_at: daysFromNowAt(4, 16, 0, tz),
    created_at: monthsAgo(1),
    labels: ['finance'],
    project_name: null,
    is_recurring: true,
    rrule: 'FREQ=MONTHLY;BYMONTHDAY=15',
    notes: null,
    recurrence_mode: 'from_due',
  },
]

const MISPRIORITIZED_ANCHOR: TaskSummary = {
  id: 9040,
  title: 'Alphabetize the spice rack',
  priority: 4,
  due_at: daysFromNowAt(3, 16, 0, tz),
  original_due_at: daysFromNowAt(3, 16, 0, tz),
  created_at: daysAgo(4),
  labels: ['home'],
  project_name: null,
  is_recurring: false,
  rrule: null,
  notes: null,
  recurrence_mode: 'from_due',
}

const ALL_ANCHORS: TaskSummary[] = [
  ...STALE_ANCHORS,
  ...P4_ANCHORS,
  ...VAGUE_ANCHORS,
  ...WELL_ORGANIZED_ANCHORS,
  MISPRIORITIZED_ANCHOR,
]

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const TIMEZONE = 'America/Chicago'

export const insightsLargeScenarios: AITestScenario[] = [
  {
    id: 'insights-medium-list',
    feature: 'insights',
    description:
      'Score calibration at moderate scale (~50 tasks). Verifies signal restraint holds when ' +
      'there are enough tasks for distribution to matter.',
    input: {
      timezone: TIMEZONE,
      tasks: generateRealisticTaskList(
        {
          count: 50,
          wellOrganized: 60,
          stale: 12,
          borderline: 10,
          recurringOverdue: 5,
          highPriority: 4,
          quickWin: 3,
          vague: 3,
          misprioritized: 1,
        },
        TIMEZONE,
      ),
    },
    requirements: {
      quality_notes:
        'Moderate-scale list (~50 tasks). ' +
        'Signal restraint must hold: at least 50% of tasks should have zero signals. ' +
        'P4 tasks should score 0-20 with no signals. ' +
        'Score spread should be meaningful (std dev > 10). ' +
        'This scenario validates that the AI does not over-signal at moderate scale.',
      insights_expectations: {
        min_zero_signal_pct: 40,
      },
    },
  },
  {
    id: 'insights-large-realistic',
    feature: 'insights',
    description:
      'Max single-call test (~400 tasks). Realistic power-user list with anchor tasks for ' +
      'deterministic checks. Core "does the AI hold up at scale" test.',
    input: {
      timezone: TIMEZONE,
      tasks: generateRealisticTaskList(
        {
          count: 385,
          wellOrganized: 60,
          stale: 12,
          borderline: 10,
          recurringOverdue: 5,
          highPriority: 4,
          quickWin: 3,
          vague: 2,
          misprioritized: 2,
        },
        TIMEZONE,
        ALL_ANCHORS,
      ),
    },
    requirements: {
      quality_notes:
        'Large-scale single-call test (~400 tasks including 11 anchor tasks). ' +
        'Tests whether the AI maintains scoring quality when seeing hundreds of tasks at once. ' +
        'Anchor tasks (IDs 9001+) have deterministic expectations: ' +
        '- 3 stale anchors (9001-9003): should score 70+ and get "stale" signal ' +
        '- 2 P4 anchors (9010-9011): must score 0-20 with no signals ' +
        '- 2 vague anchors (9020-9021): should get "vague" signal ' +
        '- 2 well-organized anchors (9030-9031): should score 0-30 with no signals ' +
        '- 1 misprioritized anchor (9040): P4 for mundane task, should get "misprioritized" signal ' +
        'Overall: signal restraint should hold (55%+ zero signals). ' +
        'Score spread should be wide (std dev > 10).',
      insights_expectations: {
        score_ranges: {
          9001: { min: 70, max: 100 },
          9002: { min: 70, max: 100 },
          9003: { min: 70, max: 100 },
          9010: { min: 0, max: 20 },
          9011: { min: 0, max: 20 },
          9030: { min: 0, max: 30 },
          9031: { min: 0, max: 30 },
        },
        signal_checks: {
          9001: { must_have: ['stale'] },
          9002: { must_have: ['stale'] },
          9003: { must_have: ['stale'] },
          9010: {
            must_not_have: ['stale', 'act_soon', 'quick_win', 'vague', 'misprioritized', 'review'],
          },
          9011: {
            must_not_have: ['stale', 'act_soon', 'quick_win', 'vague', 'misprioritized', 'review'],
          },
          9020: { must_have: ['vague'] },
          9021: { must_have: ['vague'] },
        },
        min_zero_signal_pct: 55,
      },
    },
  },
  {
    id: 'insights-large-chunked',
    feature: 'insights',
    description:
      'Multi-chunk production code path (~600 tasks). Uses startInsightsGeneration + polling ' +
      'to test chunking, shuffle, calibration summary, and cross-chunk consistency.',
    input: {
      timezone: TIMEZONE,
      useProductionCodePath: true,
      tasks: generateRealisticTaskList(
        {
          count: 585,
          wellOrganized: 60,
          stale: 12,
          borderline: 10,
          recurringOverdue: 5,
          highPriority: 4,
          quickWin: 3,
          vague: 2,
          misprioritized: 2,
        },
        TIMEZONE,
        ALL_ANCHORS,
      ),
    },
    requirements: {
      quality_notes:
        'Multi-chunk production code path (~600 tasks). Tests the real chunking, shuffling, ' +
        'calibration summary, and result merging via startInsightsGeneration + polling. ' +
        'The same anchor tasks are used as in insights-large-realistic. ' +
        'Cross-chunk consistency: anchor task scores and signals should be similar to the ' +
        'single-call scenario, even though tasks are split across multiple chunks. ' +
        'Signal restraint should hold at 50%+ zero signals. ' +
        'P4 anchors must still score 0-20 with no signals.',
      insights_expectations: {
        score_ranges: {
          9001: { min: 60, max: 100 },
          9002: { min: 60, max: 100 },
          9003: { min: 60, max: 100 },
          9010: { min: 0, max: 20 },
          9011: { min: 0, max: 20 },
          9030: { min: 0, max: 35 },
          9031: { min: 0, max: 35 },
        },
        signal_checks: {
          9010: {
            must_not_have: ['stale', 'act_soon', 'quick_win', 'vague', 'misprioritized', 'review'],
          },
          9011: {
            must_not_have: ['stale', 'act_soon', 'quick_win', 'vague', 'misprioritized', 'review'],
          },
        },
        min_zero_signal_pct: 50,
      },
    },
  },
]
