/**
 * THE SHELVED AI FEATURES (2026-10-22, Trent): What's Next, Insights and
 * Quick Take are shelved — the whole feature set, until they are redesigned.
 * Enrichment and Process are the AI features that run: Process has its own
 * mode (`ai_process_mode`) and is not under this switch (src/core/ai/process.ts).
 *
 * `OPENTASK_AI_UNSHELVE=1` brings all three back; unset (the default, and
 * production) keeps them shelved:
 *
 * - the 03:00 What's Next and 03:30 Insights jobs are not scheduled
 *   (`src/instrumentation.ts`) and the runners return at once
 *   (`src/core/ai/scheduled.ts`);
 * - every What's Next, Insights and Quick Take endpoint answers 410
 *   `FEATURE_SHELVED` (`featureShelved()` in `src/lib/api-response.ts`), and
 *   so does the Settings "Test" call for those three features;
 * - `GET /api/user/preferences` reports `ai_unshelved: false`, and the web
 *   hides every surface of the three (the dashboard's AI chip, the What's
 *   Next / Insights chips, score and signal chips, row commentary, the AI
 *   Score sort, the Quick Take banner, their rows in Settings → AI and in
 *   AI Status).
 *
 * Nothing is written: each user's `ai_*_mode` and view preferences stay as
 * they were, so turning the switch on restores exactly what they had.
 *
 * A server-wide switch like `OPENTASK_TASK_QUEUE` (src/core/tasks/task-queue.ts),
 * not a per-user setting. Read at call time, never cached, so a test can flip
 * it with `vi.stubEnv('OPENTASK_AI_UNSHELVE', '1')`. Kept free of imports so
 * client code can share the feature list below.
 *
 * Do not "fix" or re-enable these features without Trent.
 */
export function shelvedAiFeaturesOn(): boolean {
  return process.env.OPENTASK_AI_UNSHELVE === '1'
}

/** The message every shelved endpoint answers with (410 FEATURE_SHELVED). */
export const AI_SHELVED_MESSAGE = "What's Next, Insights and Quick Take are shelved"

/** The shelved features, as `AIFeature` keys (`src/core/ai/models.ts`). */
export const SHELVED_AI_FEATURES = ['quick_take', 'whats_next', 'insights'] as const
