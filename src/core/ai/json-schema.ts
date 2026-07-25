/**
 * JSON Schema normalization for the Claude Code CLI
 *
 * Zod's `z.toJSONSchema()` emits a `$schema` key naming the 2020-12 draft
 * meta-schema. The Claude Code CLI validates the `--json-schema` argument with
 * Ajv, which has no 2020-12 meta-schema registered, so it rejects the schema
 * outright and the subprocess exits with code 1 before any query runs:
 *
 *   Error: --json-schema is not a valid JSON Schema:
 *          no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
 *
 * The `$schema` key carries no constraints — dropping it leaves validation
 * behavior unchanged. Strip it from every schema handed to the SDK.
 *
 * Root-level only: Zod emits `$schema` at the root and never inside `$defs`,
 * and the CLI's failure is on the root meta-schema ref.
 */

/**
 * Return a copy of `schema` with the root `$schema` key removed.
 * Apply to any schema passed to the SDK's `outputFormat.schema`.
 */
export function toCliJsonSchema<T extends Record<string, unknown>>(schema: T): T {
  if (!('$schema' in schema)) return schema
  const { $schema: _discarded, ...rest } = schema
  return rest as unknown as T
}
