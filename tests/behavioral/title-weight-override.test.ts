/**
 * The TEMPORARY lean title weight override (`useTitleWeightOverride`): only
 * whole hundreds from 100 to 900 are a weight; anything else is no override.
 */
import { describe, expect, test } from 'vitest'
import { parseTitleWeight } from '@/hooks/useTitleWeightOverride'

describe('parseTitleWeight', () => {
  test('100–900 in hundreds', () => {
    expect(parseTitleWeight('500')).toBe(500)
    expect(parseTitleWeight('600')).toBe(600)
    expect(parseTitleWeight('100')).toBe(100)
    expect(parseTitleWeight('900')).toBe(900)
  })
  test('anything else is no override', () => {
    for (const raw of [null, '', 'off', '450', '1000', '0', 'bold', '50', '500px']) {
      expect(parseTitleWeight(raw)).toBeNull()
    }
  })
})
