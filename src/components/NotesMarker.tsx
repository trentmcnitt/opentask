import { StickyNote } from 'lucide-react'

/**
 * The "this has notes" footnote after a reminder's (or a quota prompt's)
 * title: a small muted page glyph, inline in the title's own paragraph.
 *
 * One component for every row that wears it — the Reminders surface's
 * `ReminderRow`, the dashboard card's `PanelRow`, and `QuotaPromptRow` in both
 * variants — so the mark cannot drift between surfaces.
 *
 * Inline after the title rather than pinned to the right edge: on a wide screen
 * a lone icon across the row reads as an unrelated control, and this one is
 * only ever a footnote. Sized and lifted in `em`, so it follows the title's
 * own size: 14px beside the surface's 16px text (exactly what it was drawn at
 * before this was shared), a little smaller beside the card's 13.5px.
 *
 * Callers decide whether there ARE notes — `!!notes?.trim()` for a task, the
 * server's `has_notes` for a prompt — and render nothing when there are none.
 */
export function NotesMarker() {
  return (
    <span className="text-muted-foreground/50 ml-1.5 inline-flex align-[-0.125em]" data-has-notes>
      <StickyNote className="size-[0.875em]" aria-label="Has notes" />
    </span>
  )
}
