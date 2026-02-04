/**
 * Debug logging utility for development troubleshooting.
 *
 * Usage:
 *   import { debugLog } from '@/lib/debug-log'
 *   debugLog('keyboard-nav', 'handleKeyDown:', e.key, { state })
 *
 * Enable specific namespaces by setting DEBUG_NAMESPACES below.
 * Set to ['*'] to enable all, or [] to disable all.
 */

// Add namespace strings here to enable logging for specific areas
const DEBUG_NAMESPACES: string[] = [
  // 'keyboard-nav',  // Keyboard navigation focus/blur/keydown
  // 'selection',     // Selection mode toggle/clear
  // '*',             // Enable all namespaces
]

const isEnabled = (namespace: string): boolean => {
  if (DEBUG_NAMESPACES.length === 0) return false
  if (DEBUG_NAMESPACES.includes('*')) return true
  return DEBUG_NAMESPACES.includes(namespace)
}

export function debugLog(namespace: string, ...args: unknown[]): void {
  if (isEnabled(namespace)) {
    console.log(`[${namespace}]`, ...args)
  }
}
