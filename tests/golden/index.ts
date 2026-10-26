/** Every golden scenario, for the runner (`tests/behavioral/golden.test.ts`). */
import { oneOffScenarios } from './one-offs'
import { repeatingScenarios } from './repeating'
import { caseScenarios } from './cases'
import { creationDayScenarios } from './creation-day'
import { ruleTimeScenarios } from './rule-time'
import { yearlyScenarios } from './yearly'
import { moveEarlierScenarios } from './move-earlier'
import { taskQueueScenarios } from './task-queue'
import { onDeckScenarios } from './on-deck'
import { onDeckRepeatingScenarios } from './on-deck-repeating'
import { repeatAnchorScenarios } from './repeat-anchor'
import { repeatEndsScenarios } from './repeat-ends'
import { deadlinesScenarios } from './deadlines'
import { relativeTargetScenarios } from './relative-target'
import { upcomingSectionsScenarios } from './upcoming-sections'

export const goldenScenarios = [
  ...oneOffScenarios,
  ...repeatingScenarios,
  ...caseScenarios,
  ...creationDayScenarios,
  ...ruleTimeScenarios,
  ...yearlyScenarios,
  ...moveEarlierScenarios,
  ...taskQueueScenarios,
  ...onDeckScenarios,
  ...onDeckRepeatingScenarios,
  ...repeatAnchorScenarios,
  ...repeatEndsScenarios,
  ...deadlinesScenarios,
  ...relativeTargetScenarios,
  ...upcomingSectionsScenarios,
]
