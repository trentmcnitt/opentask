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
import { enrichmentVoiceScenarios } from './enrichment-voice'
import { enrichmentEdgeScenarios } from './enrichment-edge'
import { whatsNextScenarios } from './whats-next'
import { insightsScenarios } from './insights'
import { insightsLargeScenarios } from './insights-large'

export const enrichmentScenarios: AITestScenario[] = [
  ...enrichmentCoreScenarios,
  ...enrichmentLabelScenarios,
  ...enrichmentDictationScenarios,
  ...enrichmentRecurrenceScenarios,
  ...enrichmentVoiceScenarios,
  ...enrichmentEdgeScenarios,
]

export const allScenarios: AITestScenario[] = [
  ...enrichmentScenarios,
  ...whatsNextScenarios,
  ...insightsScenarios,
  ...insightsLargeScenarios,
]

export { whatsNextScenarios, insightsScenarios, insightsLargeScenarios }
