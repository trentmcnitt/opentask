'use client'

import { createContext, useContext, useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import type { LabelConfig } from '@/types'

interface LabelConfigContextValue {
  labelConfig: LabelConfig[]
  setLabelConfig: (config: LabelConfig[]) => void
}

const LabelConfigContext = createContext<LabelConfigContextValue>({
  labelConfig: [],
  setLabelConfig: () => {},
})

export function LabelConfigProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const [labelConfig, setLabelConfigState] = useState<LabelConfig[]>([])

  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/user/preferences')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.data?.label_config) {
          setLabelConfigState(data.data.label_config)
        }
      })
      .catch(() => {})
  }, [status])

  return (
    <LabelConfigContext.Provider value={{ labelConfig, setLabelConfig: setLabelConfigState }}>
      {children}
    </LabelConfigContext.Provider>
  )
}

export function useLabelConfig() {
  return useContext(LabelConfigContext)
}
