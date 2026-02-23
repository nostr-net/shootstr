import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SimplePool } from 'nostr-tools'

// Minimal mock of SimplePool.subscribeMany
function makePool(opts: {
  events?: Array<{ pubkey: string; created_at: number; kind: number }>
  eoseImmediately?: boolean
  closeReasons?: string[]
  delayMs?: number
}): SimplePool {
  return {
    subscribeMany(_relays: string[], _filters: unknown[], params: {
      onevent?: (e: unknown) => void
      oneose?: () => void
      onclose?: (reasons: string[]) => void
    }) {
      const events = opts.events ?? []
      const delay = opts.delayMs ?? 0

      const run = () => {
        events.forEach(e => params.onevent?.(e))
        if (opts.eoseImmediately !== false) {
          params.oneose?.()
        }
        if (opts.closeReasons) {
          params.onclose?.(opts.closeReasons)
        }
      }

      if (delay > 0) {
        setTimeout(run, delay)
      } else {
        run()
      }

      return { close: vi.fn() }
    },
  } as unknown as SimplePool
}

// Import after mocking is set up — we test the function directly
// smartQuery will be exported for testing
let smartQuery: typeof import('../src/nostr.ts').smartQuery

beforeEach(async () => {
  const mod = await import('../src/nostr.ts')
  smartQuery = mod.smartQuery
})

describe('smartQuery', () => {
  it('returns events emitted before oneose', async () => {
    const pool = makePool({
      events: [
        { pubkey: 'a', created_at: 100, kind: 1 },
        { pubkey: 'b', created_at: 200, kind: 1 },
      ],
    })
    const events = await smartQuery(pool, ['wss://relay.test'], { kinds: [1], limit: 10 })
    expect(events).toHaveLength(2)
  })

  it('resolves on timeout when no oneose', async () => {
    const pool = makePool({ events: [], eoseImmediately: false, delayMs: 999999 })
    const start = Date.now()
    await smartQuery(pool, ['wss://relay.test'], { limit: 1 }, { timeoutMs: 50 })
    expect(Date.now() - start).toBeGreaterThanOrEqual(50)
  })

  it('skips relays in deadRelays', async () => {
    const subscribeSpy = vi.fn().mockReturnValue({ close: vi.fn() })
    const pool = { subscribeMany: subscribeSpy } as unknown as SimplePool
    const dead = new Set(['wss://dead.relay'])
    await smartQuery(pool, ['wss://dead.relay', 'wss://alive.relay'], { limit: 1 }, { deadRelays: dead, timeoutMs: 10 })
    const calledRelays: string[] = subscribeSpy.mock.calls[0][0]
    expect(calledRelays).not.toContain('wss://dead.relay')
    expect(calledRelays).toContain('wss://alive.relay')
  })

  it('marks relay dead when onclose fires with error reason', async () => {
    const pool = makePool({
      events: [],
      eoseImmediately: true,
      closeReasons: ['websocket error'],
    })
    const dead = new Set<string>()
    await smartQuery(pool, ['wss://bad.relay'], { limit: 1 }, { deadRelays: dead, timeoutMs: 100 })
    expect(dead.has('wss://bad.relay')).toBe(true)
  })

  it('does NOT mark relay dead when onclose fires with "closed by us"', async () => {
    const pool = makePool({
      events: [],
      eoseImmediately: true,
      closeReasons: ['closed by us'],
    })
    const dead = new Set<string>()
    await smartQuery(pool, ['wss://good.relay'], { limit: 1 }, { deadRelays: dead, timeoutMs: 100 })
    expect(dead.has('wss://good.relay')).toBe(false)
  })

  it('returns empty array when all relays are dead', async () => {
    const subscribeSpy = vi.fn()
    const pool = { subscribeMany: subscribeSpy } as unknown as SimplePool
    const dead = new Set(['wss://relay.a', 'wss://relay.b'])
    const result = await smartQuery(pool, ['wss://relay.a', 'wss://relay.b'], { limit: 1 }, { deadRelays: dead })
    expect(result).toEqual([])
    expect(subscribeSpy).not.toHaveBeenCalled()
  })
})
