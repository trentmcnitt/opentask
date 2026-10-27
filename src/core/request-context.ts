/**
 * Request context — who is making this request, for the logs (2026-10-20)
 *
 * An `AsyncLocalStorage` store that lives for one API request, so the undo
 * and activity logs can record which client made a write (`client`,
 * `token_name`) without a parameter threaded through every core function.
 *
 * - `withLogging` (`src/lib/with-logging.ts`) opens the store around every
 *   route handler, with the path and the `X-OpenTask-Client` header.
 * - The auth step fills in how the request authenticated: `validateBearerToken`
 *   (the token's id, name and source — it is also what the notification
 *   actions route calls with a token from its body), the session and the
 *   proxy login.
 * - `logAction` and `logActivity` read `currentAttribution()` when they write.
 *   The client is resolved then, not when the store opens, because auth runs
 *   after `withLogging` has started.
 *
 * Outside any request — the cron jobs started in `instrumentation.ts` — there
 * is no store and every write is `system`. ALS follows async work started
 * inside a request, though, so work the request only kicks off (the
 * fire-and-forget AI enrichment on create) runs under `runAsSystem`, or it
 * would be stamped with the request's client.
 *
 * better-sqlite3 transactions are synchronous, so a write inside
 * `withTransaction` reads the same store as the code around it.
 *
 * The undo entry (2026-10-26, scoped native Undo): `logAction` also records
 * the undo_log id it wrote here (`recordUndoId`), and every mutation route the
 * native apps call answers it as `undo_id` (`requestUndoId`) — so a widget or
 * the watch can later undo exactly ITS action (`POST /api/undo { id }`), not
 * whatever came last from any device. A request that logs more than one entry
 * answers the newest (each write overwrites). Nothing is recorded under
 * `runAsSystem` or outside a request: a system write (enrichment, the quota
 * rollover) is never "the request's" action, and since `runAsSystem` opens a
 * store of its own, work it does inside a request can't overwrite the
 * request's id either.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { inferClient, type AuthMethod, type ClientId } from '@/lib/client-attribution'

export interface RequestContext {
  path: string | null
  /** The raw `X-OpenTask-Client` header, or null when absent. */
  header: string | null
  authMethod: AuthMethod | null
  tokenId: number | null
  tokenName: string | null
  tokenSource: string | null
  /** A route's own guess at the client (see `inferClient`). */
  hint: ClientId | null
  /** Set by `runAsSystem`: every write in it is `system`. */
  system?: boolean
  /** The newest undo_log id this request wrote (`recordUndoId`), or null. */
  undoId: number | null
}

export interface Attribution {
  client: ClientId
  /** The Bearer token's name, or null (session, proxy, system). */
  tokenName: string | null
}

const storage = new AsyncLocalStorage<RequestContext>()

/** Run `fn` with a fresh request context for `path` and the client header. */
export function runWithRequestContext<T>(
  init: { path: string | null; header: string | null },
  fn: () => T,
): T {
  return storage.run(
    {
      path: init.path,
      header: init.header,
      authMethod: null,
      tokenId: null,
      tokenName: null,
      tokenSource: null,
      hint: null,
      undoId: null,
    },
    fn,
  )
}

/**
 * Run `fn` as the system: every write in it (and in async work it starts) is
 * `client = 'system'`, even when called from inside a request.
 */
export function runAsSystem<T>(fn: () => T): T {
  return storage.run(
    {
      path: null,
      header: null,
      authMethod: null,
      tokenId: null,
      tokenName: null,
      tokenSource: null,
      hint: null,
      system: true,
      undoId: null,
    },
    fn,
  )
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore()
}

/** Record how the current request authenticated. A no-op outside a request. */
export function recordAuth(
  method: AuthMethod,
  token?: { id: number; name: string; source: string },
): void {
  const ctx = storage.getStore()
  if (!ctx || ctx.system) return
  ctx.authMethod = method
  ctx.tokenId = token?.id ?? null
  ctx.tokenName = token?.name ?? null
  ctx.tokenSource = token?.source ?? null
}

/** A route's guess at the client, used only when the header is absent. */
export function setClientHint(hint: ClientId): void {
  const ctx = storage.getStore()
  if (!ctx || ctx.system) return
  ctx.hint = hint
}

/** Record the undo_log id `logAction` just wrote. A no-op outside a request and as the system. */
export function recordUndoId(id: number): void {
  const ctx = storage.getStore()
  if (!ctx || ctx.system) return
  ctx.undoId = id
}

/** The newest undo_log id this request wrote — a route's `undo_id` — or null. */
export function requestUndoId(): number | null {
  const ctx = storage.getStore()
  return !ctx || ctx.system ? null : ctx.undoId
}

/** Who is writing right now: `system` outside a request. */
export function currentAttribution(): Attribution {
  const ctx = storage.getStore()
  if (!ctx || ctx.system) return { client: 'system', tokenName: null }
  return { client: inferClient(ctx), tokenName: ctx.tokenName }
}
