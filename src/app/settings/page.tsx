'use client'

import { useSyncExternalStore } from 'react'
import Link from 'next/link'
import { signOut } from 'next-auth/react'
import { ExternalLink } from 'lucide-react'
import TokenManager from '@/components/TokenManager'
import { useAiAvailable } from '@/components/PreferencesProvider'
import { useRequireSession } from '@/hooks/useRequireSession'
import { PageLoading } from '@/components/PageLoading'
import { BUILD_ID, VERSION, formatBuildDate } from '@/lib/build-info'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { AppearanceSection, PriorityDisplaySection } from '@/components/settings/AppearanceSection'
import { NotificationsSection } from '@/components/settings/NotificationsSection'
import { SnoozeSection } from '@/components/settings/SnoozeSection'
import { ScheduleSection } from '@/components/settings/ScheduleSection'
import { LabelsSection } from '@/components/settings/LabelsSection'
import { ProjectsSection } from '@/components/settings/ProjectsSection'
import { AiSection } from '@/components/settings/AiSection'
import { ConnectedAppSection } from '@/components/settings/ConnectedAppSection'

const noopSubscribe = () => () => {}

/**
 * Settings. Each section lives in src/components/settings/ and reads and
 * saves its own preferences (through PreferencesProvider and savePreference()).
 * The page keeps only what crosses sections or depends on the environment:
 * the session (`isDemo`), whether AI runs on this server, and whether we're
 * inside the native iOS wrapper.
 */
export default function SettingsPage() {
  const { session, ready } = useRequireSession()
  const aiAvailable = useAiAvailable()
  // Running inside the native iOS app wrapper? (WKWebView injects
  // `__OPENTASK_IOS`.) It never changes, so there's nothing to subscribe to;
  // the server snapshot is false, as before hydration.
  const isNativeApp = useSyncExternalStore(
    noopSubscribe,
    () => '__OPENTASK_IOS' in window,
    () => false,
  )

  const isDemo = session?.user?.is_demo ?? false

  if (!ready) return <PageLoading />

  return (
    <div className="flex-1">
      <header className="safe-top bg-background/80 sticky top-0 z-10 border-b backdrop-blur-sm">
        <div className="mx-auto max-w-2xl px-4 py-3">
          <h1 className="text-xl font-semibold">Settings</h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl space-y-6 px-4 pt-6 pb-10">
        <SettingsSection title="Account">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">Name</span>
              <span>{session?.user?.name || '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Email</span>
              <span>{session?.user?.email || '-'}</span>
            </div>
          </div>
        </SettingsSection>

        <AppearanceSection />

        <SettingsSection title="Help">
          <a
            href="https://opentask.mcnitt.io/docs/"
            target="_blank"
            rel="noopener noreferrer"
            className="-mx-2 flex items-center justify-between rounded-lg p-2 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <span className="text-sm">Documentation</span>
            <ExternalLink className="h-4 w-4 text-zinc-400" />
          </a>
        </SettingsSection>

        <PriorityDisplaySection />
        <NotificationsSection />
        <SnoozeSection />
        <ScheduleSection />
        <LabelsSection />
        <ProjectsSection />

        {/* AI Context — only shown when AI is enabled server-side */}
        {aiAvailable && <AiSection isDemo={isDemo} />}

        <SettingsSection
          title="API Tokens"
          description="Tokens for API access from scripts, Shortcuts, and automation tools."
        >
          <TokenManager isDemo={isDemo} />
        </SettingsSection>

        {/* Navigation links (mobile access to Archive & Trash) */}
        <SettingsSection title="More">
          <div className="space-y-1">
            <Link
              href="/archive"
              className="-mx-2 flex items-center justify-between rounded-lg p-2 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <span className="text-sm">Archive</span>
              <span className="text-xs text-zinc-400">&rsaquo;</span>
            </Link>
            <Link
              href="/trash"
              className="-mx-2 flex items-center justify-between rounded-lg p-2 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <span className="text-sm">Trash</span>
              <span className="text-xs text-zinc-400">&rsaquo;</span>
            </Link>
          </div>
        </SettingsSection>

        <SettingsSection title="About">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">Version</span>
              <span>{VERSION}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Build</span>
              <span>{formatBuildDate(BUILD_ID)}</span>
            </div>
          </div>
        </SettingsSection>

        {/* Disconnect app (only visible inside native iOS wrapper) */}
        {isNativeApp && <ConnectedAppSection />}

        {/* Sign out */}
        <button
          onClick={() => signOut({ callbackUrl: '/login' })}
          className="w-full rounded-lg border border-red-200 p-3 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-900/20"
        >
          Sign Out
        </button>
      </main>
    </div>
  )
}
