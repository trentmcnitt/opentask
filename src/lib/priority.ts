/** Priority value at which tasks are considered high/urgent (3=High, 4=Urgent) */
export const HIGH_PRIORITY_THRESHOLD = 3

/** Priority value at which tasks are considered medium (2=Medium) */
export const MEDIUM_PRIORITY_THRESHOLD = 2

/**
 * Priority options for task priority display and selection.
 * Values: 0=None, 1=Low, 2=Medium, 3=High, 4=Urgent
 */
export const PRIORITY_OPTIONS = [
  { value: 0, label: 'None', color: 'text-muted-foreground' },
  { value: 1, label: 'Low', color: 'text-zinc-400' },
  { value: 2, label: 'Medium', color: 'text-yellow-500' },
  { value: 3, label: 'High', color: 'text-orange-500' },
  { value: 4, label: 'Urgent', color: 'text-red-500' },
] as const

export type PriorityValue = (typeof PRIORITY_OPTIONS)[number]['value']

/**
 * Get priority option by value
 */
export function getPriorityOption(value: number) {
  return PRIORITY_OPTIONS.find((p) => p.value === value) || PRIORITY_OPTIONS[0]
}

/** Excluded chip styling: strikethrough + muted red tint (uniform across all chip types) */
export const EXCLUDED_CHIP_CLASSES =
  'line-through bg-red-100/50 text-red-700/80 border-red-200/60 dark:bg-red-950/30 dark:text-red-400/70 dark:border-red-800/40'

/**
 * Get badge styling classes for priority filter badges.
 * Returns Tailwind classes for included (filled), excluded (red strikethrough),
 * or unselected (outline) states.
 */
export function getPriorityBadgeClasses(
  value: number,
  chipState: 'unselected' | 'included' | 'excluded',
): string {
  if (chipState === 'excluded') {
    return `border ${EXCLUDED_CHIP_CLASSES}`
  }

  const colorMap: Record<number, { bg: string; border: string; text: string }> = {
    0: {
      bg: 'bg-muted text-muted-foreground',
      border: 'border-muted-foreground/30 text-muted-foreground',
      text: 'text-muted-foreground',
    },
    1: {
      bg: 'bg-zinc-500 text-white',
      border: 'border-zinc-500/30 text-zinc-400',
      text: 'text-zinc-400',
    },
    2: {
      bg: 'bg-yellow-500 text-white',
      border: 'border-yellow-500/30 text-yellow-600 dark:text-yellow-500',
      text: 'text-yellow-500',
    },
    3: {
      bg: 'bg-orange-500 text-white',
      border: 'border-orange-500/30 text-orange-500',
      text: 'text-orange-500',
    },
    4: {
      bg: 'bg-red-500 text-white',
      border: 'border-red-500/30 text-red-500',
      text: 'text-red-500',
    },
  }

  const colors = colorMap[value] || colorMap[0]

  if (chipState === 'included') {
    return `${colors.bg} border-transparent`
  }
  return `bg-muted/40 border ${colors.border} hover:opacity-80`
}
