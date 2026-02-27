import { describe, test, expect, beforeAll } from 'vitest'
import { apiAnon, resetTestData } from './helpers'

describe('OpenAPI spec', () => {
  beforeAll(async () => {
    await resetTestData()
  })

  test('returns 200 with YAML content', async () => {
    const res = await apiAnon('/api/openapi')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/yaml')

    const text = await res.text()
    expect(text).toContain('openapi: 3.1.0')
    expect(text).toContain('OpenTask API')
  })

  test('contains expected paths', async () => {
    const res = await apiAnon('/api/openapi')
    const text = await res.text()

    expect(text).toContain('/api/tasks:')
    expect(text).toContain('/api/projects:')
    expect(text).toContain('/api/export:')
    expect(text).toContain('/api/webhooks:')
    expect(text).toContain('/api/tokens:')
    expect(text).toContain('/api/health:')
    expect(text).toContain('/api/undo:')
    expect(text).toContain('/api/redo:')
  })

  test('does not require auth', async () => {
    const res = await apiAnon('/api/openapi')
    expect(res.status).toBe(200)
  })
})
