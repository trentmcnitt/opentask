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

/**
 * What a sync event says about the change, beyond "user N's data changed".
 *
 * `widgets: false` marks a change no widget can show (a notes-only edit, an
 * `ai-*` label shuffle), so the WidgetKit push listener skips it — widget
 * pushes are budgeted by iOS, and one spent on an invisible change is one
 * fewer for a real one (`@/core/notifications/widget-push`). Open browser tabs
 * still refresh either way. Omitted means visible: an unmarked emit costs at
 * most a push, a wrongly-marked one leaves a widget stale, so only opt out
 * where the change is provably invisible to every widget.
 */
export interface SyncEventInfo {
  widgets?: boolean
}

export type SyncListener = (userId: number, info: SyncEventInfo) => void

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
export function emitSyncEvent(userId: number, info: SyncEventInfo = {}): void {
  emitter.emit(SYNC_EVENT, userId, info)
}

/** Subscribe to sync events. Listener receives the userId that changed and the event's info. */
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
