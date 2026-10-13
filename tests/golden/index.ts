/** Every golden scenario, for the runner (`tests/behavioral/golden.test.ts`). */
import { oneOffScenarios } from './one-offs'
import { repeatingScenarios } from './repeating'
import { caseScenarios } from './cases'
import { creationDayScenarios } from './creation-day'

export const goldenScenarios = [
  ...oneOffScenarios,
  ...repeatingScenarios,
  ...caseScenarios,
  ...creationDayScenarios,
]
