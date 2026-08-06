import { describe, test, expect } from 'vitest'
import { safeCallbackUrl, loginUrlFor } from '@/lib/login-redirect'

describe('safeCallbackUrl', () => {
  test('accepts relative paths', () => {
    expect(safeCallbackUrl('/tasks/123')).toBe('/tasks/123')
    expect(safeCallbackUrl('/?task=123')).toBe('/?task=123')
    expect(safeCallbackUrl('/history?tab=undo')).toBe('/history?tab=undo')
  })

  test('rejects protocol-relative and absolute URLs (open redirect)', () => {
    expect(safeCallbackUrl('//evil.example.com')).toBe('/')
    expect(safeCallbackUrl('/\\evil.example.com')).toBe('/')
    expect(safeCallbackUrl('https://evil.example.com')).toBe('/')
    expect(safeCallbackUrl('javascript:alert(1)')).toBe('/')
  })

  test('falls back to / for missing or non-string input', () => {
    expect(safeCallbackUrl(null)).toBe('/')
    expect(safeCallbackUrl(undefined)).toBe('/')
    expect(safeCallbackUrl('')).toBe('/')
  })
})

describe('loginUrlFor', () => {
  test('encodes the destination as a callbackUrl query param', () => {
    expect(loginUrlFor('/tasks/123')).toBe('/login?callbackUrl=%2Ftasks%2F123')
    expect(loginUrlFor('/?task=123')).toBe('/login?callbackUrl=%2F%3Ftask%3D123')
  })

  test('omits the param for the default destination', () => {
    expect(loginUrlFor('/')).toBe('/login')
  })

  test('drops unsafe destinations instead of forwarding them', () => {
    expect(loginUrlFor('//evil.example.com')).toBe('/login')
    expect(loginUrlFor('https://evil.example.com/x')).toBe('/login')
  })
})
