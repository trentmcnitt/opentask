import 'next-auth'
import 'next-auth/jwt'

declare module 'next-auth' {
  interface User {
    id: string
    timezone: string
    default_grouping: string
    is_demo: boolean
  }

  interface Session {
    user: User & {
      email: string
      name: string
    }
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string
    timezone: string
    default_grouping: string
    is_demo: boolean
  }
}
