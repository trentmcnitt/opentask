'use client'

import { Suspense, useState } from 'react'
import { signIn } from 'next-auth/react'
import { useRouter, useSearchParams } from 'next/navigation'
import Image from 'next/image'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { safeCallbackUrl } from '@/lib/login-redirect'

/**
 * The form is split out from the page because `useSearchParams()` opts a component into
 * client-side rendering — Next.js requires it to sit inside a Suspense boundary so the rest
 * of the page can still be prerendered.
 */
function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (loading) return
    setError('')
    setLoading(true)

    try {
      const result = await signIn('credentials', {
        username,
        password,
        redirect: false,
      })

      if (result?.error) {
        setError('Invalid username or password')
        setLoading(false)
      } else {
        // Return to wherever the auth guard bounced the user from (e.g. /?task=123 from an
        // iOS widget, /tasks/123 from a notification). Validated to block open redirects.
        router.push(safeCallbackUrl(searchParams.get('callbackUrl')))
        router.refresh()
      }
    } catch {
      setError('An error occurred')
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div>
        <label htmlFor="username" className="mb-1.5 block text-sm font-medium">
          Username
        </label>
        <Input
          id="username"
          name="username"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Enter your username"
          required
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>

      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
          Password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter your password"
          required
        />
      </div>

      <Button type="submit" disabled={loading} className="w-full">
        {loading ? 'Signing in...' : 'Sign in'}
      </Button>
    </form>
  )
}

/** Placeholder with the same vertical rhythm as the form, so there is no layout shift. */
function LoginFormFallback() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <div className="bg-muted h-16 animate-pulse rounded-md" />
      <div className="bg-muted h-16 animate-pulse rounded-md" />
      <div className="bg-muted h-9 animate-pulse rounded-md" />
    </div>
  )
}

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <Image
            src="/opentask-logo.png"
            alt="OpenTask"
            width={180}
            height={54}
            className="mx-auto"
            unoptimized
            priority
          />
          <p className="text-muted-foreground mt-1">Sign in to continue</p>
        </div>

        {process.env.NEXT_PUBLIC_DEMO_MODE === '1' && (
          <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-center text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
            Try it out &mdash; username: <strong>demo</strong>, password: <strong>demo</strong>
          </div>
        )}

        <Suspense fallback={<LoginFormFallback />}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  )
}
