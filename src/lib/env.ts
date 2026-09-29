/**
 * Environment variable helpers.
 */

/** Parse an integer from an env var with a default fallback. Returns the default if the value is not a valid integer. */
export function parseEnvInt(envVar: string | undefined, defaultValue: number): number {
  const parsed = parseInt(envVar || '', 10)
  return isNaN(parsed) ? defaultValue : parsed
}
