import { redirect } from 'next/navigation'
import { auth } from '@/app/api/auth/[...nextauth]/auth'
import { getTasks } from '@/core/tasks'
import { formatTasksResponse } from '@/lib/format-task'
import DashboardClient from '@/components/DashboardClient'

export default async function Home() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const userId = Number(session.user.id)
  const tasks = formatTasksResponse(getTasks({ userId, limit: 500 }))

  return <DashboardClient initialTasks={tasks} />
}
