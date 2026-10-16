/**
 * The longest AI context (Settings › AI Context) a user can save, in
 * characters after trimming. The server rejects a longer one
 * (`PATCH /api/user/preferences`), and the Settings field stops typing there.
 *
 * 4,000 since 2026-10-16 (was 1,000): room for a household, a work schedule
 * and what each project is for. Every AI prompt embeds the context whole —
 * nothing downstream truncates it.
 */
export const AI_CONTEXT_MAX_LENGTH = 4000
