import { SimplePool, nip19, Event, Filter } from 'nostr-tools';
import { cache, CacheKeys } from './services/cache';

export interface NostrMetadata {
  name?: string;
  display_name?: string;
  picture?: string;
  nip05?: string;
  about?: string;
  lud16?: string;
  lud06?: string;
  deleted?: boolean | string;
}

export interface CachedFollowerRecord {
  pubkey: string;
  metadata?: NostrMetadata;
  baseHealth: number;
  lastPostTime?: number;
  deleted: boolean;
}

export interface ProfileCacheEntry {
  metadata?: NostrMetadata;
  lastPostTime: number;
  baseHealth: number;
  deleted: boolean;
  lastPostCheckedAt?: number;
}

interface NostrUnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  pubkey: string;
}

interface NostrSignedEvent extends NostrUnsignedEvent {
  id: string;
  sig: string;
}

interface RelayList {
  writeRelays: string[];
  readRelays: string[];
  bothRelays: string[];
}

/**
 * Run async workers with bounded concurrency.
 * Items are chunked and processed concurrently up to `concurrency` at a time.
 */
async function runConcurrent<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(worker));
    results.push(...batchResults);
  }
  return results;
}

// Filter shape used in smartQuery (subset of nostr-tools Filter)
type NostrFilter = {
  kinds?: number[];
  authors?: string[];
  limit?: number;
  since?: number;
  until?: number;
};

/**
 * Drop-in replacement for pool.querySync that:
 * - streams events via subscribeMany (no EOSE wait on individual relays)
 * - resolves when all relays EOSE or timeoutMs elapses
 * - marks relays that close with an error in deadRelays (mutates the set)
 * - skips any relay already in deadRelays
 */
export async function smartQuery(
  pool: SimplePool,
  relays: string[],
  filter: NostrFilter,
  opts: { timeoutMs?: number; deadRelays?: Set<string> } = {},
): Promise<Event[]> {
  const { timeoutMs = 15000, deadRelays } = opts;
  const activeRelays = deadRelays
    ? relays.filter(r => !deadRelays.has(r))
    : [...relays];

  if (activeRelays.length === 0) return [];

  return new Promise<Event[]>(resolve => {
    const events: Event[] = [];
    let done = false;
    let closer: { close: () => void } | undefined;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      closer?.close();
      resolve(events);
    };

    const timer = setTimeout(finish, timeoutMs);

    closer = pool.subscribeMany(activeRelays, filter as Filter, {
      onevent: (e: Event) => { events.push(e); },
      oneose: finish,
      onclose: (reasons: string[]) => {
        // reasons[i] corresponds to activeRelays[i] (deduplicated, same order)
        reasons.forEach((reason, i) => {
          if (reason && reason !== 'closed by us' && activeRelays[i]) {
            deadRelays?.add(activeRelays[i]);
          }
        });
      },
    });
  });
}

export function groupByRelaySet(
  pubkeys: string[],
  outboxCache: Map<string, string[]>,
  defaultRelays: string[],
): Map<string, { relays: string[]; pubkeys: string[] }> {
  const groups = new Map<string, { relays: string[]; pubkeys: string[] }>();
  for (const pk of pubkeys) {
    const relays = outboxCache.get(pk) ?? defaultRelays;
    const key = [...relays].sort().join(',');
    const existing = groups.get(key);
    if (existing) {
      existing.pubkeys.push(pk);
    } else {
      groups.set(key, { relays: [...relays].sort(), pubkeys: [pk] });
    }
  }
  return groups;
}

// NIP-07 window.nostr interface
declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>;
      signEvent(event: NostrUnsignedEvent): Promise<NostrSignedEvent>;
    };
  }
}

// Default relays for initial queries (follow list, metadata)
const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://relay.nostr.net',
  'wss://nos.lol',
  'wss://relay.contextvm.org',
  'wss://nostr.wine',
  'wss://purplepag.es',
  'wss://relay.nos.social',
  'wss://relay.snort.social',
  'wss://nostr-pub.wellorder.net',
  'wss://offchain.pub',
  'wss://relay.mostr.pub',
  'wss://nostr.mom',
  'wss://nostr.oxtr.dev',
  'wss://relay.noswhere.com',
  'wss://nostr.bitcoiner.social',
  'wss://nostr21.com',
  'wss://relay.getalby.com/v1',
  'wss://relay.wellorder.net',
];

// Event kinds that indicate activity
const ACTIVITY_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nos.social',
  'wss://relay.nostr.net',
  'wss://purplepag.es',
];
const BALANCED_ACTIVITY_KINDS = [0, 1, 2, 3, 6, 7, 9735, 16, 30023];
const RELAY_AWARE_ACTIVITY_KINDS = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 40, 41, 42, 43, 44,
  9734, 9735, 30000, 30001, 30008, 30009, 30017, 30018, 30023, 30024,
  31890, 31922, 31923, 31924, 31925, 31989, 31990, 34550,
];
const AGGRESSIVE_ACTIVITY_KINDS = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 40, 41, 42, 43, 44,
  1063, 1311, 1984, 1985, 9734, 9735, 10000, 10001, 10002, 30000,
  30001, 30008, 30009, 30017, 30018, 30023, 30024, 31890, 31922,
  31923, 31924, 31925, 31989, 31990, 34550,
];
const ACTIVITY_LOOKBACK_DAYS = 365;
const LAST_POST_REFRESH_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_OUTBOX_RETRY_FOLLOWERS = 800;
const MAX_SYNC_STALE_REFRESH_FOLLOWERS = 3000;
const MAX_BACKGROUND_STALE_REFRESH_FOLLOWERS = 1000;
const MAX_AGGRESSIVE_RETRY_FOLLOWERS = 900;
const MAX_FALLBACK_RETRY_FOLLOWERS = 2500;
const MAX_BROAD_RETRY_BATCH_SIZE = 30;
const PROGRESSIVE_FETCH_BATCH_SIZE = 80;
const UNKNOWN_LAST_POST_TIME = -1;

export class NostrService {
  private pool: SimplePool;
  // NIP-65 relay lists per pubkey (write relays where they publish)
  private relayLists = new Map<string, RelayList>();
  private outboxRelayCache = new Map<string, string[]>();
  private deadRelays = new Set<string>();

  constructor() {
    this.pool = new SimplePool();
  }

  /**
   * Decode npub to hex pubkey
   */
  decodeNpub(npubOrHex: string): string {
    if (npubOrHex.startsWith('npub')) {
      const decoded = nip19.decode(npubOrHex);
      if (decoded.type === 'npub') {
        return decoded.data;
      }
    }
    return npubOrHex;
  }

  /**
   * Fetch follow list (kind 3) for a given pubkey
   */
  async fetchFollowList(pubkey: string): Promise<string[]> {
    console.log('Fetching follow list for', pubkey);

    const events = await this.pool.querySync(ACTIVITY_RELAYS, {
      kinds: [3],
      authors: [pubkey],
      limit: 1
    });

    if (events.length === 0) {
      console.warn('No follow list found');
      return [];
    }

    // Get the most recent follow list
    let followEvent = events[0];
    for (let i = 1; i < events.length; i++) {
      if (events[i].created_at > followEvent.created_at) {
        followEvent = events[i];
      }
    }

    // Extract pubkeys from tags
    const followedPubkeys = followEvent.tags
      .filter(tag => tag[0] === 'p')
      .map(tag => tag[1]);

    console.log(`Found ${followedPubkeys.length} followers`);
    return followedPubkeys;
  }

  /**
   * Fetch metadata (kind 0) for multiple pubkeys
   */
  async fetchMetadata(pubkeys: string[]): Promise<Map<string, NostrMetadata>> {
    console.log(`Fetching metadata for ${pubkeys.length} pubkeys`);

    const metadataMap = new Map<string, NostrMetadata>();
    const batchSize = 50;
    const batches: string[][] = [];
    for (let i = 0; i < pubkeys.length; i += batchSize) {
      batches.push(pubkeys.slice(i, i + batchSize));
    }

    await runConcurrent(batches, async (batch) => {
      const events = await this.pool.querySync(ACTIVITY_RELAYS, {
        kinds: [0],
        authors: batch
      });

      const latestMetadata = new Map<string, Event>();
      for (const event of events) {
        const existing = latestMetadata.get(event.pubkey);
        if (!existing || event.created_at > existing.created_at) {
          latestMetadata.set(event.pubkey, event);
        }
      }

      for (const [pubkey, event] of latestMetadata) {
        try {
          const parsed = JSON.parse(event.content);
          if (typeof parsed === 'object' && parsed !== null) {
            metadataMap.set(pubkey, parsed as NostrMetadata);
          }
        } catch (e) {
          console.warn('Failed to parse metadata for', pubkey);
        }
      }
    }, 5);

    console.log(`Got metadata for ${metadataMap.size} pubkeys`);
    return metadataMap;
  }

  /**
   * Fetch NIP-65 relay lists (kind 10002) for multiple pubkeys.
   * Checks persistent cache first; only fetches from relays for cache misses.
   * Populates this.relayLists so fetchLastPostTimes can query per-user relays.
   */
  async fetchRelayLists(pubkeys: string[]): Promise<void> {
    // 1. Check persistent cache first
    const cacheKeys = pubkeys.map(pk => CacheKeys.relayList(pk));
    const cached = await cache.getMany<RelayList>(cacheKeys);

    // Populate in-memory maps from cache hits
    for (const [key, rl] of cached) {
      const pk = key.replace('relay-list:', '');
      this.relayLists.set(pk, rl);
      const outbox = Array.from(
        new Set([...rl.writeRelays, ...rl.bothRelays, ...rl.readRelays]),
      ).sort();
      this.outboxRelayCache.set(pk, outbox);
    }

    // 2. Fetch only cache misses
    const missingPubkeys = pubkeys.filter(pk => !this.relayLists.has(pk));
    if (missingPubkeys.length === 0) {
      console.log(`Relay lists: ${cached.size}/${pubkeys.length} from cache`);
      return;
    }

    console.log(`Fetching NIP-65 relay lists for ${missingPubkeys.length} pubkeys (${cached.size} from cache)`);

    const batchSize = 50;
    const batches: string[][] = [];
    for (let i = 0; i < missingPubkeys.length; i += batchSize) {
      batches.push(missingPubkeys.slice(i, i + batchSize));
    }

    const newEntries = new Map<string, RelayList>();

    await runConcurrent(batches, async (batch) => {
      const events = await smartQuery(
        this.pool,
        ACTIVITY_RELAYS,
        { kinds: [10002], authors: batch },
        { timeoutMs: 12000, deadRelays: this.deadRelays },
      );

      const latestByPubkey = new Map<string, Event>();
      for (const event of events) {
        const existing = latestByPubkey.get(event.pubkey);
        if (!existing || event.created_at > existing.created_at) {
          latestByPubkey.set(event.pubkey, event);
        }
      }

      for (const [pk, event] of latestByPubkey) {
        const rl: RelayList = { writeRelays: [], readRelays: [], bothRelays: [] };
        for (const tag of event.tags) {
          if (tag[0] === 'r' && tag[1]) {
            const url = tag[1];
            const perm = tag[2];
            if (perm === 'read') rl.readRelays.push(url);
            else if (perm === 'write') rl.writeRelays.push(url);
            else rl.bothRelays.push(url);
          }
        }
        this.relayLists.set(pk, rl);
        const outbox = Array.from(new Set([...rl.writeRelays, ...rl.bothRelays, ...rl.readRelays])).sort();
        this.outboxRelayCache.set(pk, outbox);
        newEntries.set(CacheKeys.relayList(pk), rl);
      }
    }, 5);

    // 3. Persist new relay lists to cache (24h TTL)
    if (newEntries.size > 0) {
      await cache.setMany(newEntries, 86400000);
    }

    console.log(`Got relay lists for ${this.relayLists.size}/${pubkeys.length} pubkeys`);
  }

  /**
   * Get the relays a pubkey writes to (their outbox).
   * Falls back to ACTIVITY_RELAYS if no NIP-65 list available.
   */
  private getOutboxRelays(pubkey: string): string[] {
    const cachedOutbox = this.outboxRelayCache.get(pubkey);
    if (cachedOutbox) {
      return cachedOutbox;
    }

    const rl = this.relayLists.get(pubkey);
    if (rl) {
      const outbox = Array.from(
        new Set([...rl.writeRelays, ...rl.bothRelays, ...rl.readRelays]),
      ).sort();
      if (outbox.length > 0) {
        this.outboxRelayCache.set(pubkey, outbox);
        return outbox;
      }
    }
    return ACTIVITY_RELAYS;
  }

  private mergeLastPostEvents(
    lastPostMap: Map<string, number>,
    events: Iterable<Event>,
  ): void {
    for (const event of events) {
      const existing = lastPostMap.get(event.pubkey);
      if (!existing || event.created_at > existing) {
        lastPostMap.set(event.pubkey, event.created_at);
      }
    }
  }

  private async queryLastPostEvents(
    relays: string[],
    pubkeys: string[],
    kinds: number[] | undefined,
    since: number | undefined = undefined,
    perAuthorLimit = 20,
    timeoutMs = 15000,
    context = 'query',
  ): Promise<Event[]> {
    if (pubkeys.length === 0) return [];

    const filter: NostrFilter = {
      authors: pubkeys,
      limit: Math.max(1, pubkeys.length * perAuthorLimit),
    };
    if (kinds && kinds.length > 0) filter.kinds = kinds;
    if (since !== undefined) filter.since = since;

    try {
      return await smartQuery(this.pool, relays, filter, {
        timeoutMs,
        deadRelays: this.deadRelays,
      });
    } catch (error) {
      console.warn(`⚠️ ${context} failed:`, error);
      return [];
    }
  }

  /**
   * Fetch the most recent event timestamp for each pubkey.
   *
   * Two-phase approach:
   * 1. Bulk query against default relays (fast, covers most users)
   * 2. For pubkeys with no results, retry using their NIP-65 write relays
   *    (catches users who post to relays outside our default list)
   * 3. Aggressive per-user retry with broad kinds for stubborn misses.
   */
  async fetchLastPostTimes(pubkeys: string[]): Promise<Map<string, number>> {
    const uniquePubkeys = Array.from(new Set(pubkeys));
    const lastPostMap = new Map<string, number>();
    if (uniquePubkeys.length === 0) {
      return lastPostMap;
    }

    const now = Math.floor(Date.now() / 1000);
    const baselineSince = now - ACTIVITY_LOOKBACK_DAYS * 24 * 60 * 60;

    // Phase 1: bulk query against default relays
    const batchSize = 50;
    const batches: string[][] = [];
    for (let i = 0; i < uniquePubkeys.length; i += batchSize) {
      batches.push(uniquePubkeys.slice(i, i + batchSize));
    }

    await runConcurrent(batches, async (batch) => {
      const events = await this.queryLastPostEvents(
        ACTIVITY_RELAYS,
        batch,
        BALANCED_ACTIVITY_KINDS,
        baselineSince,
        12,
        15000,
        'Balanced activity scan',
      );
      this.mergeLastPostEvents(lastPostMap, events);
    }, 5);

    // Phase 2: retry misses using per-user outbox relays
    const missingPubkeys = uniquePubkeys.filter(pk => !lastPostMap.has(pk));
    if (missingPubkeys.length > 0) {
      const outboxRetryPubkeys = missingPubkeys.slice(0, MAX_OUTBOX_RETRY_FOLLOWERS);
      const shouldRetryWithOutbox = outboxRetryPubkeys.length > 0;
      console.log(
        `No activity found for ${missingPubkeys.length}/${uniquePubkeys.length} users in baseline scan; ` +
        `${shouldRetryWithOutbox ? `retrying relay lists for ${outboxRetryPubkeys.length} of them` : 'no outbox retries scheduled yet'}`,
      );

      if (shouldRetryWithOutbox) {
        // Get relay lists for misses so they can be retried against their configured relays.
        await this.fetchRelayLists(outboxRetryPubkeys);

        // Only retry those that actually have custom relay lists
        const retryPubkeys = outboxRetryPubkeys.filter(pk => this.relayLists.has(pk));
        if (retryPubkeys.length > 0) {
          console.log(`Retrying ${retryPubkeys.length}/${missingPubkeys.length} pubkeys via their outbox relays`);

          // Group by relay set to batch queries efficiently
          const relayGroups = new Map<string, string[]>();
          for (const pk of retryPubkeys) {
            const relays = this.getOutboxRelays(pk);
            const key = relays.join(',');
            const group = relayGroups.get(key) || [];
            group.push(pk);
            relayGroups.set(key, group);
          }

          const groupEntries = Array.from(relayGroups.entries());
          await runConcurrent(groupEntries, async ([relayKey, pks]) => {
            const relays = relayKey.split(',');
            // Query in sub-batches within each relay group
            for (let i = 0; i < pks.length; i += 10) {
              const subBatch = pks.slice(i, i + 10);
              const events = await this.queryLastPostEvents(
                relays,
                subBatch,
                RELAY_AWARE_ACTIVITY_KINDS,
                baselineSince,
                8,
                12000,
                `Relay-aware retry batch (${subBatch.length})`,
              );
              this.mergeLastPostEvents(lastPostMap, events);
            }
          }, 5);
        }
      }
    }

    const stillMissing = uniquePubkeys.filter(pk => !lastPostMap.has(pk));
    const shouldDoAggressiveRetry = uniquePubkeys.length <= MAX_AGGRESSIVE_RETRY_FOLLOWERS;
    if (stillMissing.length > 0 && shouldDoAggressiveRetry) {
      await this.aggressiveLastPostRetry(stillMissing, lastPostMap);
    }

    const stillMissingAfterAggressive = uniquePubkeys.filter(pk => !lastPostMap.has(pk));
    const broadRetryTargets = stillMissingAfterAggressive.slice(0, MAX_FALLBACK_RETRY_FOLLOWERS);
    if (broadRetryTargets.length > 0) {
      if (stillMissingAfterAggressive.length > broadRetryTargets.length) {
        console.log(
          `⚠️ Broad fallback limited to ${broadRetryTargets.length} users ` +
          `out of ${stillMissingAfterAggressive.length} unresolved users`,
        );
      }
      await this.broadFallbackLastPostRetry(broadRetryTargets, lastPostMap);
    }

    const stillMissingAfterBroad = uniquePubkeys.filter(pk => !lastPostMap.has(pk));
    if (
      stillMissingAfterBroad.length > 0 &&
      stillMissingAfterBroad.length <= MAX_AGGRESSIVE_RETRY_FOLLOWERS
    ) {
      await this.fallbackUnresolvedLastPostRetry(stillMissingAfterBroad, lastPostMap);
    }

    console.log(
      `Got last post times for ${lastPostMap.size}/${uniquePubkeys.length} pubkeys`,
    );
    return lastPostMap;
  }

  /**
   * Aggressive recovery pass for profiles still reporting no activity.
   * Uses a very broad kind set and no timeframe limit for each account.
   */
  private async aggressiveLastPostRetry(
    pubkeys: string[],
    lastPostMap: Map<string, number>,
  ): Promise<void> {
    console.log(
      `🔍 AGGRESSIVE LAST POST RETRY: checking ${pubkeys.length} unresolved pubkeys`,
    );

    // Group by relay set and batch (same approach as phase 2)
    const groups = groupByRelaySet(pubkeys, this.outboxRelayCache, ACTIVITY_RELAYS);
    const groupEntries = Array.from(groups.values());

    await runConcurrent(groupEntries, async ({ relays, pubkeys: pks }) => {
      for (let i = 0; i < pks.length; i += 10) {
        const subBatch = pks.slice(i, i + 10);
        const events = await this.queryLastPostEvents(
          relays, subBatch, AGGRESSIVE_ACTIVITY_KINDS, undefined, 500, 12000,
          `Aggressive retry batch (${subBatch.length})`,
        );
        this.mergeLastPostEvents(lastPostMap, events);
      }
    }, 4);
  }

  private async broadFallbackLastPostRetry(
    pubkeys: string[],
    lastPostMap: Map<string, number>,
  ): Promise<void> {
    const dedupedPubkeys = Array.from(new Set(pubkeys));
    if (dedupedPubkeys.length === 0) {
      return;
    }

    const batchSize = MAX_BROAD_RETRY_BATCH_SIZE;
    const batches: string[][] = [];
    for (let i = 0; i < dedupedPubkeys.length; i += batchSize) {
      batches.push(dedupedPubkeys.slice(i, i + batchSize));
    }

    console.log(
      `🧭 BROAD LAST POST RETRY: scanning ${dedupedPubkeys.length}/${pubkeys.length} unresolved users on reliable relays`,
    );

    await runConcurrent(
      batches,
      async (batch) => {
        const events = await this.queryLastPostEvents(
          ACTIVITY_RELAYS,
          batch,
          undefined,
          undefined,
          12,
          12000,
          `Broad reliable retry batch (${batch.length})`,
        );
        this.mergeLastPostEvents(lastPostMap, events);
      },
      4,
    );
  }

  /**
   * Final recovery pass for unresolved users:
   * query relays without a kind filter so uncommon activity kinds are still counted.
   */
  private async fallbackUnresolvedLastPostRetry(
    pubkeys: string[],
    lastPostMap: Map<string, number>,
  ): Promise<void> {
    if (pubkeys.length === 0) {
      return;
    }

    console.log(
      `🛠️ FALLBACK LAST POST RETRY: checking ${pubkeys.length} unresolved pubkeys`,
    );

    await runConcurrent(
      pubkeys,
      async (pubkey) => {
        const defaultRelayEvents = await this.queryLastPostEvents(
          RELAYS,
          [pubkey],
          undefined,
          undefined,
          1000,
          20000,
          `Fallback default relays for ${pubkey.substring(0, 8)}...`,
        );
        this.mergeLastPostEvents(lastPostMap, defaultRelayEvents);

        if (lastPostMap.has(pubkey)) {
          return;
        }

        const outboxRelays = this.getOutboxRelays(pubkey);
        if (outboxRelays.length === 0 || (!this.relayLists.has(pubkey) && !this.outboxRelayCache.has(pubkey))) {
          return;
        }

        const outboxEvents = await this.queryLastPostEvents(
          outboxRelays,
          [pubkey],
          undefined,
          undefined,
          1000,
          20000,
          `Fallback outbox relays for ${pubkey.substring(0, 8)}...`,
        );
        this.mergeLastPostEvents(lastPostMap, outboxEvents);
      },
      3,
    );
  }

  /**
   * Derive baseHealth from real profile signals (0-100).
   * Factors: has name, has picture, has nip05, recency of last post.
   */
  private deriveBaseHealth(metadata: NostrMetadata | undefined, lastPostTime: number | undefined): number {
    let score = 0;

    // Profile completeness (up to 40 points)
    if (metadata?.name) score += 10;
    if (metadata?.picture) score += 10;
    if (metadata?.nip05) score += 10;
    if (metadata?.about) score += 5;
    if (metadata?.lud16 || metadata?.lud06) score += 5;

    // Activity recency (up to 60 points)
    if (lastPostTime) {
      const now = Math.floor(Date.now() / 1000);
      const daysSincePost = (now - lastPostTime) / (24 * 60 * 60);

      if (daysSincePost < 1) score += 60;
      else if (daysSincePost < 7) score += 50;
      else if (daysSincePost < 30) score += 40;
      else if (daysSincePost < 90) score += 25;
      else if (daysSincePost < 180) score += 10;
      // > 180 days: 0 activity points
    }

    return Math.max(1, Math.min(100, score));
  }

  /**
   * Fetch game data with per-profile caching.
   * Fetches cached + uncached profiles from relays. Calls onProgress for UI feedback.
   * If provided, onFollowerData emits progressively as follower rows become available.
   * If `waitForStaleRefresh` is true, waits for stale last-post refresh before returning
   * so initial wave assignment reflects the freshest known data.
   */
  async fetchGameDataWithCache(
    pubkey: string,
    onProgress?: (loaded: number, total: number) => void,
    waitForStaleRefresh = false,
    onFollowerData?: (
      follows: string[],
      followers: CachedFollowerRecord[],
      loaded: number,
      total: number
    ) => void,
  ): Promise<{ follows: string[], followers: CachedFollowerRecord[] }> {
    // 1. Fetch follow list (check cache first, 1hr TTL)
    const followListKey = CacheKeys.followList(pubkey);
    let follows = await cache.get<string[]>(followListKey);

    if (!follows) {
      follows = await this.fetchFollowList(pubkey);
      if (follows.length > 0) {
        await cache.set(followListKey, follows, 3600000); // 1hr
      }
    }

    if (follows.length === 0) {
      return { follows: [], followers: [] };
    }

    const total = follows.length;

    // 2. Bulk-check cache for existing profiles
    const profileKeys = follows.map(pk => CacheKeys.profile(pk));
    const cachedProfiles = await cache.getMany<ProfileCacheEntry>(profileKeys);

    // Map cache keys back to pubkeys
    const cachedByPubkey = new Map<string, ProfileCacheEntry>();
    for (const [key, entry] of cachedProfiles) {
      // Extract pubkey from cache key "profile:<pubkey>"
      const pk = key.replace('profile:', '');
      cachedByPubkey.set(pk, entry);
    }

    const buildFollowerRecords = (): CachedFollowerRecord[] =>
      follows.map<CachedFollowerRecord>((fpk) => {
        const entry = cachedByPubkey.get(fpk);
        return {
          pubkey: fpk,
          metadata: entry?.metadata,
          baseHealth: entry?.baseHealth ?? 1,
          lastPostTime: entry?.lastPostTime !== undefined && entry.lastPostTime > 0
            ? entry.lastPostTime
            : undefined,
          deleted: entry?.deleted ?? false
        };
      });

    const emitFollowerUpdate = (loaded: number): CachedFollowerRecord[] => {
      const clampedLoaded = Math.min(loaded, total);
      const records = buildFollowerRecords();
      onProgress?.(clampedLoaded, total);
      onFollowerData?.(follows, records, clampedLoaded, total);
      return records;
    };

    const uncachedPubkeys = follows.filter(pk => !cachedByPubkey.has(pk));
    let loaded = cachedByPubkey.size;
    emitFollowerUpdate(loaded);

    console.log(`Cache hit: ${cachedByPubkey.size}/${total}, fetching ${uncachedPubkeys.length} from relays`);

    // 3. Fetch uncached profiles from relays with concurrent batches
    if (uncachedPubkeys.length > 0) {
      const batchSize = PROGRESSIVE_FETCH_BATCH_SIZE;

      for (let i = 0; i < uncachedPubkeys.length; i += batchSize) {
        const batch = uncachedPubkeys.slice(i, i + batchSize);

        const [metadataMap, lastPostMap] = await Promise.all([
          this.fetchMetadata(batch),
          this.fetchLastPostTimes(batch)
        ]);

        // Persist new profiles to cache (24hr TTL)
        const newEntries = new Map<string, ProfileCacheEntry>();
        for (const pk of batch) {
          const metadata = metadataMap.get(pk);
          const lastPostTime = lastPostMap.get(pk) ?? UNKNOWN_LAST_POST_TIME;
          const baseHealth = this.deriveBaseHealth(metadata, lastPostTime > 0 ? lastPostTime : undefined);
          const deleted = metadata?.deleted === true || metadata?.deleted === 'true';
          const entry: ProfileCacheEntry = {
            metadata,
            lastPostTime,
            baseHealth,
            deleted,
            lastPostCheckedAt: Date.now()
          };
          cachedByPubkey.set(pk, entry);
          newEntries.set(CacheKeys.profile(pk), entry);
        }

        await cache.setMany(newEntries, 86400000); // 24hr
        loaded = Math.min(total, loaded + batch.length);
        emitFollowerUpdate(loaded);
      }
    }

    const now = Date.now();
    const staleActivityPubkeys = follows.filter(pk => {
      const entry = cachedByPubkey.get(pk);
      if (!entry) return true;
      const lastChecked = entry.lastPostCheckedAt ?? 0;
      return now - lastChecked > LAST_POST_REFRESH_TTL_MS;
    });

    if (staleActivityPubkeys.length > 0) {
      const staleRefreshTargets = staleActivityPubkeys.filter(pk => {
        const entry = cachedByPubkey.get(pk);
        return !entry || typeof entry.lastPostTime !== 'number' || entry.lastPostTime <= 0;
      });
      const staleCount = staleRefreshTargets.length;
      if (staleCount > 0) {
        const shouldRefreshInBackground = staleCount <= MAX_BACKGROUND_STALE_REFRESH_FOLLOWERS;
        const shouldWaitForRefresh = waitForStaleRefresh &&
          total <= MAX_SYNC_STALE_REFRESH_FOLLOWERS &&
          staleCount <= MAX_SYNC_STALE_REFRESH_FOLLOWERS;

        console.log(
          `Refreshing last post timestamps for ${staleCount}/${total} followers ` +
          `${shouldWaitForRefresh ? 'synchronously' : shouldRefreshInBackground ? 'in background' : 'not this run'}`,
        );

        if (shouldWaitForRefresh) {
          try {
            await this.refreshCachedFollowerActivity(staleRefreshTargets, cachedByPubkey, Date.now());
            emitFollowerUpdate(loaded);
          } catch (error) {
            console.warn('Synchronous activity refresh failed:', error);
          }
        } else if (shouldRefreshInBackground) {
          this.refreshCachedFollowerActivity(staleRefreshTargets, cachedByPubkey, now)
            .then(() => {
              emitFollowerUpdate(loaded);
            })
            .catch(error => {
              console.warn('Background activity refresh failed:', error);
            });
        } else if (staleActivityPubkeys.length > staleCount) {
          console.log(
            `Skipping stale refresh for ${staleActivityPubkeys.length - staleCount} entries that already have known last-post times`,
          );
        }
      }
    }

    // 4. Construct follower objects from cached data
    const followers = emitFollowerUpdate(loaded);
    return { follows, followers };
  }

  private async refreshCachedFollowerActivity(
    stalePubkeys: string[],
    cachedByPubkey: Map<string, ProfileCacheEntry>,
    now: number
  ): Promise<void> {
    const dedupedPubkeys = Array.from(new Set(stalePubkeys));
    const lastPostMap = await this.fetchLastPostTimes(dedupedPubkeys);

    const refreshedEntries = new Map<string, ProfileCacheEntry>();
    for (const pk of dedupedPubkeys) {
      const existing = cachedByPubkey.get(pk);
      if (!existing) {
        continue;
      }

      const metadata = existing.metadata;
      const incomingLastPost = lastPostMap.get(pk);
      const lastPostTime = incomingLastPost !== undefined ? incomingLastPost : existing.lastPostTime;
      const deleted = metadata?.deleted === true || metadata?.deleted === 'true';
      const entry: ProfileCacheEntry = {
        metadata,
        lastPostTime,
        baseHealth: this.deriveBaseHealth(metadata, lastPostTime || undefined),
        deleted,
        lastPostCheckedAt: now
      };

      cachedByPubkey.set(pk, entry);
      refreshedEntries.set(CacheKeys.profile(pk), entry);
    }

    if (refreshedEntries.size > 0) {
      await cache.setMany(refreshedEntries, 86400000);
    }
  }

  /**
   * Unfollow a pubkey by publishing a new kind 3 event
   */
  async unfollowPubkey(
    userPubkey: string,
    unfollowPubkey: string,
    currentFollows: string[],
    useExtension: boolean
  ): Promise<void> {
    console.log(`Unfollowing ${unfollowPubkey}`);

    if (!useExtension) {
      console.log('Read-only mode - unfollow not published to relays');
      return;
    }

    // Check if window.nostr is available (NIP-07)
    if (!window.nostr) {
      console.error('No Nostr extension found');
      throw new Error('No Nostr extension found');
    }

    try {
      // Create updated follow list (remove unfollowed pubkey)
      const updatedFollows = currentFollows.filter(pk => pk !== unfollowPubkey);

      // Create new kind 3 event
      const unsignedEvent = {
        kind: 3,
        created_at: Math.floor(Date.now() / 1000),
        tags: updatedFollows.map(pk => ['p', pk]),
        content: '',
        pubkey: userPubkey
      };

      console.log('Signing unfollow event with extension...');

      // Sign the event using NIP-07
      const signedEvent = await window.nostr.signEvent(unsignedEvent);

      console.log('Publishing unfollow event to relays...');

      // Publish to relays
      await this.pool.publish(RELAYS, signedEvent);

      console.log(`Successfully unfollowed ${unfollowPubkey} and published to relays`);
    } catch (error) {
      console.error('Failed to unfollow:', error);
      throw error;
    }
  }

  /**
   * Batch unfollow multiple pubkeys by publishing a new kind 3 event
   */
  async batchUnfollowPubkeys(
    userPubkey: string,
    unfollowPubkeys: string[],
    currentFollows: string[],
    useExtension: boolean
  ): Promise<void> {
    console.log(`Batch unfollowing ${unfollowPubkeys.length} pubkeys`);

    if (!useExtension) {
      console.log('Read-only mode - batch unfollow not published to relays');
      return;
    }

    // Check if window.nostr is available (NIP-07)
    if (!window.nostr) {
      console.error('No Nostr extension found');
      throw new Error('No Nostr extension found');
    }

    try {
      // Create updated follow list (remove all unfollowed pubkeys)
      const unfollowSet = new Set(unfollowPubkeys);
      const updatedFollows = currentFollows.filter(pk => !unfollowSet.has(pk));

      // Create new kind 3 event
      const unsignedEvent = {
        kind: 3,
        created_at: Math.floor(Date.now() / 1000),
        tags: updatedFollows.map(pk => ['p', pk]),
        content: '',
        pubkey: userPubkey
      };

      console.log(`Signing batch unfollow event with extension (removing ${unfollowPubkeys.length} followers)...`);

      // Sign the event using NIP-07
      const signedEvent = await window.nostr.signEvent(unsignedEvent);

      console.log('Publishing batch unfollow event to relays...');

      // Publish to relays
      await this.pool.publish(RELAYS, signedEvent);

      console.log(`Successfully batch unfollowed ${unfollowPubkeys.length} pubkeys and published to relays`);
    } catch (error) {
      console.error('Failed to batch unfollow:', error);
      throw error;
    }
  }

  /**
   * Fetch and load profile picture as an image
   */
  async loadProfilePicture(url: string): Promise<HTMLImageElement | HTMLCanvasElement> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (img: HTMLImageElement | HTMLCanvasElement) => {
        if (!settled) { settled = true; resolve(img); }
      };

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => settle(img);
      // CORS failure → use colored fallback (non-CORS images can't be drawn to canvas)
      img.onerror = () => settle(this.createFallbackCanvas());

      setTimeout(() => settle(this.createFallbackCanvas()), 5000);

      img.src = url;
    });
  }

  /**
   * Create a fallback avatar canvas (no async Image conversion needed)
   */
  private createFallbackCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    const hue = Math.random() * 360;
    ctx.fillStyle = `hsl(${hue}, 70%, 50%)`;
    ctx.fillRect(0, 0, 64, 64);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 32px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', 32, 32);

    return canvas;
  }

  /**
   * Create circular avatar from image or canvas
   */
  createCircularAvatar(img: HTMLImageElement | HTMLCanvasElement, size: number = 64): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // Create circular clipping path
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    // Draw image
    ctx.drawImage(img, 0, 0, size, size);
    ctx.restore();

    // Add border
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.stroke();

    return canvas;
  }


  cleanup() {
    this.pool.close(RELAYS);
  }
}
