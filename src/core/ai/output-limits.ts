/**
 * Output-token caps per provider — the one place the numbers live.
 *
 * The Anthropic API provider sends `max_tokens` from `anthropicMaxTokens()`, and
 * batch features (Insights) size their calls from `outputTokenBudget()`, so the
 * cap a feature plans against is the cap the call actually gets.
 *
 * - **anthropic**: `max_tokens` is 8192, or 16384 with extended thinking. Thinking
 *   tokens count against `max_tokens`, so the room left for the answer is the cap
 *   minus the thinking budget (16384 − 10000 = 6384 for Insights on Opus).
 * - **openai**: the provider sends no `max_tokens`, so the cap is the model's own
 *   default, which varies by model and endpoint (OpenAI, xAI, OpenRouter). We plan
 *   against a conservative 8192 — the same as the Anthropic path.
 * - **sdk**: the Claude Code CLI caps each response at `CLAUDE_CODE_MAX_OUTPUT_TOKENS`
 *   when that is set, else its own default. The default is not exposed to us; 32000
 *   is the CLI's long-standing default, so we plan against that (thinking deducted
 *   the same way).
 */

/** `max_tokens` the Anthropic API provider sends without extended thinking. */
export const ANTHROPIC_MAX_TOKENS = 8192
/** `max_tokens` the Anthropic API provider sends with extended thinking. */
export const ANTHROPIC_MAX_TOKENS_WITH_THINKING = 16384
/** Assumed output cap for OpenAI-compatible models (no `max_tokens` is sent). */
export const OPENAI_ASSUMED_MAX_TOKENS = 8192
/** Assumed Claude Code CLI output cap when CLAUDE_CODE_MAX_OUTPUT_TOKENS is unset. */
export const SDK_DEFAULT_MAX_OUTPUT_TOKENS = 32000

/** The `max_tokens` value the Anthropic API provider sends for a call. */
export function anthropicMaxTokens(maxThinkingTokens?: number): number {
  return maxThinkingTokens ? ANTHROPIC_MAX_TOKENS_WITH_THINKING : ANTHROPIC_MAX_TOKENS
}

/** The output cap (thinking included) a call on this provider runs under. */
export function outputTokenCap(
  provider: 'sdk' | 'anthropic' | 'openai',
  maxThinkingTokens?: number,
): number {
  if (provider === 'anthropic') return anthropicMaxTokens(maxThinkingTokens)
  if (provider === 'openai') return OPENAI_ASSUMED_MAX_TOKENS
  const fromEnv = parseInt(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '', 10)
  return fromEnv > 0 ? fromEnv : SDK_DEFAULT_MAX_OUTPUT_TOKENS
}

/**
 * The tokens left for the visible answer: the cap minus any thinking budget.
 * OpenAI ignores `maxThinkingTokens` (the provider never sends it), so nothing
 * is deducted there.
 */
export function outputTokenBudget(
  provider: 'sdk' | 'anthropic' | 'openai',
  maxThinkingTokens?: number,
): number {
  const cap = outputTokenCap(provider, maxThinkingTokens)
  const thinking = provider === 'openai' ? 0 : (maxThinkingTokens ?? 0)
  return Math.max(0, cap - thinking)
}
