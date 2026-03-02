/**
 * NextAuth configuration for OpenTask
 *
 * Uses credentials provider for username/password authentication.
 */

import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { validateCredentials, getUserById } from '@/core/auth/session'
import { checkRateLimit, recordFailedAttempt, clearAttempts } from '@/core/auth/rate-limit'

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      name: 'credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials?.password) {
          return null
        }

        const username = credentials.username as string

        // Demo account is public (password shown on login page) — rate limiting
        // provides no security value and would block legitimate visitors
        const isDemoUser =
          process.env.NEXT_PUBLIC_DEMO_MODE === '1' && username.toLowerCase() === 'demo'

        // Check rate limit before attempting validation
        if (!isDemoUser) {
          const waitSeconds = checkRateLimit(username)
          if (waitSeconds !== null) {
            throw new Error(`Too many login attempts. Try again in ${waitSeconds} seconds.`)
          }
        }

        const user = await validateCredentials(username, credentials.password as string)

        if (!user) {
          if (!isDemoUser) recordFailedAttempt(username)
          return null
        }

        if (!isDemoUser) clearAttempts(username)

        // Return user object that will be stored in the JWT
        return {
          id: String(user.id),
          email: user.email,
          name: user.name,
          timezone: user.timezone,
          default_grouping: user.default_grouping,
          is_demo: user.is_demo,
        }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      // On sign in, store the user ID in the token
      if (user) {
        token.id = user.id
        token.timezone = user.timezone
        token.default_grouping = user.default_grouping
        token.is_demo = user.is_demo
      }

      // Refresh user data from DB on every request so preference changes
      // (timezone, default_grouping) take effect without re-login
      if (token.id) {
        const freshUser = getUserById(Number(token.id))
        if (freshUser) {
          token.timezone = freshUser.timezone
          token.default_grouping = freshUser.default_grouping
          token.is_demo = freshUser.is_demo
        }
      }

      return token
    },
    session({ session, token }) {
      // Add user data from token to session
      if (token && session.user) {
        session.user.id = token.id
        session.user.timezone = token.timezone
        session.user.default_grouping = token.default_grouping
        session.user.is_demo = token.is_demo
      }
      return session
    },
  },
  pages: {
    signIn: '/login',
  },
  session: {
    strategy: 'jwt',
    maxAge: 7 * 24 * 60 * 60, // 7 days (default is 30 days)
  },
  trustHost: true,
})
