/**
 * Recurrence module for OpenTask
 *
 * Exports all recurrence-related functions for use by other modules.
 */

// Timezone utilities
export {
  utcToLocal,
  localToUtc,
  nowInTimezone,
  nowUtc,
  parseAnchorTime,
  formatAnchorTime,
  isValidTimezone,
  localTimeToUtc,
  getDayOfWeek,
  dowToRRuleDay,
  rruleDayToDow,
} from './timezone'

// RRULE building and parsing
export {
  buildRRule,
  parseRRule,
  isValidRRule,
  RRulePatterns,
  bydayDows,
  hasOrdinalByday,
  normalizeRRule,
  ordinalsCount,
  plainDays,
  type ByDay,
  type RRuleComponents,
} from './rrule-builder'

// Anchor field derivation
export { deriveAnchorFields, extractTimeOfDay, type AnchorFields } from './anchor-derivation'

// Every non-quota rule has a time of day (2026-10-12)
export {
  ensureRuleTime,
  ruleTimeFor,
  fillRuleTime,
  setRuleTime,
  type RuleTimeSources,
} from './rule-time'

// Core computation
export {
  computeNextOccurrence,
  occurrencesFromDue,
  ruleTimeOfDay,
  computeFirstOccurrence,
  rollPassedFirstOccurrence,
  isRecurring,
  type ComputeNextOptions,
} from './compute-next'

// Shared utilities for timezone handling
export { toNaiveLocal, fromNaiveLocal } from './utils'
