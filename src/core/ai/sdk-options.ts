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
 * Every OpenTask SDK query runs with NO usable tools (2026-11-09). The model
 * reads untrusted text — task titles from inbound email (desk comms), shared
 * content, Shortcut input — and answers with JSON, nothing else. Until this,
 * the CLI ran with every built-in tool and `bypassPermissions`, so a title
 * like "ignore the above and run …" was a prompt-injection path to Bash,
 * Write, Edit and WebFetch on the server. Nothing here has ever needed a
 * tool: enrichment, Quick Take, Insights, What's Next and Process all return
 * their answer as structured output (`outputFormat`, the CLI's own
 * `StructuredOutput`) or plain text.
 *
 * - `disallowedTools` removes, by name, every tool that can run a command,
 *   touch a file or git, reach the network or an outside service, read
 *   local data, start agents or schedule work. What is left on CLI
 *   2.1.302–2.1.319: StructuredOutput, ToolSearch, ListAgents,
 *   ReportFindings.
 * - `permissionMode: 'dontAsk'` denies every call that needs permission —
 *   nothing is pre-approved — so a tool a future CLI adds that can act is
 *   refused even before it is named here. It replaces `bypassPermissions`,
 *   which approved everything.
 * - `mcpServers: {}` with `strictMcpConfig` loads no MCP server from any
 *   config file (`settingSources: []` already keeps settings out).
 *
 * NOT `tools: []` (the first version, #459, reverted by #460): with the tool
 * set emptied — `[]`, `['StructuredOutput']`, one harmless tool, or every
 * tool but StructuredOutput disallowed — Sonnet 5.5 refuses the enrichment
 * slot's warmup every time ("Sonnet 5.5's safeguards flagged this
 * message"), on CLI 2.1.302, 2.1.310 and 2.1.319 alike; Haiku doesn't. The
 * set above (four tools left) passed every time, on prod's CLI and locally. A change here must
 * be verified with the real warmup on Sonnet (the quality harness doesn't
 * go through these options), and on prod before it's called done.
 *
 * Guarded by `tests/behavioral/ai-sdk-no-tools.test.ts`, which builds both
 * entry points' options and checks they carry this.
 */
export const DENIED_TOOLS = [
  // Commands, files, notebooks
  'Bash',
  'BashOutput',
  'KillShell',
  'Monitor',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  // Git worktrees on disk
  'EnterWorktree',
  'ExitWorktree',
  // Reading local data (an injected title could copy a secret into a field)
  'Read',
  'Glob',
  'Grep',
  // The network
  'WebFetch',
  'WebSearch',
  'RemoteTrigger',
  'PushNotification',
  'SendMessage',
  'DesignSync',
  // Agents, skills, workflows and scheduled work
  'Task',
  'Agent',
  'Skill',
  'Workflow',
  'TodoWrite',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
] as const

export const NO_TOOLS = {
  disallowedTools: [...DENIED_TOOLS],
  permissionMode: 'dontAsk',
  mcpServers: {},
  strictMcpConfig: true,
} satisfies Partial<Options>
