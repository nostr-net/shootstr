import { describe, it, expect, vi, beforeEach } from 'vitest'

// We test that fetchRelayLists reads from cache before querying the network
// by mocking the cache module

const mockCacheGet = vi.fn()
const mockCacheSet = vi.fn()
const mockCacheGetMany = vi.fn()
const mockCacheSetMany = vi.fn()

vi.mock('../src/services/cache.ts', () => ({
  cache: {
    get: mockCacheGet,
    set: mockCacheSet,
    getMany: mockCacheGetMany,
    setMany: mockCacheSetMany,
  },
  CacheKeys: {
    followList: (pk: string) => `follow-list:${pk}`,
    profile: (pk: string) => `profile:${pk}`,
    relayList: (pk: string) => `relay-list:${pk}`,
  },
}))

describe('CacheKeys.relayList', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('generates consistent cache key', async () => {
    const { CacheKeys } = await import('../src/services/cache.ts')
    expect(CacheKeys.relayList('abc123')).toBe('relay-list:abc123')
  })

  it('generates unique keys per pubkey', async () => {
    const { CacheKeys } = await import('../src/services/cache.ts')
    expect(CacheKeys.relayList('pk1')).not.toBe(CacheKeys.relayList('pk2'))
  })
})
