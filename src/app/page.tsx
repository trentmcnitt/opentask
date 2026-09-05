import { redirect } from 'next/navigation'
import { auth } from '@/app/api/auth/[...nextauth]/auth'
import { getTasks } from '@/core/tasks'
import { listTimeSlots } from '@/core/time-slots'
import { formatTasksResponse } from '@/lib/format-task'
import { loginUrlFor } from '@/lib/login-redirect'
import DashboardClient from '@/components/DashboardClient'

type SearchParams = Record<string, string | string[] | undefined>

/** Rebuild the dashboard's own path + query so a login bounce can return to it. */
function dashboardPath(params: SearchParams): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item)
    } else if (value !== undefined) {
      query.set(key, value)
    }
  }
  const qs = query.toString()
  return qs ? `/?${qs}` : '/'
}

export default async function Home({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await auth()
  if (!session?.user?.id) {
    // Preserve deep-link params (e.g. /?task=123 opened from an iOS widget) across login
    redirect(loginUrlFor(dashboardPath(await searchParams)))
  }

  const userId = Number(session.user.id)
  const tasks = formatTasksResponse(getTasks({ userId, limit: 500 }))
  // Slots ride along with the tasks. Fetched client-side they arrived a beat
  // after the first paint, and for that beat the whole day sat under
  // one un-slotted group before regrouping — the load flash Trent noticed.
  const timeSlots = listTimeSlots(userId)

  return <DashboardClient initialTasks={tasks} initialTimeSlots={timeSlots} />
}
