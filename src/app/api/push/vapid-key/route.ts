import { success } from '@/lib/api-response'
import { isWebPushConfigured } from '@/core/notifications/web-push'
import { withLogging } from '@/lib/with-logging'

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || ''

export const GET = withLogging(async function GET() {
  return success({
    publicKey: VAPID_PUBLIC_KEY,
    configured: isWebPushConfigured(),
  })
})
