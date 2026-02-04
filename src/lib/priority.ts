/**
 * Priority options for task priority display and selection.
 * Values: 0=None, 1=Low, 2=Medium, 3=High, 4=Urgent
 */
export const PRIORITY_OPTIONS = [
  { value: 0, label: 'None', color: 'text-muted-foreground' },
  { value: 1, label: 'Low', color: 'text-blue-500' },
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

/**
 * Get badge styling classes for priority filter badges.
 * Returns Tailwind classes for selected (filled) vs unselected (outline) states.
 */
export function getPriorityBadgeClasses(value: number, isSelected: boolean): string {
  const colorMap: Record<number, { bg: string; border: string; text: string }> = {
    0: {
      bg: 'bg-muted text-muted-foreground',
      border: 'border-muted-foreground/30 text-muted-foreground',
      text: 'text-muted-foreground',
    },
    1: {
      bg: 'bg-blue-500 text-white',
      border: 'border-blue-500/30 text-blue-500',
      text: 'text-blue-500',
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

  if (isSelected) {
    return `${colors.bg} border-transparent`
  }
  return `bg-transparent border ${colors.border} hover:opacity-80`
}
