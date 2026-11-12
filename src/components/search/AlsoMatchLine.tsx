'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CalendarClock, ChevronRight } from 'lucide-react'
import {
  alsoMatchWords,
  countSearchKinds,
  dashboardSearchHref,
  searchKindOf,
  type SearchKind,
} from '@/lib/search-kinds'
import type { Task } from '@/types'

/**
 * "3 TASKS ALSO MATCH “FERN” · SHOW THEM" (Trent, 2026-11-12, mockup R2):
 * the Reminders and Quotas tabs search in place — what they already show —
 * and this one line says what ELSE matches and takes it to the dashboard's
 * search, where every kind is listed (`src/lib/search-kinds.ts`).
 *
 * One request per query (the server's own search, so "matches" means what it
 * means on the dashboard). Counted here: every hit that is not this tab's
 * kind and is not already on screen (`shownIds` — the Reminders tab shows a
 * matching quota's prompt row itself). Nothing else matches: no line.
 */
export function AlsoMatchLine({
  query,
  own,
  shownIds,
}: {
  /** The search as typed (trimmed); empty = no search, no line. */
  query: string
  /** This tab's kind, never counted. */
  own: SearchKind
  /** Ids already drawn on this tab for the search. */
  shownIds?: ReadonlySet<number>
}) {
  const [found, setFound] = useState<{ query: string; hits: Task[] } | null>(null)
  useEffect(() => {
    if (!query) return
    const abort = new AbortController()
    fetch(`/api/tasks?search=${encodeURIComponent(query)}&limit=1000`, { signal: abort.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (body) setFound({ query, hits: (body.data?.tasks ?? []) as Task[] })
      })
      .catch(() => {
        // Aborted by the next keystroke, or offline: no line.
      })
    return () => abort.abort()
  }, [query])

  // Only the answer to THIS query: an older one never stands in.
  if (!query || found?.query !== query) return null
  const others = found.hits.filter((t) => searchKindOf(t) !== own && !shownIds?.has(t.id))
  const words = alsoMatchWords(countSearchKinds(others))
  if (!words) return null
  return (
    <Link
      href={dashboardSearchHref(query)}
      data-also-match
      className="bg-muted/40 hover:bg-muted/70 mb-4 flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm"
    >
      <CalendarClock className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {words} &ldquo;{query}&rdquo; · show them
      </span>
      <ChevronRight className="text-muted-foreground/60 size-4 shrink-0" aria-hidden />
    </Link>
  )
}
