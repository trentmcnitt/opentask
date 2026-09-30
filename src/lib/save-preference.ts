import { showToast } from '@/lib/toast'

/**
 * One optimistic save of a user preference, the way every Settings control
 * does it:
 *
 *   1. `apply()` — show the new value at once (optimistic).
 *   2. PATCH `/api/user/preferences` with `body`.
 *   3. Success: toast `successMessage` and return the response's `data` (the
 *      full preferences object — the AI mode switches read `ai_feature_info`
 *      from it).
 *   4. A non-2xx answer or a network failure: `revert()` to the old value and
 *      toast `errorMessage`; returns `undefined`.
 *
 * The toast strings default to the generic "Preference saved" pair most
 * controls use; the labels, AI context and notifications switches pass their
 * own. A body that isn't JSON still counts as saved (the PATCH succeeded) and
 * returns `undefined`.
 *
 * Not for PreferencesProvider's coalescing saver (grouping, sort, collapsed
 * groups…), which batches rapid changes and saves silently.
 */
export async function savePreference<T = Record<string, unknown>>(
  body: Record<string, unknown>,
  {
    apply,
    revert,
    successMessage = 'Preference saved',
    errorMessage = 'Failed to save preference',
  }: {
    apply: () => void
    revert: () => void
    successMessage?: string
    errorMessage?: string
  },
): Promise<T | undefined> {
  apply()
  let res: Response | null = null
  try {
    res = await fetch('/api/user/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    // Network failure: handled with a non-2xx below.
  }
  if (!res?.ok) {
    revert()
    showToast({ message: errorMessage, type: 'error' })
    return undefined
  }
  const json = (await res.json().catch(() => null)) as { data?: T } | null
  showToast({ message: successMessage, type: 'success' })
  return json?.data
}

/**
 * The common case of `savePreference()`: one field, one setter, the generic
 * toasts. `prev` is the value to put back if the save fails.
 */
export function savePreferenceField<T>(
  field: string,
  value: T,
  prev: T,
  setter: (v: T) => void,
): Promise<Record<string, unknown> | undefined> {
  return savePreference(
    { [field]: value },
    { apply: () => setter(value), revert: () => setter(prev) },
  )
}
