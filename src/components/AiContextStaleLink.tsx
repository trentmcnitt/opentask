'use client'

import { GuardedLink } from '@/components/GuardedLink'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useAiContextStaleness } from '@/hooks/useAiContextStaleness'
import { AI_CONTEXT_SETTINGS_HREF, aiContextStalenessLabel } from '@/lib/ai-context-staleness'

/**
 * THE AI CONTEXT IS DUE A LOOK (task-model redesign, 2026-10-10): a quiet
 * nudge to Settings → AI Context once the context is 21+ days old or was
 * never written (`src/lib/ai-context-staleness.ts`), and only while AI is on
 * for a non-demo user (`useAiContextStaleness`).
 *
 * Text only, muted, no icon and no new hue: nothing is broken, it is a nudge,
 * and an amber line would read as a fault. Rendered only while stale — no
 * placeholder otherwise.
 *
 * Two homes, one per layout: a line at the foot of the desktop left bar,
 * beside Settings (`AiContextStaleSidebarLink`), and an item under Settings
 * in the top bar's menu on a phone (`AiContextStaleMenuItem`), which is where
 * Settings lives there.
 */
export function AiContextStaleSidebarLink() {
  const stale = useAiContextStaleness()
  if (!stale) return null
  return (
    <GuardedLink
      href={AI_CONTEXT_SETTINGS_HREF}
      data-ai-context-stale
      className="text-muted-foreground hover:text-foreground block rounded-lg px-3 py-1 text-xs transition-colors"
    >
      {aiContextStalenessLabel(stale)}
    </GuardedLink>
  )
}

/** The phone's copy: an indented item under Settings, hidden from `md` up (the left bar has it). */
export function AiContextStaleMenuItem() {
  const stale = useAiContextStaleness()
  if (!stale) return null
  return (
    <DropdownMenuItem asChild className="text-muted-foreground pl-8 text-xs md:hidden">
      <GuardedLink href={AI_CONTEXT_SETTINGS_HREF} data-ai-context-stale>
        {aiContextStalenessLabel(stale)}
      </GuardedLink>
    </DropdownMenuItem>
  )
}
