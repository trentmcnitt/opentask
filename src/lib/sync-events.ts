/**
 * In-memory sync event system for real-time cross-device updates
 *
 * Uses a simple EventEmitter to notify connected SSE clients when data changes.
 * Works because Next.js standalone mode runs a single long-lived Node.js process,
 * so all route handlers and SSE connections share the same module-level state.
 *
 * The globalThis pattern survives Turbopack module duplication in dev mode
 * (same approach as src/core/ai/enrichment-slot.ts).
 */

import { EventEmitter } from 'events'

export type SyncListener = (userId: number) => void

export interface EnrichmentCompletePayload {
  taskId: number
  title: string
  description?: string
  due_at?: string | null
  priority?: number
}

export type EnrichmentListener = (userId: number, payload: EnrichmentCompletePayload) => void

export interface TaskCreatedPayload {
  taskId: number
  title: string
}

export type TaskCreatedListener = (userId: number, payload: TaskCreatedPayload) => void

const globalForSync = globalThis as typeof globalThis & {
  __syncEmitter?: EventEmitter
}

if (!globalForSync.__syncEmitter) {
  globalForSync.__syncEmitter = new EventEmitter()
  globalForSync.__syncEmitter.setMaxListeners(100)
}

const emitter = globalForSync.__syncEmitter!

const SYNC_EVENT = 'sync'
const ENRICHMENT_COMPLETE_EVENT = 'enrichment_complete'
const TASK_CREATED_EVENT = 'task_created'

/** Emit a sync event for a user. Call after any data mutation. */
export function emitSyncEvent(userId: number): void {
  emitter.emit(SYNC_EVENT, userId)
}

/** Subscribe to sync events. Listener receives the userId that changed. */
export function onSyncEvent(listener: SyncListener): void {
  emitter.on(SYNC_EVENT, listener)
}

/** Unsubscribe from sync events. */
export function offSyncEvent(listener: SyncListener): void {
  emitter.off(SYNC_EVENT, listener)
}

/** Emit an enrichment complete event. Only used by on-demand enrichment (not cron queue). */
export function emitEnrichmentCompleteEvent(
  userId: number,
  payload: EnrichmentCompletePayload,
): void {
  emitter.emit(ENRICHMENT_COMPLETE_EVENT, userId, payload)
}

/** Subscribe to enrichment complete events. */
export function onEnrichmentCompleteEvent(listener: EnrichmentListener): void {
  emitter.on(ENRICHMENT_COMPLETE_EVENT, listener)
}

/** Unsubscribe from enrichment complete events. */
export function offEnrichmentCompleteEvent(listener: EnrichmentListener): void {
  emitter.off(ENRICHMENT_COMPLETE_EVENT, listener)
}

/** Emit a task-created event. Call after creating a task. */
export function emitTaskCreatedEvent(userId: number, payload: TaskCreatedPayload): void {
  emitter.emit(TASK_CREATED_EVENT, userId, payload)
}

/** Subscribe to task-created events. */
export function onTaskCreatedEvent(listener: TaskCreatedListener): void {
  emitter.on(TASK_CREATED_EVENT, listener)
}

/** Unsubscribe from task-created events. */
export function offTaskCreatedEvent(listener: TaskCreatedListener): void {
  emitter.off(TASK_CREATED_EVENT, listener)
}
