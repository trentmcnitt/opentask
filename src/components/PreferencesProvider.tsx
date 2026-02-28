'use client'

import { createContext, useContext, useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import type { LabelConfig, PriorityDisplayConfig } from '@/types'
import type { AiMode } from '@/hooks/useAiMode'

const DEFAULT_PRIORITY_DISPLAY: PriorityDisplayConfig = {
  trailingDot: true,
  badgeStyle: 'words',
  colorTitle: false,
  rightBorder: false,
  colorCheckbox: true,
}

export type WhatsNextModel = 'haiku' | 'claude-opus-4-6'

interface PreferencesContextValue {
  aiAvailable: boolean
  labelConfig: LabelConfig[]
  setLabelConfig: (config: LabelConfig[]) => void
  priorityDisplay: PriorityDisplayConfig
  setPriorityDisplay: (config: PriorityDisplayConfig) => void
  autoSnoozeDefault: number
  setAutoSnoozeDefault: (minutes: number) => void
  autoSnoozeUrgent: number
  setAutoSnoozeUrgent: (minutes: number) => void
  autoSnoozeHigh: number
  setAutoSnoozeHigh: (minutes: number) => void
  defaultSnoozeOption: string
  setDefaultSnoozeOption: (option: string) => void
  morningTime: string
  setMorningTime: (time: string) => void
  wakeTime: string
  setWakeTime: (time: string) => void
  sleepTime: string
  setSleepTime: (time: string) => void
  defaultGrouping: 'time' | 'project' | 'unified'
  setDefaultGrouping: (grouping: 'time' | 'project' | 'unified') => void
  notificationsEnabled: boolean
  setNotificationsEnabled: (enabled: boolean) => void
  criticalAlertVolume: number
  setCriticalAlertVolume: (volume: number) => void
  aiContext: string | null
  setAiContext: (context: string | null) => void
  aiMode: AiMode
  setAiMode: (mode: AiMode) => void
  aiShowScores: boolean
  setAiShowScores: (show: boolean) => void
  aiShowSignals: boolean
  setAiShowSignals: (show: boolean) => void
  aiShowWhatsNext: boolean
  setAiShowWhatsNext: (show: boolean) => void
  aiShowInsights: boolean
  setAiShowInsights: (show: boolean) => void
  aiShowCommentary: boolean
  setAiShowCommentary: (show: boolean) => void
  aiWhatsNextModel: WhatsNextModel
  setAiWhatsNextModel: (model: WhatsNextModel) => void
  aiWnCommentaryUnfiltered: boolean
  setAiWnCommentaryUnfiltered: (show: boolean) => void
  aiWnHighlight: boolean
  setAiWnHighlight: (show: boolean) => void
  aiInsightsSignalChips: boolean
  setAiInsightsSignalChips: (show: boolean) => void
  aiInsightsScoreChips: boolean
  setAiInsightsScoreChips: (show: boolean) => void
  aiQuickTake: boolean
  setAiQuickTake: (enabled: boolean) => void
}

const PreferencesContext = createContext<PreferencesContextValue>({
  aiAvailable: false,
  labelConfig: [],
  setLabelConfig: () => {},
  priorityDisplay: DEFAULT_PRIORITY_DISPLAY,
  setPriorityDisplay: () => {},
  autoSnoozeDefault: 30,
  setAutoSnoozeDefault: () => {},
  autoSnoozeUrgent: 5,
  setAutoSnoozeUrgent: () => {},
  autoSnoozeHigh: 15,
  setAutoSnoozeHigh: () => {},
  defaultSnoozeOption: '60',
  setDefaultSnoozeOption: () => {},
  morningTime: '09:00',
  setMorningTime: () => {},
  wakeTime: '07:00',
  setWakeTime: () => {},
  sleepTime: '22:00',
  setSleepTime: () => {},
  defaultGrouping: 'time',
  setDefaultGrouping: () => {},
  notificationsEnabled: true,
  setNotificationsEnabled: () => {},
  criticalAlertVolume: 1.0,
  setCriticalAlertVolume: () => {},
  aiContext: null,
  setAiContext: () => {},
  aiMode: 'on',
  setAiMode: () => {},
  aiShowScores: true,
  setAiShowScores: () => {},
  aiShowSignals: true,
  setAiShowSignals: () => {},
  aiShowWhatsNext: true,
  setAiShowWhatsNext: () => {},
  aiShowInsights: true,
  setAiShowInsights: () => {},
  aiShowCommentary: true,
  setAiShowCommentary: () => {},
  aiWhatsNextModel: 'haiku',
  setAiWhatsNextModel: () => {},
  aiWnCommentaryUnfiltered: false,
  setAiWnCommentaryUnfiltered: () => {},
  aiWnHighlight: true,
  setAiWnHighlight: () => {},
  aiInsightsSignalChips: true,
  setAiInsightsSignalChips: () => {},
  aiInsightsScoreChips: true,
  setAiInsightsScoreChips: () => {},
  aiQuickTake: false,
  setAiQuickTake: () => {},
})

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [aiAvailable, setAiAvailableState] = useState(false)
  const [labelConfig, setLabelConfigState] = useState<LabelConfig[]>([])
  const [priorityDisplay, setPriorityDisplayState] =
    useState<PriorityDisplayConfig>(DEFAULT_PRIORITY_DISPLAY)
  const [autoSnoozeDefault, setAutoSnoozeDefaultState] = useState(30)
  const [autoSnoozeUrgent, setAutoSnoozeUrgentState] = useState(5)
  const [autoSnoozeHigh, setAutoSnoozeHighState] = useState(15)
  const [defaultSnoozeOption, setDefaultSnoozeOptionState] = useState('60')
  const [morningTime, setMorningTimeState] = useState('09:00')
  const [wakeTime, setWakeTimeState] = useState('07:00')
  const [sleepTime, setSleepTimeState] = useState('22:00')
  const [defaultGrouping, setDefaultGroupingState] = useState<'time' | 'project' | 'unified'>(
    'unified',
  )
  const [notificationsEnabled, setNotificationsEnabledState] = useState(true)
  const [criticalAlertVolume, setCriticalAlertVolumeState] = useState(1.0)
  const [aiContext, setAiContextState] = useState<string | null>(null)
  const [aiMode, setAiModeState] = useState<AiMode>('on')
  const [aiShowScores, setAiShowScoresState] = useState(true)
  const [aiShowSignals, setAiShowSignalsState] = useState(true)
  const [aiShowWhatsNext, setAiShowWhatsNextState] = useState(true)
  const [aiShowInsights, setAiShowInsightsState] = useState(true)
  const [aiShowCommentary, setAiShowCommentaryState] = useState(true)
  const [aiWhatsNextModel, setAiWhatsNextModelState] = useState<WhatsNextModel>('haiku')
  const [aiWnCommentaryUnfiltered, setAiWnCommentaryUnfilteredState] = useState(false)
  const [aiWnHighlight, setAiWnHighlightState] = useState(true)
  const [aiInsightsSignalChips, setAiInsightsSignalChipsState] = useState(true)
  const [aiInsightsScoreChips, setAiInsightsScoreChipsState] = useState(true)
  const [aiQuickTake, setAiQuickTakeState] = useState(false)

  // Register the iOS APNs device token with the server using session cookie auth.
  // Called after preferences load and on late token arrival (CustomEvent).
  function registerDeviceToken() {
    const info = (window as unknown as Record<string, unknown>).__OPENTASK_DEVICE_INFO as
      | { token: string; bundleId: string; environment: string }
      | undefined
    if (!info?.token) return

    fetch('/api/push/apns/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_token: info.token,
        bundle_id: info.bundleId,
        environment: info.environment,
      }),
    }).catch(() => {})
  }

  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/user/preferences')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.data?.ai_available !== undefined) {
          setAiAvailableState(data.data.ai_available)
        }
        if (data?.data?.label_config) {
          setLabelConfigState(data.data.label_config)
        }
        if (data?.data?.priority_display) {
          setPriorityDisplayState({ ...DEFAULT_PRIORITY_DISPLAY, ...data.data.priority_display })
        }
        if (data?.data?.auto_snooze_minutes) {
          setAutoSnoozeDefaultState(data.data.auto_snooze_minutes)
        }
        if (data?.data?.auto_snooze_urgent_minutes) {
          setAutoSnoozeUrgentState(data.data.auto_snooze_urgent_minutes)
        }
        if (data?.data?.auto_snooze_high_minutes) {
          setAutoSnoozeHighState(data.data.auto_snooze_high_minutes)
        }
        if (data?.data?.default_snooze_option) {
          setDefaultSnoozeOptionState(data.data.default_snooze_option)
        }
        if (data?.data?.morning_time) {
          setMorningTimeState(data.data.morning_time)
        }
        if (data?.data?.wake_time) {
          setWakeTimeState(data.data.wake_time)
        }
        if (data?.data?.sleep_time) {
          setSleepTimeState(data.data.sleep_time)
        }
        if (data?.data?.default_grouping) {
          setDefaultGroupingState(data.data.default_grouping)
        }
        if (data?.data?.notifications_enabled !== undefined) {
          setNotificationsEnabledState(data.data.notifications_enabled)
        }
        if (data?.data?.critical_alert_volume !== undefined) {
          setCriticalAlertVolumeState(data.data.critical_alert_volume)
        }
        if (data?.data?.ai_context !== undefined) {
          setAiContextState(data.data.ai_context)
        }
        if (data?.data?.ai_mode) {
          // Defensive mapping: accept valid modes, default to 'on'
          const mode = data.data.ai_mode
          if (mode === 'off' || mode === 'on') {
            setAiModeState(mode)
          } else {
            setAiModeState('on')
          }
        }
        if (data?.data?.ai_show_scores !== undefined) {
          setAiShowScoresState(data.data.ai_show_scores)
        }
        if (data?.data?.ai_show_signals !== undefined) {
          setAiShowSignalsState(data.data.ai_show_signals)
        }
        if (data?.data?.ai_show_whats_next !== undefined) {
          setAiShowWhatsNextState(data.data.ai_show_whats_next)
        }
        if (data?.data?.ai_show_insights !== undefined) {
          setAiShowInsightsState(data.data.ai_show_insights)
        }
        if (data?.data?.ai_show_commentary !== undefined) {
          setAiShowCommentaryState(data.data.ai_show_commentary)
        }
        if (data?.data?.ai_whats_next_model) {
          const model = data.data.ai_whats_next_model
          if (model === 'haiku' || model === 'claude-opus-4-6') {
            setAiWhatsNextModelState(model)
          }
        }
        if (data?.data?.ai_wn_commentary_unfiltered !== undefined) {
          setAiWnCommentaryUnfilteredState(data.data.ai_wn_commentary_unfiltered)
        }
        if (data?.data?.ai_wn_highlight !== undefined) {
          setAiWnHighlightState(data.data.ai_wn_highlight)
        }
        if (data?.data?.ai_insights_signal_chips !== undefined) {
          setAiInsightsSignalChipsState(data.data.ai_insights_signal_chips)
        }
        if (data?.data?.ai_insights_score_chips !== undefined) {
          setAiInsightsScoreChipsState(data.data.ai_insights_score_chips)
        }
        if (data?.data?.ai_quick_take !== undefined) {
          setAiQuickTakeState(data.data.ai_quick_take)
        }

        // Register iOS device token using session cookie auth.
        // This ensures push notifications follow the web-logged-in user,
        // not the bearer token user from initial iOS setup.
        registerDeviceToken()
      })
      .catch(() => {})
  }, [status])

  // Handle late APNs token arrival — iOS dispatches this CustomEvent when
  // the device token arrives after the WebView has already loaded.
  useEffect(() => {
    if (status !== 'authenticated') return

    function onDeviceToken() {
      registerDeviceToken()
    }

    window.addEventListener('opentask-device-token', onDeviceToken)
    return () => window.removeEventListener('opentask-device-token', onDeviceToken)
  }, [status])

  return (
    <PreferencesContext.Provider
      value={{
        aiAvailable,
        labelConfig,
        setLabelConfig: setLabelConfigState,
        priorityDisplay,
        setPriorityDisplay: setPriorityDisplayState,
        autoSnoozeDefault,
        setAutoSnoozeDefault: setAutoSnoozeDefaultState,
        autoSnoozeUrgent,
        setAutoSnoozeUrgent: setAutoSnoozeUrgentState,
        autoSnoozeHigh,
        setAutoSnoozeHigh: setAutoSnoozeHighState,
        defaultSnoozeOption,
        setDefaultSnoozeOption: setDefaultSnoozeOptionState,
        morningTime,
        setMorningTime: setMorningTimeState,
        wakeTime,
        setWakeTime: setWakeTimeState,
        sleepTime,
        setSleepTime: setSleepTimeState,
        defaultGrouping,
        setDefaultGrouping: (grouping: 'time' | 'project' | 'unified') => {
          setDefaultGroupingState(grouping)
          fetch('/api/user/preferences', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ default_grouping: grouping }),
          }).catch(() => {})
        },
        notificationsEnabled,
        setNotificationsEnabled: setNotificationsEnabledState,
        criticalAlertVolume,
        setCriticalAlertVolume: setCriticalAlertVolumeState,
        aiContext,
        setAiContext: setAiContextState,
        aiMode,
        setAiMode: setAiModeState,
        aiShowScores,
        setAiShowScores: setAiShowScoresState,
        aiShowSignals,
        setAiShowSignals: setAiShowSignalsState,
        aiShowWhatsNext,
        setAiShowWhatsNext: setAiShowWhatsNextState,
        aiShowInsights,
        setAiShowInsights: setAiShowInsightsState,
        aiShowCommentary,
        setAiShowCommentary: setAiShowCommentaryState,
        aiWhatsNextModel,
        setAiWhatsNextModel: setAiWhatsNextModelState,
        aiWnCommentaryUnfiltered,
        setAiWnCommentaryUnfiltered: setAiWnCommentaryUnfilteredState,
        aiWnHighlight,
        setAiWnHighlight: setAiWnHighlightState,
        aiInsightsSignalChips,
        setAiInsightsSignalChips: setAiInsightsSignalChipsState,
        aiInsightsScoreChips,
        setAiInsightsScoreChips: setAiInsightsScoreChipsState,
        aiQuickTake,
        setAiQuickTake: setAiQuickTakeState,
      }}
    >
      {children}
    </PreferencesContext.Provider>
  )
}

export function useLabelConfig() {
  return useContext(PreferencesContext)
}

export function usePriorityDisplay() {
  const { priorityDisplay, setPriorityDisplay } = useContext(PreferencesContext)
  return { priorityDisplay, setPriorityDisplay }
}

export function useAutoSnoozeDefault() {
  const {
    autoSnoozeDefault,
    setAutoSnoozeDefault,
    autoSnoozeUrgent,
    setAutoSnoozeUrgent,
    autoSnoozeHigh,
    setAutoSnoozeHigh,
  } = useContext(PreferencesContext)
  return {
    autoSnoozeDefault,
    setAutoSnoozeDefault,
    autoSnoozeUrgent,
    setAutoSnoozeUrgent,
    autoSnoozeHigh,
    setAutoSnoozeHigh,
  }
}

export function useSnoozePreferences() {
  const { defaultSnoozeOption, setDefaultSnoozeOption, morningTime, setMorningTime } =
    useContext(PreferencesContext)
  return { defaultSnoozeOption, setDefaultSnoozeOption, morningTime, setMorningTime }
}

export function useSchedulePreferences() {
  const { wakeTime, setWakeTime, sleepTime, setSleepTime } = useContext(PreferencesContext)
  return { wakeTime, setWakeTime, sleepTime, setSleepTime }
}

export function useDefaultGrouping() {
  const { defaultGrouping, setDefaultGrouping } = useContext(PreferencesContext)
  return { defaultGrouping, setDefaultGrouping }
}

export function useAiContext() {
  const { aiContext, setAiContext } = useContext(PreferencesContext)
  return { aiContext, setAiContext }
}

export function useNotificationConfig() {
  const {
    notificationsEnabled,
    setNotificationsEnabled,
    criticalAlertVolume,
    setCriticalAlertVolume,
  } = useContext(PreferencesContext)
  return {
    notificationsEnabled,
    setNotificationsEnabled,
    criticalAlertVolume,
    setCriticalAlertVolume,
  }
}

export function useAiPreferences() {
  const {
    aiMode,
    setAiMode,
    aiShowScores,
    setAiShowScores,
    aiShowSignals,
    setAiShowSignals,
    aiShowWhatsNext,
    setAiShowWhatsNext,
    aiShowInsights,
    setAiShowInsights,
    aiShowCommentary,
    setAiShowCommentary,
    aiWhatsNextModel,
    setAiWhatsNextModel,
    aiWnCommentaryUnfiltered,
    setAiWnCommentaryUnfiltered,
    aiWnHighlight,
    setAiWnHighlight,
    aiInsightsSignalChips,
    setAiInsightsSignalChips,
    aiInsightsScoreChips,
    setAiInsightsScoreChips,
    aiQuickTake,
    setAiQuickTake,
  } = useContext(PreferencesContext)
  return {
    aiMode,
    setAiMode,
    aiShowScores,
    setAiShowScores,
    aiShowSignals,
    setAiShowSignals,
    aiShowWhatsNext,
    setAiShowWhatsNext,
    aiShowInsights,
    setAiShowInsights,
    aiShowCommentary,
    setAiShowCommentary,
    aiWhatsNextModel,
    setAiWhatsNextModel,
    aiWnCommentaryUnfiltered,
    setAiWnCommentaryUnfiltered,
    aiWnHighlight,
    setAiWnHighlight,
    aiInsightsSignalChips,
    setAiInsightsSignalChips,
    aiInsightsScoreChips,
    setAiInsightsScoreChips,
    aiQuickTake,
    setAiQuickTake,
  }
}

export function useAiAvailable() {
  return useContext(PreferencesContext).aiAvailable
}
