'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { SettingsSection } from './SettingsSection'

/**
 * Settings → Connected App: shown only inside the native iOS wrapper (the page
 * decides). Disconnect asks the app, through its WKWebView message handler, to
 * clear its credentials and return to the setup screen.
 */
export function ConnectedAppSection() {
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false)

  return (
    <SettingsSection
      title="Connected App"
      description={
        <>
          This app is connected to {typeof window !== 'undefined' ? window.location.origin : ''}.
          Disconnecting will clear your credentials and return to the setup screen.
        </>
      }
    >
      {showDisconnectConfirm ? (
        <div className="space-y-2">
          <p className="text-sm text-red-600 dark:text-red-400">
            You&apos;ll need to re-enter the server URL to reconnect.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                const w = window as unknown as {
                  webkit?: {
                    messageHandlers?: { opentask?: { postMessage: (msg: unknown) => void } }
                  }
                }
                w.webkit?.messageHandlers?.opentask?.postMessage({ action: 'disconnect' })
              }}
            >
              Disconnect
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowDisconnectConfirm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowDisconnectConfirm(true)}
          className="w-full rounded-lg border border-red-200 p-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
        >
          Disconnect App
        </button>
      )}
    </SettingsSection>
  )
}
