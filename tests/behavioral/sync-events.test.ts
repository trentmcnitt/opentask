/**
 * Sync events behavioral tests
 *
 * Tests the in-memory EventEmitter-based sync system: listener registration,
 * unregistration, user isolation, and event payloads.
 */

import { describe, test, expect } from 'vitest'
import {
  emitSyncEvent,
  onSyncEvent,
  offSyncEvent,
  emitEnrichmentCompleteEvent,
  onEnrichmentCompleteEvent,
  offEnrichmentCompleteEvent,
  emitTaskCreatedEvent,
  onTaskCreatedEvent,
  offTaskCreatedEvent,
  type EnrichmentCompletePayload,
  type TaskCreatedPayload,
} from '@/lib/sync-events'

describe('Sync events', () => {
  describe('Sync event', () => {
    test('registered listener is called on emit', () => {
      const calls: number[] = []
      const listener = (userId: number) => calls.push(userId)

      onSyncEvent(listener)
      emitSyncEvent(42)

      expect(calls).toEqual([42])

      offSyncEvent(listener)
    })

    test('unregistered listener is NOT called', () => {
      const calls: number[] = []
      const listener = (userId: number) => calls.push(userId)

      onSyncEvent(listener)
      offSyncEvent(listener)
      emitSyncEvent(42)

      expect(calls).toEqual([])
    })

    test('multiple listeners for same event are all called', () => {
      const calls1: number[] = []
      const calls2: number[] = []
      const listener1 = (userId: number) => calls1.push(userId)
      const listener2 = (userId: number) => calls2.push(userId)

      onSyncEvent(listener1)
      onSyncEvent(listener2)
      emitSyncEvent(42)

      expect(calls1).toEqual([42])
      expect(calls2).toEqual([42])

      offSyncEvent(listener1)
      offSyncEvent(listener2)
    })

    test('listeners receive all user IDs (filtering is done by consumer)', () => {
      // The EventEmitter doesn't filter by userId — that's done in the SSE stream handler.
      // All listeners receive the event regardless of userId.
      const receivedUserIds: number[] = []
      const listener = (userId: number) => receivedUserIds.push(userId)

      onSyncEvent(listener)
      emitSyncEvent(1)
      emitSyncEvent(2)

      expect(receivedUserIds).toEqual([1, 2])

      offSyncEvent(listener)
    })
  })

  describe('Enrichment complete event', () => {
    test('listener receives correct payload', () => {
      const received: Array<{ userId: number; payload: EnrichmentCompletePayload }> = []
      const listener = (userId: number, payload: EnrichmentCompletePayload) => {
        received.push({ userId, payload })
      }

      onEnrichmentCompleteEvent(listener)
      emitEnrichmentCompleteEvent(1, {
        taskId: 100,
        title: 'Test task',
        description: 'Updated description',
        due_at: '2026-06-15T09:00:00Z',
        priority: 3,
      })

      expect(received).toHaveLength(1)
      expect(received[0].userId).toBe(1)
      expect(received[0].payload.taskId).toBe(100)
      expect(received[0].payload.title).toBe('Test task')
      expect(received[0].payload.description).toBe('Updated description')
      expect(received[0].payload.due_at).toBe('2026-06-15T09:00:00Z')
      expect(received[0].payload.priority).toBe(3)

      offEnrichmentCompleteEvent(listener)
    })

    test('listener receives payload with optional fields omitted', () => {
      const received: EnrichmentCompletePayload[] = []
      const listener = (_userId: number, payload: EnrichmentCompletePayload) => {
        received.push(payload)
      }

      onEnrichmentCompleteEvent(listener)
      emitEnrichmentCompleteEvent(1, {
        taskId: 200,
        title: 'Minimal enrichment',
      })

      expect(received).toHaveLength(1)
      expect(received[0].taskId).toBe(200)
      expect(received[0].description).toBeUndefined()
      expect(received[0].due_at).toBeUndefined()
      expect(received[0].priority).toBeUndefined()

      offEnrichmentCompleteEvent(listener)
    })
  })

  describe('Task created event', () => {
    test('listener receives correct payload', () => {
      const received: Array<{ userId: number; payload: TaskCreatedPayload }> = []
      const listener = (userId: number, payload: TaskCreatedPayload) => {
        received.push({ userId, payload })
      }

      onTaskCreatedEvent(listener)
      emitTaskCreatedEvent(5, { taskId: 42, title: 'New task' })

      expect(received).toHaveLength(1)
      expect(received[0].userId).toBe(5)
      expect(received[0].payload.taskId).toBe(42)
      expect(received[0].payload.title).toBe('New task')

      offTaskCreatedEvent(listener)
    })
  })
})
