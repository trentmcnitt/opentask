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
