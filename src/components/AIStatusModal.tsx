'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'
import { AIStatusContent, type AIStatusData } from '@/components/AIStatusContent'
import { useAiFeatureInfo } from '@/components/PreferencesProvider'

interface AIStatusModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  timezone: string
}

export function AIStatusModal({ open, onOpenChange, timezone }: AIStatusModalProps) {
  const { aiFeatureInfo } = useAiFeatureInfo()
  const [data, setData] = useState<AIStatusData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const fetchStatus = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const res = await fetch('/api/ai/status')
      if (!res.ok) {
        setError(true)
        return
      }
      const json = await res.json()
      if (json.data) {
        setData(json.data)
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      fetchStatus()
    }
  }, [open, fetchStatus])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>AI Status</DialogTitle>
          <VisuallyHidden>
            <DialogDescription>AI system status and recent activity</DialogDescription>
          </VisuallyHidden>
        </DialogHeader>

        {loading ? (
          <div className="text-muted-foreground animate-pulse py-8 text-center">Loading...</div>
        ) : error || !data ? (
          <div className="py-8 text-center">
            <p className="text-muted-foreground">
              {error ? 'AI features are not available.' : 'No data.'}
            </p>
            <button
              onClick={fetchStatus}
              className="text-muted-foreground hover:text-foreground mt-2 text-sm"
            >
              Retry
            </button>
          </div>
        ) : (
          <AIStatusContent
            data={data}
            timezone={timezone}
            onRefresh={fetchStatus}
            featureInfo={aiFeatureInfo}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
