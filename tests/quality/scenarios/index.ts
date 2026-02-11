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
import { bubbleScenarios } from './bubble'

export const enrichmentScenarios: AITestScenario[] = [
  ...enrichmentCoreScenarios,
  ...enrichmentLabelScenarios,
  ...enrichmentDictationScenarios,
  ...enrichmentRecurrenceScenarios,
  ...enrichmentVoiceScenarios,
  ...enrichmentEdgeScenarios,
]

export const allScenarios: AITestScenario[] = [...enrichmentScenarios, ...bubbleScenarios]

export { bubbleScenarios }
