import { Bot } from 'lucide-react'
import { PROVENANCE_LABELS } from '@/lib/label-vocabulary'

/**
 * AI LABELS (Trent, 2026-10-28): "anything AI shows the Bot glyph, wherever
 * it appears" — a label the assistant put there wears a small robot, so it
 * never reads as one Trent chose. The system labels that say something about
 * the AI: provenance (`ai-added`, `ai-proposed`, `ai-monitored`) and
 * enrichment's `ai-failed`. `ai-to-process` is never shown (the row's
 * shimmer says it).
 *
 * WHERE: on a task row only the AI labels that ask something of him —
 * `ai-proposed` (bless it) and `ai-failed` (retry it). `ai-added` and
 * `ai-monitored` are "irrelevant unless I'm doing forensics": the editor
 * shows them, rows don't (`ROW_HIDDEN_LABELS`). Display only — the task keeps
 * every label, and the API, search and the label filter see them all.
 */
export const AI_LABELS: ReadonlySet<string> = new Set([
  ...Object.values(PROVENANCE_LABELS),
  'ai-failed',
])

/** Labels a task row never shows: the editor does (see above). */
export const ROW_HIDDEN_LABELS: ReadonlySet<string> = new Set([
  'ai-to-process',
  PROVENANCE_LABELS.added,
  PROVENANCE_LABELS.monitored,
])

/** The Bot glyph for an AI label; sized for a label chip's text. */
export function AiLabelGlyph() {
  return <Bot data-ai-label-glyph aria-hidden className="size-3 shrink-0" />
}

/**
 * A label's name as a chip shows it: the Bot glyph first for an AI label.
 * A fragment, so inside a `Badge` the glyph is a direct child and takes the
 * badge's own gap.
 */
export function LabelName({ label }: { label: string }) {
  return (
    <>
      {AI_LABELS.has(label) && <AiLabelGlyph />}
      {label}
    </>
  )
}
