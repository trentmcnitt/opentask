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
  type RRuleComponents,
} from './rrule-builder'

// Anchor field derivation
export {
  deriveAnchorFields,
  extractTimeOfDay,
  ensureTimeInRRule,
  type AnchorFields,
} from './anchor-derivation'

// Core computation
export {
  computeNextOccurrence,
  computeFirstOccurrence,
  isRecurring,
  type ComputeNextOptions,
} from './compute-next'

// Shared utilities for timezone handling
export { toNaiveLocal, fromNaiveLocal } from './utils'
