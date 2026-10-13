/**
 * The quota count as segments (2026-10-13): the words, the fills and the fit
 * rule behind `QuotaSegments` — pure, so no DB.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_SEGMENTS,
  chooseQuotaCountForm,
  quotaCountAriaLabel,
  quotaCountText,
  quotaSegmentWord,
  segmentFills,
} from '@/lib/quota-segments'

describe('quota segments: words', () => {
  it('uses the short period word after the segments', () => {
    expect(quotaSegmentWord('DAILY')).toBe('today')
    expect(quotaSegmentWord('WEEKLY')).toBe('week')
    expect(quotaSegmentWord('MONTHLY')).toBe('month')
    expect(quotaSegmentWord('YEARLY')).toBe('year')
  })

  it('has no word for a period-less quota', () => {
    expect(quotaSegmentWord(null)).toBeNull()
    expect(quotaSegmentWord(undefined)).toBeNull()
    expect(quotaSegmentWord('HOURLY')).toBeNull()
  })

  it('names the group in natural words', () => {
    expect(quotaCountAriaLabel(1, 2, 'DAILY')).toBe('1 of 2 today')
    expect(quotaCountAriaLabel(1, 2, 'WEEKLY')).toBe('1 of 2 this week')
    expect(quotaCountAriaLabel(1, 2, 'MONTHLY')).toBe('1 of 2 this month')
    expect(quotaCountAriaLabel(0, 1, 'YEARLY')).toBe('0 of 1 this year')
    expect(quotaCountAriaLabel(3, 5, null)).toBe('3 of 5')
  })

  it('writes the text fallback as "3/7 today"', () => {
    expect(quotaCountText(3, 7, 'today')).toBe('3/7 today')
    expect(quotaCountText(3, 7, 'week')).toBe('3/7 week')
    expect(quotaCountText(3, 7, null)).toBe('3/7')
  })
})

describe('quota segments: fills', () => {
  it('shows one segment for a 1x quota', () => {
    expect(segmentFills(0, 1)).toEqual(['empty'])
    expect(segmentFills(1, 1)).toEqual(['met'])
  })

  it('fills indigo per completion while open', () => {
    expect(segmentFills(0, 3)).toEqual(['empty', 'empty', 'empty'])
    expect(segmentFills(2, 3)).toEqual(['filled', 'filled', 'empty'])
  })

  it('turns every segment green once met, overflow included', () => {
    expect(segmentFills(3, 3)).toEqual(['met', 'met', 'met'])
    expect(segmentFills(5, 2)).toEqual(['met', 'met'])
  })
})

describe('quota segments: the fit rule', () => {
  const widths = { segmentsWidth: 80, textWidth: 50 }

  it('is text above six segments, whatever the room', () => {
    expect(MAX_SEGMENTS).toBe(6)
    expect(chooseQuotaCountForm({ target: 7 })).toBe('text')
    expect(chooseQuotaCountForm({ target: 7, available: 1000, ...widths })).toBe('text')
    expect(chooseQuotaCountForm({ target: 6, available: 1000, ...widths })).toBe('segments')
  })

  it('is segments when nothing is measured (own column, or first render)', () => {
    expect(chooseQuotaCountForm({ target: 3 })).toBe('segments')
    expect(chooseQuotaCountForm({ target: 3, available: 10 })).toBe('segments')
  })

  it('keeps segments when they fit the line, exactly at the edge too', () => {
    expect(chooseQuotaCountForm({ target: 3, available: 200, ...widths })).toBe('segments')
    expect(chooseQuotaCountForm({ target: 3, available: 80, ...widths })).toBe('segments')
  })

  it('falls back to text when only the text fits', () => {
    expect(chooseQuotaCountForm({ target: 3, available: 79.5, ...widths })).toBe('text')
    expect(chooseQuotaCountForm({ target: 3, available: 50, ...widths })).toBe('text')
  })

  it('wraps the segments as one piece when neither fits', () => {
    expect(chooseQuotaCountForm({ target: 3, available: 49, ...widths })).toBe('segments')
    expect(chooseQuotaCountForm({ target: 3, available: -4, ...widths })).toBe('segments')
  })
})
