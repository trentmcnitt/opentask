/**
 * A title's last word and what rides on it (the High "!" / Urgent "!!" mark,
 * the just-now tag), kept together on one line — without ever making the row
 * wider than the screen.
 *
 * It was `whitespace-nowrap`: fine for a word, but a title ending in a long
 * URL then laid out ~735px wide, the page grew past the phone's width, and the
 * iOS app panned sideways on every dashboard view that showed it (Trent,
 * 2026-10-30). As an inline-block capped at the line (`max-w-full`), the tail
 * still moves to the next line whole when it fits there, and only a tail
 * longer than the whole line breaks inside it (`overflow-wrap: anywhere`).
 */
export const TITLE_TAIL = 'inline-block max-w-full [overflow-wrap:anywhere]'
