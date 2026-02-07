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
  defaultSnoozeOption: string
  setDefaultSnoozeOption: (option: string) => void
  morningTime: string
  setMorningTime: (time: string) => void
}

const LabelConfigContext = createContext<LabelConfigContextValue>({
  labelConfig: [],
  setLabelConfig: () => {},
  priorityDisplay: DEFAULT_PRIORITY_DISPLAY,
  setPriorityDisplay: () => {},
  autoSnoozeDefault: 30,
  setAutoSnoozeDefault: () => {},
  defaultSnoozeOption: '60',
  setDefaultSnoozeOption: () => {},
  morningTime: '09:00',
  setMorningTime: () => {},
})

export function LabelConfigProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [labelConfig, setLabelConfigState] = useState<LabelConfig[]>([])
  const [priorityDisplay, setPriorityDisplayState] =
    useState<PriorityDisplayConfig>(DEFAULT_PRIORITY_DISPLAY)
  const [autoSnoozeDefault, setAutoSnoozeDefaultState] = useState(30)
  const [defaultSnoozeOption, setDefaultSnoozeOptionState] = useState('60')
  const [morningTime, setMorningTimeState] = useState('09:00')

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
        if (data?.data?.default_snooze_option) {
          setDefaultSnoozeOptionState(data.data.default_snooze_option)
        }
        if (data?.data?.morning_time) {
          setMorningTimeState(data.data.morning_time)
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
        defaultSnoozeOption,
        setDefaultSnoozeOption: setDefaultSnoozeOptionState,
        morningTime,
        setMorningTime: setMorningTimeState,
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

export function useSnoozePreferences() {
  const { defaultSnoozeOption, setDefaultSnoozeOption, morningTime, setMorningTime } =
    useContext(LabelConfigContext)
  return { defaultSnoozeOption, setDefaultSnoozeOption, morningTime, setMorningTime }
}
