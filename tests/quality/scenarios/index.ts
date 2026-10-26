/**
 * Barrel export for all AI quality test scenarios
 *
 * Combines scenarios from all category files into a single allScenarios array.
 * Import from here in the test runner.
 */

import type { AITestScenario } from '../types'
import { enrichmentCoreScenarios } from './enrichment-core'
import { enrichmentLabelScenarios } from './enrichment-labels'
import { enrichmentDictationScenarios } from './enrichment-dictation'
import { enrichmentRecurrenceScenarios } from './enrichment-recurrence'
import { enrichmentReminderScenarios } from './enrichment-reminders'
import { enrichmentQuotaScenarios } from './enrichment-quotas'
import { enrichmentVoiceScenarios } from './enrichment-voice'
import { enrichmentEdgeScenarios } from './enrichment-edge'
import { enrichmentContextScenarios } from './enrichment-context'
import { enrichmentProjectScenarios } from './enrichment-projects'
import { enrichmentPriorityScenarios } from './enrichment-priority'
import { enrichmentTaskModelScenarios } from './enrichment-task-model'
import { enrichmentSoonScenarios } from './enrichment-soon'
import { enrichmentSameDayScenarios } from './enrichment-same-day'
import { enrichmentRepeatTitleScenarios } from './enrichment-repeat-titles'
import { enrichmentLateTodayScenarios } from './enrichment-late-today'
import { enrichmentOnDeckScenarios } from './enrichment-on-deck'
import { enrichmentProjectDescriptionScenarios } from './enrichment-project-descriptions'
import { whatsNextScenarios } from './whats-next'
import { insightsScenarios } from './insights'
import { insightsLargeScenarios } from './insights-large'
import { quickTakeScenarios } from './quick-take'
import { taskModelReviewScenarios } from './task-model-review'
import { processScenarios } from './process'

export const enrichmentScenarios: AITestScenario[] = [
  ...enrichmentCoreScenarios,
  ...enrichmentLabelScenarios,
  ...enrichmentDictationScenarios,
  ...enrichmentRecurrenceScenarios,
  ...enrichmentReminderScenarios,
  ...enrichmentQuotaScenarios,
  ...enrichmentVoiceScenarios,
  ...enrichmentEdgeScenarios,
  ...enrichmentContextScenarios,
  ...enrichmentProjectScenarios,
  ...enrichmentPriorityScenarios,
  ...enrichmentTaskModelScenarios,
  ...enrichmentSoonScenarios,
  ...enrichmentSameDayScenarios,
  ...enrichmentRepeatTitleScenarios,
  ...enrichmentLateTodayScenarios,
  ...enrichmentOnDeckScenarios,
  ...enrichmentProjectDescriptionScenarios,
]

export const allScenarios: AITestScenario[] = [
  ...enrichmentScenarios,
  ...whatsNextScenarios,
  ...insightsScenarios,
  ...insightsLargeScenarios,
  ...quickTakeScenarios,
  ...taskModelReviewScenarios,
  ...processScenarios,
]

export { whatsNextScenarios, insightsScenarios, insightsLargeScenarios, quickTakeScenarios }
