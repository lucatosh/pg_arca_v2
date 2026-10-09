/**
 * Enterprise Multi-Cluster In-Memory & LocalStorage High-Speed Cache Store
 * 
 * Provides sub-millisecond retrieval of cluster metadata, metrics, PITR timelines,
 * and topology to avoid redundant network waterfalls and screen freezes when managing
 * dozens or hundreds of clusters.
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttlMs: number;
}

class ClusterCacheStore {
  private memoryCache = new Map<string, CacheEntry<any>>();
  private defaultTTL = 45_000; // 45 seconds default TTL for real-time responsiveness

  get<T>(key: string): T | null {
    // 1. Check in-memory Map first (0ms latency)
    const mem = this.memoryCache.get(key);
    if (mem) {
      if (Date.now() - mem.timestamp < mem.ttlMs) {
        return mem.data as T;
      }
      this.memoryCache.delete(key);
    }

    // 2. Fallback to localStorage for instant startup hydration
    try {
      const raw = localStorage.getItem(`pg_arca_cache_${key}`);
      if (raw) {
        const parsed: CacheEntry<T> = JSON.parse(raw);
        if (Date.now() - parsed.timestamp < parsed.ttlMs) {
          this.memoryCache.set(key, parsed);
          return parsed.data;
        } else {
          localStorage.removeItem(`pg_arca_cache_${key}`);
        }
      }
    } catch {
      // Ignore localStorage errors (e.g. quota or sandbox restrictions)
    }

    return null;
  }

  set<T>(key: string, data: T, ttlMs: number = this.defaultTTL): void {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttlMs
    };
    this.memoryCache.set(key, entry);

    try {
      localStorage.setItem(`pg_arca_cache_${key}`, JSON.stringify(entry));
    } catch {
      // Ignore quota errors
    }
  }

  invalidate(keyPrefix?: string): void {
    if (!keyPrefix) {
      this.memoryCache.clear();
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('pg_arca_cache_')) {
            keysToRemove.push(k);
          }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
      } catch {
        // Ignore
      }
      return;
    }

    // Invalidate prefix
    for (const key of this.memoryCache.keys()) {
      if (key.startsWith(keyPrefix)) {
        this.memoryCache.delete(key);
      }
    }

    try {
      const prefix = `pg_arca_cache_${keyPrefix}`;
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch {
      // Ignore
    }
  }

  /**
   * Stale-while-revalidate fetch helper
   */
  async fetchWithCache<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlMs: number = this.defaultTTL,
    onBackgroundUpdate?: (freshData: T) => void
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== null) {
      // Return cached immediately, then fetch fresh in background
      fetcher()
        .then(fresh => {
          this.set(key, fresh, ttlMs);
          if (onBackgroundUpdate) {
            onBackgroundUpdate(fresh);
          }
        })
        .catch(err => {
          console.warn(`[ClusterCache] Background refresh error for key ${key}:`, err);
        });
      return cached;
    }

    // No cache: fetch synchronously
    const fresh = await fetcher();
    this.set(key, fresh, ttlMs);
    return fresh;
  }
}

export const clusterCache = new ClusterCacheStore();
