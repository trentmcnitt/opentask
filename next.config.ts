import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  /**
   * Pin the workspace root that standalone output is traced from.
   *
   * Without this, Next.js infers the root by walking up for a lockfile. That is
   * correct in the main checkout, but a build run inside a git worktree
   * (`.claude/worktrees/<id>/`) walks up PAST the worktree and lands on the
   * outer checkout — so `server.js` is emitted nested under
   * `.next/standalone/.claude/worktrees/<id>/` instead of at the top of the
   * bundle.
   *
   * That is not a cosmetic difference. `opentask-infra`'s deploy script
   * rsyncs the bundle with `--delete`, and against the nested layout it
   * removed the RUNNING service's `server.js` — four times across two
   * sessions on 2026-09-22, each needing a manual repair on the server.
   *
   * `__dirname` is this file's directory, so the root is always the checkout
   * being built, whichever one that is.
   */
  outputFileTracingRoot: __dirname,
  reactCompiler: true,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ]
  },
}

export default nextConfig
