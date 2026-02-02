/**
 * NextAuth configuration for OpenTask
 *
 * Uses credentials provider for email/password authentication.
 */

import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { validateCredentials } from '@/core/auth/session'

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
          default_grouping: user.default_grouping,
        }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      // On sign in, add user data to the token
      if (user) {
        token.id = user.id
        token.timezone = user.timezone
        token.default_grouping = user.default_grouping
      }
      return token
    },
    session({ session, token }) {
      // Add user data from token to session
      if (token && session.user) {
        session.user.id = token.id
        session.user.timezone = token.timezone
        session.user.default_grouping = token.default_grouping
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
