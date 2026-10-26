import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import { Inter } from 'next/font/google'
import { ThemeProvider } from 'next-themes'
import { SessionProvider } from '@/components/SessionProvider'
import { PreferencesProvider } from '@/components/PreferencesProvider'
import { FoldStateProvider } from '@/components/FoldStateProvider'
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
  title: 'OpenTask — Self-Hosted AI Task & Habit Manager',
  description:
    'A self-hosted, AI-powered task and habit manager for web, iPhone, Apple Watch, and Mac. Reminders, quotas, defer-first workflow, and a full REST API — all running on your own server.',
  manifest: '/manifest.json',
  icons: {
    icon: '/opentask-sun-logo.png',
    apple: '/icon-192.png',
  },
  openGraph: {
    title: 'OpenTask — Self-Hosted AI Task & Habit Manager',
    description:
      'A self-hosted, AI-powered task and habit manager for web, iPhone, Apple Watch, and Mac. Reminders, quotas, defer-first workflow, and a full REST API — all running on your own server.',
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

/**
 * NO ZOOM (2026-10-26). An app, not a document: the page is laid out for the
 * phone it is on and is never pinched, double-tapped or zoomed out.
 *
 * Why it matters beyond the pinch itself: on iOS any content wider than the
 * screen lowers the web view's minimum zoom to screen ÷ content, and a pinch
 * or double tap then zooms the whole app out — the header and lists end at
 * three quarters of the screen while the fixed bars (bottom tabs, sheets)
 * stretch to the zoomed-out width (Trent's phone, 2026-10-26: content 532px
 * on a 402px screen, scale 0.756). Worse, a dialog opened in that state has
 * `react-remove-scroll` read `innerWidth − clientWidth` (532 − 402) as a
 * scrollbar and add a 130px right margin to `<body>`, squeezing the page to
 * half the screen. `overflow-x: hidden` on html/body does NOT stop it — in
 * WKWebView the scroll view still takes the overflowing width (measured in
 * the simulator) — so the overflow itself is fixed where it starts and the
 * zoom is shut here as well. The 532px was a link in a task segment row's
 * title on /reminders, unbroken in a 76px column (the global `overflow-wrap`
 * in globals.css now breaks it); at larger sizes still, the header, the
 * dashboard's view-toggle row and Settings' label rows had overflowed too
 * (`Header`, `DashboardClient`, `LabelsSection`). The pages are checked at
 * 119% in tests/e2e/tq-segments-always.spec.ts.
 *
 * - The iOS app (WKWebView) and a Home Screen web app honour these: the
 *   minimum and maximum scale are both 1 even when content overflows, and the
 *   pinch does nothing. WKWebView obeys a page's viewport limits unless its
 *   configuration sets `ignoresViewportScaleLimits`, which the app
 *   (`ios/OpenTask/WebView.swift`) does not; not yet tried on a device.
 * - Safari in a browser tab ignores `user-scalable=no` / `maximum-scale` for
 *   accessibility; there `touch-action: manipulation` (globals.css) still ends
 *   double-tap zoom, and a pinch is Safari's to allow.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
  maximumScale: 1,
  userScalable: false,
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
              {/* Above the router on purpose: the responsive folds it holds
                  must outlive a page segment — see `FoldStateProvider`. */}
              <FoldStateProvider>
                <ProjectsProvider>
                  <NavigationGuardProvider>
                    <AppLayoutWrapper>{children}</AppLayoutWrapper>
                    <Toaster position="bottom-center" />
                  </NavigationGuardProvider>
                </ProjectsProvider>
              </FoldStateProvider>
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
