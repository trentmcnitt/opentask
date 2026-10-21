/**
 * Today's icon: a sun with a solid core (Trent's pick, 2026-10-20) — the native apps should mirror it.
 * Lucide's API shape and SVG attributes, so it drops in where `Sun` was.
 */
export function SunSolid({
  size = 24,
  className,
  strokeWidth = 2,
  'aria-hidden': ariaHidden = true,
}: {
  size?: number | string
  className?: string
  strokeWidth?: number | string
  'aria-hidden'?: boolean | 'true' | 'false'
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={ariaHidden}
      data-sun-solid
    >
      <circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none" />
      <path d="M12 2.5v2" />
      <path d="M12 19.5v2" />
      <path d="m5.3 5.3 1.4 1.4" />
      <path d="m17.3 17.3 1.4 1.4" />
      <path d="M2.5 12h2" />
      <path d="M19.5 12h2" />
      <path d="m5.3 18.7 1.4-1.4" />
      <path d="m17.3 6.7 1.4-1.4" />
    </svg>
  )
}
