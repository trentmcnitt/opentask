'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

interface UsePushSubscriptionResult {
  isSupported: boolean
  permission: NotificationPermission | 'unsupported'
  isSubscribed: boolean
  isLoading: boolean
  isServerConfigured: boolean | null
  subscribe: () => Promise<void>
  unsubscribe: () => Promise<void>
}

export function usePushSubscription(): UsePushSubscriptionResult {
  const [isSupported, setIsSupported] = useState(false)
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    'unsupported',
  )
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isServerConfigured, setIsServerConfigured] = useState<boolean | null>(null)
  const vapidPublicKeyRef = useRef<string | null>(null)

  // Check support and current subscription state on mount
  useEffect(() => {
    async function check() {
      if (!('PushManager' in window) || !('serviceWorker' in navigator)) {
        setIsSupported(false)
        setPermission('unsupported')
        setIsLoading(false)
        return
      }

      setIsSupported(true)
      setPermission(Notification.permission)

      try {
        const keyRes = await fetch('/api/push/vapid-key')
        const keyData = await keyRes.json()
        setIsServerConfigured(keyData.data?.configured ?? false)
        if (keyData.data?.publicKey) {
          vapidPublicKeyRef.current = keyData.data.publicKey
        }
      } catch {
        setIsServerConfigured(false)
      }

      try {
        const registration = await navigator.serviceWorker.ready
        const sub = await registration.pushManager.getSubscription()
        setIsSubscribed(sub !== null)
      } catch {
        setIsSubscribed(false)
      }
      setIsLoading(false)
    }
    check()
  }, [])

  const subscribe = useCallback(async () => {
    setIsLoading(true)
    try {
      const perm = await Notification.requestPermission()
      setPermission(perm)
      if (perm !== 'granted') {
        setIsLoading(false)
        return
      }

      // Use cached VAPID public key from mount check, or fetch if not available
      let vapidPublicKey = vapidPublicKeyRef.current
      if (!vapidPublicKey) {
        const keyRes = await fetch('/api/push/vapid-key')
        const keyData = await keyRes.json()
        vapidPublicKey = keyData.data?.publicKey
      }
      if (!vapidPublicKey) {
        throw new Error('VAPID public key not configured on server')
      }

      const registration = await navigator.serviceWorker.ready
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey).buffer as ArrayBuffer,
      })

      // Send subscription to server
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      })
      if (!res.ok) throw new Error('Failed to save subscription')

      setIsSubscribed(true)
    } catch (err) {
      console.error('Push subscribe error:', err)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [])

  const unsubscribe = useCallback(async () => {
    setIsLoading(true)
    try {
      const registration = await navigator.serviceWorker.ready
      const sub = await registration.pushManager.getSubscription()
      if (sub) {
        // Remove from server first
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        })
        await sub.unsubscribe()
      }
      setIsSubscribed(false)
    } catch (err) {
      console.error('Push unsubscribe error:', err)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [])

  return {
    isSupported,
    permission,
    isSubscribed,
    isLoading,
    isServerConfigured,
    subscribe,
    unsubscribe,
  }
}

// Convert VAPID public key from base64 URL to Uint8Array for pushManager.subscribe()
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}
