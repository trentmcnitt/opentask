/**
 * The screenshot sample account (scripts/screenshots/seed.ts creates it in a
 * throwaway database). Not a secret: it only ever exists in that database.
 */
export const SCREENSHOT_USER = {
  username: 'sample',
  password: 'sample-screenshots',
  email: 'sample@example.com',
  /** Raw API token (the DB keeps its hash). Used to dump widget data. */
  token: 'screenshots-sample-token-00000000000000000000000000000000000000',
  timezone: 'America/Chicago',
}
