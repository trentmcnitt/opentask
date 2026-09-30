'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  useAutoSnoozeDefault,
  useNotificationConfig,
  useAiAvailable,
} from '@/components/PreferencesProvider'
import { usePushSubscription } from '@/hooks/usePushSubscription'
import { showToast } from '@/lib/toast'
import { savePreference, savePreferenceField } from '@/lib/save-preference'
import { AutoSnoozeRow } from './AutoSnoozeRow'
import { SettingsSection } from './SettingsSection'

type TestType = 'individual' | 'high' | 'bulk' | 'urgent' | 'critical'
/** Which test send is in flight: 'push' (Send Test Push), a test type, or none. */
type Sending = TestType | 'push' | null
interface SendingProps {
  sending: Sending
  setSending: (s: Sending) => void
}

const TEST_BUTTONS: { type: TestType; label: string }[] = [
  { type: 'individual', label: 'Individual' },
  { type: 'high', label: 'High' },
  { type: 'bulk', label: 'Bulk' },
  { type: 'urgent', label: 'Urgent' },
  { type: 'critical', label: 'Critical' },
]

/**
 * Settings → Notifications: the master switch, the "AI finished" switch, the
 * per-priority auto-snooze intervals, critical alert volume, this browser's
 * web push subscription, and the test-notification buttons.
 */
export function NotificationsSection() {
  const {
    notificationsEnabled,
    setNotificationsEnabled,
    enrichmentNotificationsEnabled,
    setEnrichmentNotificationsEnabled,
    criticalAlertVolume,
    setCriticalAlertVolume,
  } = useNotificationConfig()
  const aiAvailable = useAiAvailable()
  // One send at a time across the whole section: while any test (the test
  // push or a test notification) is in flight, the test buttons are disabled.
  const [sending, setSending] = useState<Sending>(null)

  const handleNotificationsEnabledChange = (checked: boolean) => {
    const prev = notificationsEnabled
    return savePreference(
      { notifications_enabled: checked },
      {
        apply: () => setNotificationsEnabled(checked),
        revert: () => setNotificationsEnabled(prev),
        successMessage: checked ? 'Notifications enabled' : 'Notifications disabled',
      },
    )
  }

  const handleEnrichmentNotificationsChange = (checked: boolean) =>
    savePreferenceField(
      'enrichment_notifications_enabled',
      checked,
      enrichmentNotificationsEnabled,
      setEnrichmentNotificationsEnabled,
    )

  return (
    <SettingsSection title="Notifications">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-sm">Task reminders</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            Send notifications when tasks become overdue
          </div>
        </div>
        <Switch
          checked={notificationsEnabled}
          onCheckedChange={(checked) => void handleNotificationsEnabledChange(checked)}
          aria-label="Toggle notifications"
        />
      </div>
      {/* The quiet "AI finished" push (src/core/notifications/enrichment-notify.ts).
          Only where AI runs, like the AI section; greyed out while
          notifications as a whole are off, since the server sends none then. */}
      {aiAvailable && (
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-sm">Notify when AI finishes a new task</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              A quiet notification with what AI filled in — project, due date, priority
            </div>
          </div>
          <Switch
            checked={enrichmentNotificationsEnabled}
            disabled={!notificationsEnabled}
            onCheckedChange={(checked) => void handleEnrichmentNotificationsChange(checked)}
            aria-label="Notify when AI finishes a new task"
          />
        </div>
      )}
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
        How often to repeat notifications for overdue tasks, by priority tier.
      </p>
      <AutoSnoozeRows />

      {/* Critical Alert Volume */}
      <div className="mt-4 flex items-center justify-between">
        <div>
          <div className="text-sm">Critical alert volume</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            Sound volume for urgent (P4) alerts that bypass Do Not Disturb
          </div>
        </div>
        <select
          value={criticalAlertVolume}
          onChange={(e) =>
            void savePreferenceField(
              'critical_alert_volume',
              parseFloat(e.target.value),
              criticalAlertVolume,
              setCriticalAlertVolume,
            )
          }
          className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value={0.25}>25%</option>
          <option value={0.5}>50%</option>
          <option value={0.75}>75%</option>
          <option value={1}>100%</option>
        </select>
      </div>

      <WebPushBlock sending={sending} setSending={setSending} />
      <TestNotificationsBlock sending={sending} setSending={setSending} />
    </SettingsSection>
  )
}

/** The five priority tiers' auto-snooze intervals, lowest first. */
function AutoSnoozeRows() {
  const {
    autoSnoozeDefault,
    setAutoSnoozeDefault,
    autoSnoozeUrgent,
    setAutoSnoozeUrgent,
    autoSnoozeHigh,
    setAutoSnoozeHigh,
    autoSnoozeLow,
    setAutoSnoozeLow,
    autoSnoozeMedium,
    setAutoSnoozeMedium,
  } = useAutoSnoozeDefault()

  return (
    <div className="space-y-3">
      {/* Default auto-snooze */}
      <AutoSnoozeRow
        label="Default auto-snooze"
        description="Repeat interval for unset-priority (P0) overdue tasks"
        value={autoSnoozeDefault}
        onChange={(v) =>
          savePreferenceField('auto_snooze_minutes', v, autoSnoozeDefault, setAutoSnoozeDefault)
        }
      />
      {/* §4.1: Low is rare but never silent */}
      <AutoSnoozeRow
        label="Low auto-snooze"
        description="Repeat interval for low (P1) overdue tasks"
        value={autoSnoozeLow}
        onChange={(v) =>
          savePreferenceField('auto_snooze_low_minutes', v, autoSnoozeLow, setAutoSnoozeLow)
        }
      />
      {/* §4.1: Medium is NOT notify-once — one missed glance would lose it */}
      <AutoSnoozeRow
        label="Medium auto-snooze"
        description="Repeat interval for medium (P2) overdue tasks"
        value={autoSnoozeMedium}
        onChange={(v) =>
          savePreferenceField(
            'auto_snooze_medium_minutes',
            v,
            autoSnoozeMedium,
            setAutoSnoozeMedium,
          )
        }
        labelColor="text-yellow-600"
      />
      {/* High auto-snooze */}
      <AutoSnoozeRow
        label="High auto-snooze"
        description="Repeat interval for high (P3) overdue tasks"
        value={autoSnoozeHigh}
        onChange={(v) =>
          savePreferenceField('auto_snooze_high_minutes', v, autoSnoozeHigh, setAutoSnoozeHigh)
        }
        labelColor="text-orange-500"
      />
      {/* Urgent auto-snooze */}
      <AutoSnoozeRow
        label="Urgent auto-snooze"
        description="Repeat interval for urgent (P4) overdue tasks"
        value={autoSnoozeUrgent}
        onChange={(v) =>
          savePreferenceField(
            'auto_snooze_urgent_minutes',
            v,
            autoSnoozeUrgent,
            setAutoSnoozeUrgent,
          )
        }
        labelColor="text-red-500"
      />
    </div>
  )
}

/** This browser's web push subscription, or why it isn't available. */
function WebPushBlock({ sending, setSending }: SendingProps) {
  const push = usePushSubscription()

  const handleToggle = async (checked: boolean) => {
    try {
      if (checked) {
        await push.subscribe()
        showToast({ message: 'Web push enabled for this browser', type: 'success' })
      } else {
        await push.unsubscribe()
        showToast({ message: 'Web push disabled for this browser', type: 'success' })
      }
    } catch {
      showToast({ message: 'Failed to update web push subscription', type: 'error' })
    }
  }

  const sendTestPush = async () => {
    setSending('push')
    try {
      const res = await fetch('/api/push/test', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to send')
      showToast({ message: 'Test push sent', type: 'success' })
    } catch {
      showToast({ message: 'Failed to send test push', type: 'error' })
    } finally {
      setSending(null)
    }
  }

  return (
    <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <h3 className="mb-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
        Web Push
      </h3>
      {!push.isSupported ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Web push notifications are not supported in this browser. On iOS, add the app to your home
          screen first.
        </p>
      ) : push.isServerConfigured === false ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Web push notifications are not configured on this server. The server administrator needs
          to set up VAPID keys.
        </p>
      ) : push.permission === 'denied' ? (
        <p className="text-xs text-red-600 dark:text-red-400">
          Web push notifications are blocked. Reset the permission in your browser settings to
          enable them.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm">Web push notifications</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {push.isSubscribed
                  ? 'This browser will receive push notifications'
                  : 'Enable push notifications in this browser'}
              </div>
            </div>
            <Switch
              checked={push.isSubscribed}
              disabled={push.isLoading}
              onCheckedChange={handleToggle}
              aria-label="Toggle web push notifications"
            />
          </div>
          {push.isSubscribed && (
            <Button
              size="sm"
              variant="outline"
              disabled={sending === 'push'}
              onClick={sendTestPush}
            >
              {sending === 'push' ? 'Sending...' : 'Send Test Push'}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One button per priority level; each creates a real test task on the server
 * and notifies every channel 3 seconds later.
 */
function TestNotificationsBlock({ sending, setSending }: SendingProps) {
  const sendTestNotification = async (type: TestType) => {
    setSending(type)
    try {
      const res = await fetch('/api/notifications/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      })
      if (!res.ok) throw new Error('Failed to send')
      showToast({
        message: `Notification coming in 3s — switch away from this tab`,
        type: 'success',
      })
    } catch {
      showToast({ message: `Failed to send test notification`, type: 'error' })
    } finally {
      setSending(null)
    }
  }

  return (
    <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <h3 className="mb-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
        Test Notifications
      </h3>
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
        Creates a real test task and sends notifications to all channels (web push and iOS) after a
        3-second delay. Each button tests a different priority level.
      </p>
      <div className="flex flex-wrap gap-2">
        {TEST_BUTTONS.map(({ type, label }) => (
          <Button
            key={type}
            size="sm"
            variant="outline"
            disabled={sending !== null}
            onClick={() => sendTestNotification(type)}
          >
            {sending === type ? 'Sending...' : label}
          </Button>
        ))}
      </div>
    </div>
  )
}
