import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import { Inter } from 'next/font/google'
import { ThemeProvider } from 'next-themes'
import { SessionProvider } from '@/components/SessionProvider'
import { PreferencesProvider } from '@/components/PreferencesProvider'
import { ProjectsProvider } from '@/components/ProjectsProvider'
import { NavigationGuardProvider } from '@/components/NavigationGuardProvider'
import { AppLayoutWrapper } from '@/components/AppLayoutWrapper'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL('https://opentask.mcnitt.io'),
  title: 'OpenTask — Self-Hosted AI Task Management',
  description:
    'Self-hosted task management with AI woven into every layer. Priority scoring, smart snooze, recurrence, and intelligent filtering — all running on your own server.',
  manifest: '/manifest.json',
  icons: {
    icon: '/opentask-sun-logo.png',
    apple: '/icon-192.png',
  },
  openGraph: {
    title: 'OpenTask — Self-Hosted AI Task Management',
    description:
      'Self-hosted task management with AI woven into every layer. Priority scoring, smart snooze, recurrence, and intelligent filtering — all running on your own server.',
    url: 'https://opentask.mcnitt.io',
    siteName: 'OpenTask',
    images: [
      {
        url: '/opentask-sun-logo.png',
        width: 548,
        height: 548,
        type: 'image/png',
      },
    ],
    type: 'website',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'OpenTask',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <SessionProvider>
            <PreferencesProvider>
              <ProjectsProvider>
                <NavigationGuardProvider>
                  <AppLayoutWrapper>{children}</AppLayoutWrapper>
                  <Toaster position="bottom-center" />
                </NavigationGuardProvider>
              </ProjectsProvider>
            </PreferencesProvider>
          </SessionProvider>
        </ThemeProvider>
        {process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID && process.env.NEXT_PUBLIC_UMAMI_SCRIPT_URL && (
          <Script
            src={`${process.env.NEXT_PUBLIC_UMAMI_SCRIPT_URL}/script.js`}
            data-website-id={process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID}
            strategy="afterInteractive"
          />
        )}
      </body>
    </html>
  )
}
