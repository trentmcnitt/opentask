'use client'

import { useState } from 'react'
import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useLabelConfig } from '@/components/PreferencesProvider'
import { LABEL_COLORS, LABEL_COLOR_NAMES } from '@/lib/label-colors'
import { savePreference } from '@/lib/save-preference'
import { showToast } from '@/lib/toast'
import type { LabelColor, LabelConfig } from '@/types'
import { ColorDot } from './ColorDot'
import { SettingsSection } from './SettingsSection'

/**
 * Settings → Labels: the user's labels with colors. Every add, recolor or
 * removal saves the whole list (`label_config`), and the server keeps the
 * label registry in step: an added label can go on a task at once, and a
 * removed one is deregistered for good (`syncLabelRegistry` in
 * src/core/users/preferences.ts). Tasks already carrying a removed label keep it.
 */
export function LabelsSection() {
  const { labelConfig, setLabelConfig } = useLabelConfig()

  const saveLabelConfig = async (newConfig: LabelConfig[]) => {
    const prev = labelConfig
    await savePreference(
      { label_config: newConfig },
      {
        apply: () => setLabelConfig(newConfig),
        revert: () => setLabelConfig(prev),
        successMessage: 'Labels saved',
        errorMessage: 'Failed to save labels',
      },
    )
  }

  return (
    <SettingsSection
      title="Labels"
      description="Define labels with colors. Predefined labels display their color everywhere."
    >
      <LabelEditor labels={labelConfig} onSave={saveLabelConfig} />
    </SettingsSection>
  )
}

function LabelEditor({
  labels,
  onSave,
}: {
  labels: LabelConfig[]
  onSave: (labels: LabelConfig[]) => void
}) {
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<LabelColor>('blue')

  const handleAdd = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    if (labels.some((l) => l.name.toLowerCase() === trimmed.toLowerCase())) {
      showToast({ message: 'Label already exists' })
      return
    }
    onSave([...labels, { name: trimmed, color: newColor }])
    setNewName('')
  }

  const handleRemove = (name: string) => {
    onSave(labels.filter((l) => l.name !== name))
  }

  const handleRecolor = (name: string, color: LabelColor) => {
    onSave(labels.map((l) => (l.name === name ? { ...l, color } : l)))
  }

  return (
    <div className="space-y-2">
      {labels.map((label) => (
        <div key={label.name} className="flex items-center gap-2">
          <Badge
            className={`${LABEL_COLORS[label.color].bg} ${LABEL_COLORS[label.color].text} flex-shrink-0 border-0`}
          >
            {label.name}
          </Badge>
          <div className="flex flex-1 items-center gap-1">
            {LABEL_COLOR_NAMES.map((c) => (
              <ColorDot
                key={c}
                color={c}
                selected={label.color === c}
                onClick={() => handleRecolor(label.name, c)}
                ariaLabel={`Set ${label.name} to ${LABEL_COLORS[c].display}`}
              />
            ))}
          </div>
          <button
            onClick={() => handleRemove(label.name)}
            className="text-zinc-400 transition-colors hover:text-red-500"
            aria-label={`Remove ${label.name}`}
          >
            <X className="size-4" />
          </button>
        </div>
      ))}

      {/* Add new label row */}
      <div className="flex items-center gap-2 pt-1">
        <Input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
          }}
          placeholder="New label"
          className="h-8 w-32 text-sm"
        />
        <div className="flex items-center gap-1">
          {LABEL_COLOR_NAMES.map((c) => (
            <ColorDot
              key={c}
              color={c}
              selected={newColor === c}
              onClick={() => setNewColor(c)}
              ariaLabel={`${LABEL_COLORS[c].display} color`}
            />
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleAdd}
          disabled={!newName.trim()}
          className="h-8"
        >
          Add
        </Button>
      </div>
    </div>
  )
}
