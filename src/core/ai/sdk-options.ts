/**
 * Claude Agent SDK options that both SDK entry points share: the cold query
 * in sdk.ts and the warm slots in warm-slot.ts.
 */

import type { Options, ThinkingConfig } from '@anthropic-ai/claude-agent-sdk'

/**
 * The Claude Code CLI runs with no filesystem settings: no ~/.claude or
 * project settings.json, so no hooks, plugins, MCP servers or permission
 * rules, and no CLAUDE.md in the context. Every SDK query and warm slot
 * passes this.
 *
 * Agent SDK 0.2.x did this by default: an omitted `settingSources` became
 * `[]` and the CLI got `--setting-sources ""`. From 0.3 an omitted
 * `settingSources` sends no flag, and the CLI then loads user, project and
 * local settings (a project hook fired under 0.3.303 + CLI 2.1.303 and not
 * under 0.2.37), so it must be passed explicitly to keep the subprocess
 * isolated. Transcript safety does not depend on it: cli-path.ts refuses CLIs
 * before 2.1.101, which honour `cleanupPeriodDays` either way.
 */
export const ISOLATED_SETTING_SOURCES: NonNullable<Options['settingSources']> = []

/**
 * A fixed extended-thinking budget, sent as the CLI flag
 * `--max-thinking-tokens N`.
 *
 * Agent SDK 0.3 deprecates the `maxThinkingTokens` option: it no longer goes
 * on the CLI's command line but is sent after start-up, and Opus 4.6+ reads it
 * only as on/off (adaptive thinking). `thinking: { type: 'enabled',
 * budgetTokens }` is what still emits `--max-thinking-tokens N`, the flag
 * 0.2.x sent for `maxThinkingTokens`.
 */
export function fixedThinkingBudget(budgetTokens: number): ThinkingConfig {
  return { type: 'enabled', budgetTokens }
}
