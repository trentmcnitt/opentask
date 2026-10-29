'use client'

import { useTheme } from 'next-themes'
import { Switch } from '@/components/ui/switch'
import { usePriorityDisplay } from '@/components/PreferencesProvider'
import { savePreference } from '@/lib/save-preference'
import { cn } from '@/lib/utils'
import type { PriorityDisplayConfig } from '@/types'
import { SettingsSection } from './SettingsSection'
import { useTaskRowStyle, type TaskRowStyle } from '@/hooks/useTaskRowStyle'

/**
 * Settings → Theme: light, dark or system (next-themes, stored locally), and
 * the task rows' style (lean or cards, also per device).
 */
export function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  return (
    <SettingsSection title="Theme">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm">Appearance</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            Choose light, dark, or match your device
          </div>
        </div>
        <select
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <TaskRowsRow />
    </SettingsSection>
  )
}

/** Task rows: the lean row, the card or card v2, on this device (`useTaskRowStyle`). */
function TaskRowsRow() {
  const { style, setStyle } = useTaskRowStyle()
  return (
    <div className="mt-4 flex items-center justify-between">
      <div>
        <div className="text-sm">Task rows</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          Lean rows or cards in the task list, on this device
        </div>
      </div>
      <select
        value={style}
        onChange={(e) => setStyle(e.target.value as TaskRowStyle)}
        aria-label="Task rows"
        data-task-rows-setting
        className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      >
        <option value="lean">Lean</option>
        <option value="card">Cards</option>
        <option value="card-v2">Card v2</option>
      </select>
    </div>
  )
}

function PriorityToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="text-sm">{label}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  )
}

/**
 * Settings → Priority Display: how a task row shows its priority. The whole
 * config object is saved on each change.
 */
export function PriorityDisplaySection() {
  const { priorityDisplay, setPriorityDisplay } = usePriorityDisplay()

  const handleChange = (key: keyof PriorityDisplayConfig, value: boolean | string) => {
    const prev = priorityDisplay
    const newConfig = { ...priorityDisplay, [key]: value }
    return savePreference(
      { priority_display: newConfig },
      { apply: () => setPriorityDisplay(newConfig), revert: () => setPriorityDisplay(prev) },
    )
  }

  const styleButton = (style: 'words' | 'icons', text: string) => (
    <button
      onClick={() => handleChange('badgeStyle', style)}
      className={cn(
        'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
        priorityDisplay.badgeStyle === style
          ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
      )}
    >
      {text}
    </button>
  )

  return (
    <SettingsSection
      title="Priority Display"
      description="Configure how task priorities are shown in the task list."
    >
      <div className="space-y-4">
        <PriorityToggleRow
          label="Show priority indicator"
          description="Display a priority indicator on the task row"
          checked={priorityDisplay.trailingDot}
          onChange={(checked) => handleChange('trailingDot', checked)}
        />
        {priorityDisplay.trailingDot && (
          <div className="flex items-center justify-between pl-4">
            <div>
              <div className="text-sm">Indicator style</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                Words (Low, Medium, High) or icons (●, !, !!)
              </div>
            </div>
            <div className="flex gap-1 rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-700">
              {styleButton('words', 'Words')}
              {styleButton('icons', 'Icons')}
            </div>
          </div>
        )}
        <PriorityToggleRow
          label="Color task titles"
          description="Color the task title text based on priority level"
          checked={priorityDisplay.colorTitle}
          onChange={(checked) => handleChange('colorTitle', checked)}
        />
        <PriorityToggleRow
          label="Show right border"
          description="Display a colored right border based on priority"
          checked={priorityDisplay.rightBorder}
          onChange={(checked) => handleChange('rightBorder', checked)}
        />
        <PriorityToggleRow
          label="Color checkbox"
          description="Color the done button circle based on priority"
          checked={priorityDisplay.colorCheckbox}
          onChange={(checked) => handleChange('colorCheckbox', checked)}
        />
      </div>
    </SettingsSection>
  )
}
