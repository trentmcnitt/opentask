import type { ReactNode } from 'react'

/** A Settings row: label and description on the left, the control on the right. */
export function SettingRow({
  label,
  description,
  children,
}: {
  label: string
  description: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="text-sm">{label}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{description}</div>
      </div>
      {children}
    </div>
  )
}
