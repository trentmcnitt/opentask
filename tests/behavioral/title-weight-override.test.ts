/**
 * The TEMPORARY lean title weight override (`useTitleWeightOverride`): only
 * whole hundreds from 100 to 900 are a weight; anything else is no override.
 */
import { describe, expect, test } from 'vitest'
import { parseTitleWeight } from '@/hooks/useTitleWeightOverride'
import { OVER_TINTS, parseOverTint } from '@/hooks/useOverTintOverride'

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

describe('parseOverTint (TEMPORARY dev override)', () => {
  test('e0–e3 are options; anything else is none', () => {
    for (const k of ['e0', 'e1', 'e2', 'e3']) expect(parseOverTint(k)).toBe(k)
    for (const raw of [null, '', 'off', 'e4', 'E2', 'blue']) expect(parseOverTint(raw)).toBeNull()
  })
  test('E2 is the shipped default in the row (rgb 231,245,255 / 249,252,255)', () => {
    expect(OVER_TINTS.e2).toEqual({ over: 'rgb(231,245,255)', soon: 'rgb(249,252,255)' })
  })
})
