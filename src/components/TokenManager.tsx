'use client'

import { useState, useEffect, useCallback } from 'react'
import { Copy, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { showToast } from '@/lib/toast'

interface TokenInfo {
  id: number
  name: string
  created_at: string
  token_preview: string
}

interface CreatedToken {
  id: number
  name: string
  token: string
}

export default function TokenManager() {
  const [tokens, setTokens] = useState<TokenInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [newTokenName, setNewTokenName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createdToken, setCreatedToken] = useState<CreatedToken | null>(null)
  const [revokingId, setRevokingId] = useState<number | null>(null)

  const fetchTokens = useCallback(async () => {
    try {
      const res = await fetch('/api/tokens')
      if (res.ok) {
        const json = await res.json()
        setTokens(json.data.tokens)
      }
    } catch {
      showToast({ message: 'Failed to load tokens', type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTokens()
  }, [fetchTokens])

  const handleCreate = async () => {
    const name = newTokenName.trim()
    if (!name) return
    setCreating(true)
    try {
      const res = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const json = await res.json()
        showToast({ message: json.error || 'Failed to create token', type: 'error' })
        return
      }
      const json = await res.json()
      setCreatedToken(json.data)
      setNewTokenName('')
      fetchTokens()
    } catch {
      showToast({ message: 'Failed to create token', type: 'error' })
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (id: number) => {
    try {
      const res = await fetch(`/api/tokens/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        showToast({ message: 'Failed to revoke token', type: 'error' })
        return
      }
      setTokens((prev) => prev.filter((t) => t.id !== id))
      setRevokingId(null)
      showToast({ message: 'Token revoked', type: 'success' })
    } catch {
      showToast({ message: 'Failed to revoke token', type: 'error' })
    }
  }

  const handleCopy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token)
      showToast({ message: 'Token copied to clipboard', type: 'success' })
    } catch {
      showToast({ message: 'Failed to copy token', type: 'error' })
    }
  }

  if (loading) {
    return <div className="text-sm text-zinc-400">Loading...</div>
  }

  return (
    <div className="space-y-3">
      {createdToken && (
        <NewTokenDisplay
          token={createdToken}
          onCopy={handleCopy}
          onDismiss={() => setCreatedToken(null)}
        />
      )}

      {tokens.length > 0 && (
        <div className="space-y-1">
          {tokens.map((token) => (
            <div key={token.id} className="flex items-center justify-between gap-2 py-1.5">
              <div className="min-w-0">
                <div className="text-sm font-medium">{token.name}</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  {formatDate(token.created_at)} &middot; ····{token.token_preview}
                </div>
              </div>
              {revokingId === token.id ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7 text-xs"
                    onClick={() => handleRevoke(token.id)}
                  >
                    Revoke
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => setRevokingId(null)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <button
                  onClick={() => setRevokingId(token.id)}
                  className="shrink-0 text-zinc-400 transition-colors hover:text-red-500"
                  aria-label={`Revoke ${token.name}`}
                >
                  <X className="size-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Input
          type="text"
          value={newTokenName}
          onChange={(e) => setNewTokenName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreate()
          }}
          placeholder="Token name"
          className="h-8 text-sm"
          maxLength={100}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={handleCreate}
          disabled={!newTokenName.trim() || creating}
          className="h-8"
        >
          Create
        </Button>
      </div>
    </div>
  )
}

function NewTokenDisplay({
  token,
  onCopy,
  onDismiss,
}: {
  token: CreatedToken
  onCopy: (token: string) => void
  onDismiss: () => void
}) {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/30">
      <p className="mb-2 text-xs font-medium text-amber-800 dark:text-amber-200">
        Copy this token now. You won&apos;t be able to see it again.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 rounded bg-white px-2 py-1 font-mono text-xs break-all dark:bg-zinc-900">
          {token.token}
        </code>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0"
          onClick={() => onCopy(token.token)}
        >
          <Copy className="mr-1 size-3" />
          Copy
        </Button>
      </div>
      <Button size="sm" variant="ghost" className="mt-2 h-7 text-xs" onClick={onDismiss}>
        Done
      </Button>
    </div>
  )
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}
