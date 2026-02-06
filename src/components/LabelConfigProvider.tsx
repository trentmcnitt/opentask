'use client'

import { createContext, useContext, useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import type { LabelConfig, PriorityDisplayConfig } from '@/types'

const DEFAULT_PRIORITY_DISPLAY: PriorityDisplayConfig = {
  trailingDot: true,
  colorTitle: false,
  rightBorder: false,
}

interface LabelConfigContextValue {
  labelConfig: LabelConfig[]
  setLabelConfig: (config: LabelConfig[]) => void
  priorityDisplay: PriorityDisplayConfig
  setPriorityDisplay: (config: PriorityDisplayConfig) => void
  autoSnoozeDefault: number
  setAutoSnoozeDefault: (minutes: number) => void
}

const LabelConfigContext = createContext<LabelConfigContextValue>({
  labelConfig: [],
  setLabelConfig: () => {},
  priorityDisplay: DEFAULT_PRIORITY_DISPLAY,
  setPriorityDisplay: () => {},
  autoSnoozeDefault: 30,
  setAutoSnoozeDefault: () => {},
})

export function LabelConfigProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [labelConfig, setLabelConfigState] = useState<LabelConfig[]>([])
  const [priorityDisplay, setPriorityDisplayState] =
    useState<PriorityDisplayConfig>(DEFAULT_PRIORITY_DISPLAY)
  const [autoSnoozeDefault, setAutoSnoozeDefaultState] = useState(30)

  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/user/preferences')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.data?.label_config) {
          setLabelConfigState(data.data.label_config)
        }
        if (data?.data?.priority_display) {
          setPriorityDisplayState(data.data.priority_display)
        }
        if (data?.data?.auto_snooze_minutes) {
          setAutoSnoozeDefaultState(data.data.auto_snooze_minutes)
        }
      })
      .catch(() => {})
  }, [status])

  return (
    <LabelConfigContext.Provider
      value={{
        labelConfig,
        setLabelConfig: setLabelConfigState,
        priorityDisplay,
        setPriorityDisplay: setPriorityDisplayState,
        autoSnoozeDefault,
        setAutoSnoozeDefault: setAutoSnoozeDefaultState,
      }}
    >
      {children}
    </LabelConfigContext.Provider>
  )
}

export function useLabelConfig() {
  return useContext(LabelConfigContext)
}

export function usePriorityDisplay() {
  const { priorityDisplay, setPriorityDisplay } = useContext(LabelConfigContext)
  return { priorityDisplay, setPriorityDisplay }
}

export function useAutoSnoozeDefault() {
  const { autoSnoozeDefault, setAutoSnoozeDefault } = useContext(LabelConfigContext)
  return { autoSnoozeDefault, setAutoSnoozeDefault }
}
