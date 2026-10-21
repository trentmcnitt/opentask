/**
 * Client attribution — which client made a write (2026-10-20)
 *
 * Every undo_log and activity_log row records the client that made it, so
 * "did a session snooze my tasks?" has an answer beyond `[token]`. Clients
 * say who they are with the `X-OpenTask-Client` header; until every client
 * sends it, `inferClient` guesses from what the server already knows (the
 * auth method, the token's name and source, the path).
 *
 * Pure and free of server imports: the History page reads `CLIENT_LABELS`.
 * The server side (the request context that feeds this) is
 * `src/core/request-context.ts`.
 */

/** The header a client names itself in. */
export const CLIENT_HEADER = 'X-OpenTask-Client'

/** The values a client may send in `X-OpenTask-Client`. */
export const SENT_CLIENTS = [
  'web',
  'ios',
  'watch',
  'mac',
  'widget',
  'notification',
  'shortcut',
  'cli',
  'desk',
] as const

export type SentClient = (typeof SENT_CLIENTS)[number]

/**
 * What a log row stores: a sent value, `system` for a write outside any
 * request (cron jobs, AI enrichment), or `unknown`.
 */
export type ClientId = SentClient | 'system' | 'unknown'

/** How the request authenticated, as the auth step records it. */
export type AuthMethod = 'token' | 'session' | 'proxy'

export interface ClientInferenceInput {
  /** The raw `X-OpenTask-Client` value, or null when the header is absent. */
  header: string | null
  /** The request path (`/api/tasks/bulk/snooze-overdue`). */
  path: string | null
  authMethod: AuthMethod | null
  /** `api_tokens.name` / `.source` for a Bearer token. */
  tokenName: string | null
  tokenSource: string | null
  /**
   * A route's own guess, from the body: `/api/tasks/bulk/snooze-overdue` with
   * `notify: false` is the Home Screen quick action or a Shortcut.
   */
  hint: ClientId | null
}

const SENT = new Set<string>(SENT_CLIENTS)

/** Token names that mean a CLI: "Claude Code", the hub's "hub" token, "cli". */
const CLI_TOKEN_NAME = /claude|\bcli\b|^hub$/i

/**
 * Which client made this request.
 *
 * The header always wins: a known value is used as sent, any other value is
 * `unknown` (never a rejected request). Only with no header at all does the
 * server infer, in this order — the order matters, because the notification
 * actions and the Home Screen quick actions use the iOS app's own token:
 *
 * 1. `/api/notifications/actions` → `notification`
 * 2. a route hint (snooze-overdue with `notify: false`) → that hint
 * 3. a session cookie or proxy login → `web` (the native apps' web views use
 *    a session after `session-from-token`, and then they ARE the web UI)
 * 4. a manual token named like Shortcuts → `shortcut`
 * 5. a token named like Claude Code / the CLI → `cli`
 * 6. an `ios`-source token → `ios` (iPhone, Watch and widgets look alike
 *    until the native apps send the header)
 * 7. else `unknown`
 */
export function inferClient(input: ClientInferenceInput): ClientId {
  if (input.header !== null) {
    const value = input.header.trim().toLowerCase()
    return SENT.has(value) ? (value as SentClient) : 'unknown'
  }
  if (input.path === '/api/notifications/actions') return 'notification'
  if (input.hint) return input.hint
  if (input.authMethod === 'session' || input.authMethod === 'proxy') return 'web'
  if (input.authMethod === 'token') {
    const name = input.tokenName ?? ''
    if (input.tokenSource === 'manual' && /shortcut/i.test(name)) return 'shortcut'
    if (CLI_TOKEN_NAME.test(name)) return 'cli'
    if (input.tokenSource === 'ios') return 'ios'
  }
  return 'unknown'
}

/** What the History page shows after an entry. `unknown` shows nothing. */
export const CLIENT_LABELS: Record<ClientId, string | null> = {
  web: 'Web',
  ios: 'iPhone',
  watch: 'Watch',
  mac: 'Mac',
  widget: 'Widget',
  notification: 'Notification',
  shortcut: 'Shortcut',
  cli: 'CLI',
  desk: 'Desk',
  system: 'System',
  unknown: null,
}

/** The label for a stored client value (null for unknown, missing or old rows). */
export function clientLabel(client: string | null | undefined): string | null {
  if (!client) return null
  return (CLIENT_LABELS as Record<string, string | null>)[client] ?? null
}
