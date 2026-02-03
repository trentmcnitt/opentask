import type { LabelColor, LabelConfig } from '@/types'

export const LABEL_COLORS: Record<
  LabelColor,
  { bg: string; text: string; dot: string; display: string }
> = {
  red: {
    bg: 'bg-red-100 dark:bg-red-900/40',
    text: 'text-red-700 dark:text-red-300',
    dot: 'bg-red-500',
    display: 'Red',
  },
  orange: {
    bg: 'bg-orange-100 dark:bg-orange-900/40',
    text: 'text-orange-700 dark:text-orange-300',
    dot: 'bg-orange-500',
    display: 'Orange',
  },
  yellow: {
    bg: 'bg-yellow-100 dark:bg-yellow-900/40',
    text: 'text-yellow-700 dark:text-yellow-300',
    dot: 'bg-yellow-500',
    display: 'Yellow',
  },
  green: {
    bg: 'bg-green-100 dark:bg-green-900/40',
    text: 'text-green-700 dark:text-green-300',
    dot: 'bg-green-500',
    display: 'Green',
  },
  blue: {
    bg: 'bg-blue-100 dark:bg-blue-900/40',
    text: 'text-blue-700 dark:text-blue-300',
    dot: 'bg-blue-500',
    display: 'Blue',
  },
  purple: {
    bg: 'bg-purple-100 dark:bg-purple-900/40',
    text: 'text-purple-700 dark:text-purple-300',
    dot: 'bg-purple-500',
    display: 'Purple',
  },
  pink: {
    bg: 'bg-pink-100 dark:bg-pink-900/40',
    text: 'text-pink-700 dark:text-pink-300',
    dot: 'bg-pink-500',
    display: 'Pink',
  },
  gray: {
    bg: 'bg-gray-100 dark:bg-gray-800/60',
    text: 'text-gray-700 dark:text-gray-300',
    dot: 'bg-gray-500',
    display: 'Gray',
  },
}

export const LABEL_COLOR_NAMES = Object.keys(LABEL_COLORS) as LabelColor[]

/**
 * Returns combined bg + text classes for a label if it matches a predefined label,
 * or null for ad-hoc labels.
 */
export function getLabelClasses(label: string, config: LabelConfig[]): string | null {
  const lowerLabel = label.toLowerCase()
  const match = config.find((c) => c.name.toLowerCase() === lowerLabel)
  if (!match) return null
  const colorDef = LABEL_COLORS[match.color]
  return `${colorDef.bg} ${colorDef.text}`
}
