/**
 * The firm cap on a project's description (task-model redesign, 2026-10-10):
 * one or two sentences saying what belongs in the project, so the AI and the
 * desks that create tasks over the API pick the right one (the AI prompts read
 * it once the enrichment side wires it in). Long enough for
 * "Client work for Acme: invoices, calls, deliverables — not personal admin",
 * short enough that it stays a definition rather than a notes field.
 *
 * Lives here, dependency-free, so Settings can show the count without pulling
 * zod into the client bundle; `@/core/validation` re-exports it and enforces it.
 */
export const PROJECT_DESCRIPTION_MAX = 280
