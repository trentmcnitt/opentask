import type { ReactNode } from 'react'

/**
 * The card every Settings section sits in: a bordered box, a small uppercase
 * heading, and an optional muted description under it. `children` is the
 * section's controls.
 */
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="mb-3 text-sm font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
        {title}
      </h2>
      {description && (
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">{description}</p>
      )}
      {children}
    </section>
  )
}
