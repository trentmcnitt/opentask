/** Convert 12-hour time to 24-hour format. */
export function to24Hour(hour12: number, period: 'AM' | 'PM'): number {
  if (period === 'AM') return hour12 % 12
  return (hour12 % 12) + 12
}

/** Convert 24-hour time to 12-hour display value (1-12). */
export function to12Hour(hour24: number): number {
  return hour24 % 12 || 12
}
