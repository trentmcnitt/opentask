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

/**
 * Every OpenTask SDK query runs with NO tools (2026-11-09). The model reads
 * untrusted text — task titles from inbound email (desk comms), shared
 * content, Shortcut input — and answers with JSON, nothing else. Until this,
 * the CLI ran with every built-in tool and `bypassPermissions`, so a title
 * like "ignore the above and run …" was a prompt-injection path to Bash,
 * Write, Edit and WebFetch on the server. Nothing here has ever needed a
 * tool: enrichment, Quick Take, Insights, What's Next and Process all return
 * their answer as structured output (`outputFormat`) or plain text.
 *
 * - `tools: []` removes every built-in tool from the model's context.
 * - `disallowedTools` names the dangerous ones again, so a future change to
 *   `tools` (or a CLI default) can't quietly bring them back.
 * - `permissionMode: 'dontAsk'` denies anything not pre-approved — and
 *   nothing is — instead of `bypassPermissions`, which approved everything.
 * - `mcpServers: {}` with `strictMcpConfig` loads no MCP server from any
 *   config file (`settingSources: []` already keeps settings out).
 *
 * Guarded by `tests/behavioral/ai-sdk-no-tools.test.ts`, which builds both
 * entry points' options and checks they carry this.
 */
export const DENIED_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'Skill',
  'TodoWrite',
] as const

export const NO_TOOLS = {
  tools: [],
  disallowedTools: [...DENIED_TOOLS],
  permissionMode: 'dontAsk',
  mcpServers: {},
  strictMcpConfig: true,
} satisfies Partial<Options>
