import type { Metadata, Viewport } from 'next'
import Script from 'next/script'
import { Inter } from 'next/font/google'
import { ThemeProvider } from 'next-themes'
import { SessionProvider } from '@/components/SessionProvider'
import { PreferencesProvider } from '@/components/PreferencesProvider'
import { ProjectsProvider } from '@/components/ProjectsProvider'
import { AppLayoutWrapper } from '@/components/AppLayoutWrapper'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'OpenTask',
  description: 'AI-assisted task management',
  manifest: '/manifest.json',
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
                <AppLayoutWrapper>{children}</AppLayoutWrapper>
                <Toaster position="bottom-center" />
              </ProjectsProvider>
            </PreferencesProvider>
          </SessionProvider>
        </ThemeProvider>
        {process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID && (
          <Script
            src={`${process.env.NEXT_PUBLIC_UMAMI_SCRIPT_URL || 'https://analytics.tk11.mcnitt.io'}/script.js`}
            data-website-id={process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID}
            strategy="afterInteractive"
          />
        )}
      </body>
    </html>
  )
}
