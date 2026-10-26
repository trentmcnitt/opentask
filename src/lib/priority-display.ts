/**
 * PRIORITY DISPLAY — the one rule for how a row shows its priority, from the
 * user's Settings → Priority Display (`PriorityDisplayConfig`).
 *
 * Every row that stands for a task-like item follows it: the dashboard's task
 * row (`TaskRow`), the reminder rows (`/reminders` and the dashboard's
 * Reminders card), the quota prompt rows and the quota chips (2026-10-26:
 * before that a Medium reminder looked exactly like an unset one). Whatever
 * the user turned on for tasks applies to all of them, through
 * `priorityRowStyles` below, so the rows cannot drift apart.
 *
 * - "Show priority indicator" (`trailingDot`) → `tab`: the priority tab,
 *   High and Urgent only (`priorityTab` — Medium, Low and None get none,
 *   Trent's E2b rule of 2026-10-15), in the user's Words / Icons style.
 * - "Color task titles" (`colorTitle`) → `title`: Low to Urgent.
 * - "Show right border" (`rightBorder`) → `border`: Low to Urgent. The
 *   colour only — each row adds its own width and padding give-back.
 * - "Color checkbox" (`colorCheckbox`) → `check`: Low to Urgent.
 *
 * None (0) shows nothing, whatever is on.
 */
import { priorityTab, type PriorityTab } from '@/lib/row-corner'
import type { PriorityDisplayConfig } from '@/types'

/**
 * Priority colour classes for the parts of a row. Full class strings (never
 * built from a hue), so Tailwind sees every one of them.
 */
export interface PriorityColors {
  /** Title text. */
  text: string
  /** The right border's colour (`border-r-*`). */
  border: string
  /** Muted border colour for a done circle drawn with a CSS border. */
  checkbox: string
  /** Hover styles for that circle (border + background tint). */
  checkboxHover: string
  /**
   * The check mark on hover of the circle itself — the circle carries
   * `group/done` (TaskRow's done button, the reminder rows' circle).
   */
  checkIcon: string
  /**
   * A circle drawn in `currentColor` instead of a border (the quota prompt's
   * dashed ring): its stroke, and its hover.
   */
  ring: string
  ringHover: string
}

const COLORS: Record<number, PriorityColors> = {
  1: {
    text: 'text-zinc-400',
    border: 'border-r-zinc-400/50',
    checkbox: 'border-zinc-400/60',
    checkboxHover: 'hover:border-zinc-400 hover:bg-zinc-400/10',
    checkIcon: 'group-hover/done:text-zinc-400',
    ring: 'text-zinc-400/60',
    ringHover: 'hover:text-zinc-400 hover:bg-zinc-400/10',
  },
  2: {
    text: 'text-amber-500',
    border: 'border-r-amber-500/50',
    checkbox: 'border-amber-400/50',
    checkboxHover: 'hover:border-amber-500/70 hover:bg-amber-400/10',
    checkIcon: 'group-hover/done:text-amber-500',
    ring: 'text-amber-400/50',
    ringHover: 'hover:text-amber-500/70 hover:bg-amber-400/10',
  },
  3: {
    text: 'text-orange-500',
    border: 'border-r-orange-500/50',
    checkbox: 'border-orange-400/50',
    checkboxHover: 'hover:border-orange-500/70 hover:bg-orange-400/10',
    checkIcon: 'group-hover/done:text-orange-500',
    ring: 'text-orange-400/50',
    ringHover: 'hover:text-orange-500/70 hover:bg-orange-400/10',
  },
  4: {
    text: 'text-red-500',
    border: 'border-r-red-500/50',
    checkbox: 'border-red-400/50',
    checkboxHover: 'hover:border-red-500/70 hover:bg-red-400/10',
    checkIcon: 'group-hover/done:text-red-500',
    ring: 'text-red-400/50',
    ringHover: 'hover:text-red-500/70 hover:bg-red-400/10',
  },
}

/** The colour classes for a priority; null for None (and anything unknown). */
export function getPriorityColors(priority: number): PriorityColors | null {
  return COLORS[priority] ?? null
}

/** What a row shows for its priority — see the file comment. */
export interface PriorityRowStyles {
  tab: PriorityTab | null
  title: string | null
  border: string | null
  check: PriorityColors | null
}

export function priorityRowStyles(
  priority: number,
  display: PriorityDisplayConfig,
): PriorityRowStyles {
  const colors = getPriorityColors(priority)
  return {
    tab: display.trailingDot ? priorityTab(priority, display.badgeStyle) : null,
    title: display.colorTitle && colors ? colors.text : null,
    border: display.rightBorder && colors ? colors.border : null,
    check: display.colorCheckbox ? colors : null,
  }
}
