/**
 * Leveled logger with namespace filtering and tree-shaking support.
 *
 * Usage:
 *   import { log } from '@/lib/logger'
 *   log.error('api', 'GET /api/tasks error:', err)
 *   log.info('cron', 'Running undo log purge')
 *   log.debug('keyboard-nav', 'handleKeyDown:', e.key, { state })
 *
 * Or individual imports:
 *   import { trace, debug, info, warn, error } from '@/lib/logger'
 *
 * Configuration (env vars):
 *   LOG_LEVEL: trace | debug | info | warn | error (default: warn in prod, trace in dev)
 *   LOG_NAMESPACES: comma-separated list or '*' (default: '*')
 *   NEXT_PUBLIC_LOG_LEVEL: client-side level
 *   NEXT_PUBLIC_LOG_NAMESPACES: client-side namespaces
 *
 * In production builds, trace and debug calls are tree-shaken out entirely.
 */

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'
type LogFn = (namespace: string, ...args: unknown[]) => void

const LEVELS: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
}

// Get config from env - use NEXT_PUBLIC_ variants for client-side
const getLogLevel = (): LogLevel => {
  const envLevel =
    typeof window !== 'undefined'
      ? process.env.NEXT_PUBLIC_LOG_LEVEL
      : process.env.LOG_LEVEL || process.env.NEXT_PUBLIC_LOG_LEVEL

  if (envLevel && envLevel in LEVELS) {
    return envLevel as LogLevel
  }

  // Default: warn in production, trace in development
  return process.env.NODE_ENV === 'production' ? 'warn' : 'trace'
}

const getNamespaces = (): string[] => {
  const envNamespaces =
    typeof window !== 'undefined'
      ? process.env.NEXT_PUBLIC_LOG_NAMESPACES
      : process.env.LOG_NAMESPACES || process.env.NEXT_PUBLIC_LOG_NAMESPACES

  if (!envNamespaces || envNamespaces === '*') {
    return ['*']
  }

  return envNamespaces.split(',').map((ns) => ns.trim())
}

const isNamespaceEnabled = (namespace: string, namespaces: string[]): boolean => {
  if (namespaces.includes('*')) return true
  if (namespaces.includes(namespace)) return true

  // Support wildcards like 'ui:*' matching 'ui:button', 'ui:form', etc.
  for (const pattern of namespaces) {
    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -1) // 'ui:*' -> 'ui:'
      if (namespace.startsWith(prefix)) return true
    }
  }

  return false
}

const shouldLog = (level: LogLevel, namespace: string): boolean => {
  const minLevel = getLogLevel()
  const namespaces = getNamespaces()

  if (LEVELS[level] < LEVELS[minLevel]) return false
  if (!isNamespaceEnabled(namespace, namespaces)) return false

  return true
}

const logAtLevel = (level: LogLevel, namespace: string, args: unknown[]): void => {
  if (!shouldLog(level, namespace)) return

  const prefix = `[${level}] [${namespace}]`
  const consoleFn = level === 'trace' ? console.debug : console[level]
  consoleFn(prefix, ...args)
}

// Tree-shakeable exports: in production, trace and debug become empty functions
// that get eliminated by the bundler
export const trace: LogFn =
  process.env.NODE_ENV === 'production'
    ? () => {}
    : (namespace, ...args) => logAtLevel('trace', namespace, args)

export const debug: LogFn =
  process.env.NODE_ENV === 'production'
    ? () => {}
    : (namespace, ...args) => logAtLevel('debug', namespace, args)

// info, warn, error are always available (not tree-shaken)
export const info: LogFn = (namespace, ...args) => logAtLevel('info', namespace, args)
export const warn: LogFn = (namespace, ...args) => logAtLevel('warn', namespace, args)
export const error: LogFn = (namespace, ...args) => logAtLevel('error', namespace, args)

// Convenience object for log.error(), log.info(), etc.
export const log = {
  trace,
  debug,
  info,
  warn,
  error,
}
