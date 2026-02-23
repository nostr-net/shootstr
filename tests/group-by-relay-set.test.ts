import { describe, it, expect } from 'vitest'
import { groupByRelaySet } from '../src/nostr.ts'

describe('groupByRelaySet', () => {
  it('groups pubkeys that share the same relay set', () => {
    const relayMap = new Map([
      ['pk1', ['wss://a', 'wss://b']],
      ['pk2', ['wss://a', 'wss://b']],
      ['pk3', ['wss://c']],
    ])
    const groups = groupByRelaySet(['pk1', 'pk2', 'pk3'], relayMap, ['wss://default'])
    expect(groups.get('wss://a,wss://b')).toEqual({ relays: ['wss://a', 'wss://b'], pubkeys: ['pk1', 'pk2'] })
    expect(groups.get('wss://c')).toEqual({ relays: ['wss://c'], pubkeys: ['pk3'] })
  })

  it('uses default relays for pubkeys not in the map', () => {
    const groups = groupByRelaySet(['unknown'], new Map(), ['wss://default'])
    expect(groups.get('wss://default')).toEqual({ relays: ['wss://default'], pubkeys: ['unknown'] })
  })

  it('returns empty map for empty pubkeys', () => {
    const groups = groupByRelaySet([], new Map(), ['wss://default'])
    expect(groups.size).toBe(0)
  })

  it('sorts relays before building key (same relays different order = same group)', () => {
    const relayMap = new Map([
      ['pk1', ['wss://b', 'wss://a']],
      ['pk2', ['wss://a', 'wss://b']],
    ])
    const groups = groupByRelaySet(['pk1', 'pk2'], relayMap, [])
    expect(groups.size).toBe(1)
  })
})
