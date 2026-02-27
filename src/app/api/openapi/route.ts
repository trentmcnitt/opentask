/**
 * OpenAPI specification endpoint
 *
 * GET /api/openapi — serves the OpenAPI 3.1 YAML spec (no auth required)
 */

import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { withLogging } from '@/lib/with-logging'

// Read the spec once at module load (not per-request)
let specContent: string | null = null

function getSpec(): string {
  if (specContent) return specContent

  const specPath = path.join(process.cwd(), 'docs', 'openapi.yaml')
  specContent = fs.readFileSync(specPath, 'utf-8')
  return specContent
}

export const GET = withLogging(async function GET() {
  const spec = getSpec()
  return new NextResponse(spec, {
    status: 200,
    headers: {
      'Content-Type': 'text/yaml',
      'Cache-Control': 'public, max-age=3600',
    },
  })
})
