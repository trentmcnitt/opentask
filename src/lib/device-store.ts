/**
 * A small PER-DEVICE preference store: a value in `localStorage`, read
 * through `useSyncExternalStore` so the server render (the default) and the
 * first client render agree and a stored value applies right after
 * hydration. Every storage access is wrapped: private windows and blocked
 * site data throw, and then the value lives in memory for the visit. The
 * row style (`useTaskRowStyle`) is the same shape, written before this.
 */
export interface DeviceStore<T> {
  read: () => T
  write: (next: T) => void
  subscribe: (listener: () => void) => () => void
  serverSnapshot: () => T
}

export function deviceStore<T>(
  key: string,
  fallback: T,
  parse: (raw: string) => T | null,
  serialize: (value: T) => string = String,
  /** A value the page's URL asks for, read once (it wins over the stored one, and is stored). */
  fromUrl?: () => T | null,
): DeviceStore<T> {
  let current: { value: T } | null = null
  const listeners = new Set<() => void>()
  const store = (next: T) => {
    try {
      window.localStorage.setItem(key, serialize(next))
    } catch {
      // In memory only for this visit.
    }
  }
  return {
    read() {
      if (current) return current.value
      let value = fallback
      try {
        const raw = window.localStorage.getItem(key)
        const parsed = raw === null ? null : parse(raw)
        if (parsed !== null) value = parsed
      } catch {
        // No storage: the default.
      }
      const asked = fromUrl?.() ?? null
      if (asked !== null) {
        value = asked
        store(asked)
      }
      current = { value }
      return value
    },
    write(next) {
      current = { value: next }
      store(next)
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    serverSnapshot: () => fallback,
  }
}
