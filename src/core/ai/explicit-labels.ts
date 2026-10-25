/**
 * Labels are explicit-only (§7.2): the AI never infers a label from what a
 * task is about. The model's labels survive only when the user's own words
 * ask for one ("label it X", "tag it X", "mark it as X", "add the X label").
 * Belt-and-suspenders: the prompt already says so, and this is the guard.
 *
 * Shared by the task path (`collectEnrichmentChanges`) and the quota path
 * (`postProcessQuotaEnrichment`), so the two cannot disagree.
 */
export function filterExplicitLabels(labels: string[], inputText: string): string[] {
  const labelIntentPattern = /\b(label\s+it|tag\s+it|mark\s+it\s+as|add\s+the\s+\w+\s+label)\b/i
  if (labelIntentPattern.test(inputText)) {
    return labels
  }
  return []
}
