/**
 * Cache Service using IndexedDB via localforage
 *
 * Provides client-side caching for API responses to improve performance
 * and reduce unnecessary API calls.
 */

import localforage from 'localforage';

/**
 * Cache entry structure with TTL support
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt: number;
}

/**
 * Cache configuration
 */
export interface CacheConfig {
  name?: string;
  storeName?: string;
  defaultTTL?: number; // Default TTL in milliseconds
}

/**
 * CacheService class
 *
 * Features:
 * - IndexedDB storage via localforage
 * - TTL (time-to-live) support
 * - Type-safe get/set operations
 * - Automatic expiration checking
 * - Batch operations
 */
export class CacheService {
  private store: LocalForage;
  private defaultTTL: number;

  constructor(config: CacheConfig = {}) {
    this.defaultTTL = config.defaultTTL || 3600000; // 1 hour default

    // Initialize localforage instance
    this.store = localforage.createInstance({
      name: config.name || 'nostr-game',
      storeName: config.storeName || 'api-cache',
      description: 'Client-side cache for Nostr game API responses',
    });
  }

  /**
   * Get a value from the cache
   *
   * @param key - Cache key
   * @returns Cached value or null if not found or expired
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const entry = await this.store.getItem<CacheEntry<T>>(key);

      if (!entry) {
        return null;
      }

      // Check if entry has expired
      const now = Date.now();
      if (now > entry.expiresAt) {
        // Entry expired, remove it
        await this.store.removeItem(key);
        return null;
      }

      return entry.data;
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  /**
   * Set a value in the cache
   *
   * @param key - Cache key
   * @param value - Value to cache
   * @param ttl - Time-to-live in milliseconds (optional, uses default if not provided)
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const now = Date.now();
    const expiresAt = now + (ttl || this.defaultTTL);

    const entry: CacheEntry<T> = {
      data: value,
      timestamp: now,
      expiresAt,
    };

    try {
      await this.store.setItem(key, entry);
    } catch (error) {
      console.error('Cache set error:', error);
      // Don't throw - cache failures shouldn't break the app
    }
  }

  /**
   * Check if a key exists and is not expired
   *
   * @param key - Cache key
   * @returns True if key exists and is not expired
   */
  async has(key: string): Promise<boolean> {
    try {
      const entry = await this.store.getItem<CacheEntry<unknown>>(key);

      if (!entry) {
        return false;
      }

      const now = Date.now();
      if (now > entry.expiresAt) {
        await this.store.removeItem(key);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Cache has error:', error);
      return false;
    }
  }

  /**
   * Remove a value from the cache
   *
   * @param key - Cache key
   */
  async remove(key: string): Promise<void> {
    try {
      await this.store.removeItem(key);
    } catch (error) {
      console.error('Cache remove error:', error);
    }
  }

  /**
   * Clear all cached values
   */
  async clear(): Promise<void> {
    try {
      await this.store.clear();
      console.log('Cache cleared');
    } catch (error) {
      console.error('Cache clear error:', error);
    }
  }

  /**
   * Get multiple values from cache
   *
   * @param keys - Array of cache keys
   * @returns Map of key to value (only includes non-null, non-expired values)
   */
  async getMany<T>(keys: string[]): Promise<Map<string, T>> {
    const results = new Map<string, T>();
    if (keys.length === 0) {
      return results;
    }

    const batchSize = 24;
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(async (key) => {
          const value = await this.get<T>(key);
          return { key, value };
        }),
      );

      for (const { key, value } of batchResults) {
        if (value !== null) {
          results.set(key, value);
        }
      }
    }

    return results;
  }

  /**
   * Set multiple values in cache
   *
   * @param entries - Map of key to value
   * @param ttl - Time-to-live in milliseconds (optional)
   */
  async setMany<T>(entries: Map<string, T>, ttl?: number): Promise<void> {
    await Promise.all(
      Array.from(entries.entries()).map(([key, value]) =>
        this.set(key, value, ttl)
      )
    );
  }

  /**
   * Get cache statistics
   *
   * @returns Object with cache statistics
   */
  async getStats(): Promise<{
    totalKeys: number;
    expiredKeys: number;
    validKeys: number;
  }> {
    try {
      const keys = await this.store.keys();
      const now = Date.now();
      let expiredKeys = 0;
      let validKeys = 0;

      await Promise.all(
        keys.map(async (key) => {
          const entry = await this.store.getItem<CacheEntry<unknown>>(key);
          if (entry) {
            if (now > entry.expiresAt) {
              expiredKeys++;
            } else {
              validKeys++;
            }
          }
        })
      );

      return {
        totalKeys: keys.length,
        expiredKeys,
        validKeys,
      };
    } catch (error) {
      console.error('Cache stats error:', error);
      return {
        totalKeys: 0,
        expiredKeys: 0,
        validKeys: 0,
      };
    }
  }

  /**
   * Clean up expired entries
   *
   * @returns Number of entries removed
   */
  async cleanupExpired(): Promise<number> {
    try {
      const keys = await this.store.keys();
      const now = Date.now();
      let removedCount = 0;

      await Promise.all(
        keys.map(async (key) => {
          const entry = await this.store.getItem<CacheEntry<unknown>>(key);
          if (entry && now > entry.expiresAt) {
            await this.store.removeItem(key);
            removedCount++;
          }
        })
      );

      if (removedCount > 0) {
        console.log(`Cleaned up ${removedCount} expired cache entries`);
      }

      return removedCount;
    } catch (error) {
      console.error('Cache cleanup error:', error);
      return 0;
    }
  }
}

/**
 * Cache key patterns for consistent naming
 */
export const CacheKeys = {
  // Follow list for a user
  followList: (pubkey: string) => `follow-list:${pubkey}`,

  // Profile metadata
  profile: (pubkey: string) => `profile:${pubkey}`,

  // Wave progress per level
  waveProgress: (pubkey: string, level: string) => `wave-progress:${pubkey}:${level}`,
};

// Export a default cache instance
export const cache = new CacheService({
  name: 'nostr-game',
  storeName: 'api-cache',
  defaultTTL: 3600000, // 1 hour
});
