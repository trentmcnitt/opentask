/**
 * NextAuth configuration for OpenTask
 *
 * Uses credentials provider for email/password authentication.
 */

import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { validateCredentials } from '@/core/auth/session'
import type { AuthUser } from '@/types'

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

        const user = await validateCredentials(
          credentials.username as string,
          credentials.password as string,
        )

        if (!user) {
          return null
        }

        // Return user object that will be stored in the JWT
        return {
          id: String(user.id),
          email: user.email,
          name: user.name,
          timezone: user.timezone,
        }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      // On sign in, add user data to the token
      if (user) {
        token.id = user.id
        token.timezone = (user as AuthUser & { id: string }).timezone
      }
      return token
    },
    session({ session, token }) {
      // Add user data from token to session
      if (token && session.user) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const user = session.user as any
        user.id = token.id as string
        user.timezone = token.timezone as string
      }
      return session
    },
  },
  pages: {
    signIn: '/login',
  },
  session: {
    strategy: 'jwt',
  },
  trustHost: true,
})
