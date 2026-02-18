import { success } from '@/lib/api-response'

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || ''

export async function GET() {
  return success({ publicKey: VAPID_PUBLIC_KEY })
}
