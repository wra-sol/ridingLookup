import { Env, GeoJSONFeatureCollection, SpatialIndex, CacheWarmingState, QueryParams } from './types';
import { geocodeIfNeeded } from './geocoding';
import { TIME_CONSTANTS } from './config';

// Cache configuration
export const CACHE_CONFIG = {
  MAX_SIZE: 10, // Maximum number of datasets to cache
  MAX_AGE: TIME_CONSTANTS.TWENTY_FOUR_HOURS_MS,
};

// Cache warming configuration
export const CACHE_WARMING_CONFIG = {
  ENABLED: true,
  WARMING_INTERVAL: TIME_CONSTANTS.SIX_HOURS_MS,
  BATCH_SIZE: 5,
  POPULAR_LOCATIONS: [
    { name: "Toronto", lat: 43.6532, lon: -79.3832 },
    { name: "Vancouver", lat: 49.2827, lon: -123.1207 },
    { name: "Montreal", lat: 45.5017, lon: -73.5673 },
    { name: "Calgary", lat: 51.0447, lon: -114.0719 },
    { name: "Ottawa", lat: 45.4215, lon: -75.6972 },
    { name: "Edmonton", lat: 53.5461, lon: -113.4938 },
    { name: "Winnipeg", lat: 49.8951, lon: -97.1384 },
    { name: "Quebec City", lat: 46.8139, lon: -71.2080 },
    { name: "Hamilton", lat: 43.2557, lon: -79.8711 },
    { name: "London", lat: 42.9849, lon: -81.2453 }
  ],
  POPULAR_POSTAL_CODES: [
    "M5V 3A8", // Toronto
    "V6B 1A1", // Vancouver
    "H2Y 1C6", // Montreal
    "T2P 1J9", // Calgary
    "K1A 0A6", // Ottawa
    "T5J 2R2", // Edmonton
    "R3C 1A5", // Winnipeg
    "G1R 2B5", // Quebec City
    "L8P 4X3", // Hamilton
    "N6A 3K7"  // London
  ]
};

// LRU Cache implementation
export class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private accessOrder: K[] = [];
  private maxSize: number;
  private maxAge: number;

  constructor(maxSize: number, maxAge: number) {
    this.maxSize = maxSize;
    this.maxAge = maxAge;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value) {
      // Move to end (most recently used)
      this.moveToEnd(key);
    }
    return value;
  }

  set(key: K, value: V): void {
    // If key exists, update and move to end
    if (this.cache.has(key)) {
      this.cache.set(key, value);
      this.moveToEnd(key);
      return;
    }

    // If at capacity, remove least recently used
    if (this.cache.size >= this.maxSize) {
      const lruKey = this.accessOrder.shift();
      if (lruKey) {
        this.cache.delete(lruKey);
      }
    }

    this.cache.set(key, value);
    this.accessOrder.push(key);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      const index = this.accessOrder.indexOf(key);
      if (index > -1) {
        this.accessOrder.splice(index, 1);
      }
    }
    return deleted;
  }

  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  size(): number {
    return this.cache.size;
  }

  private moveToEnd(key: K): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
      this.accessOrder.push(key);
    }
  }
}

// Global cache instances with size limits to prevent memory leaks
const MAX_GLOBAL_CACHE_SIZE = 5; // Maximum entries per global cache

// Helper to enforce size limits on Maps
function enforceCacheSizeLimit<K, V>(cache: Map<K, V>, maxSize: number): void {
  if (cache.size > maxSize) {
    // Remove oldest entries (first in Map iteration order)
    const entriesToDelete = cache.size - maxSize;
    let deleted = 0;
    for (const key of cache.keys()) {
      if (deleted >= entriesToDelete) break;
      cache.delete(key);
      deleted++;
    }
  }
}

// Global cache instances (kept for backward compatibility, but prefer LRU caches)
export const geoCache = new Map<string, GeoJSONFeatureCollection>();
export const spatialIndexCache = new Map<string, SpatialIndex>();
export const simplifiedBoundariesCache = new Map<string, any>();

// LRU cache instances
export const geoCacheLRU = new LRUCache<string, GeoJSONFeatureCollection>(CACHE_CONFIG.MAX_SIZE, CACHE_CONFIG.MAX_AGE);
export const spatialIndexCacheLRU = new LRUCache<string, SpatialIndex>(CACHE_CONFIG.MAX_SIZE, CACHE_CONFIG.MAX_AGE);

// Cache warming state
export const cacheWarmingState: CacheWarmingState = {
  isRunning: false,
  lastWarmed: 0,
  currentBatch: 0,
  totalBatches: 0,
  successCount: 0,
  failureCount: 0,
  nextWarmingTime: 0,
  lastError: undefined
};

// Lock for atomic cache warming state management
let cacheWarmingLock = false;

// Cache warming functions
export async function warmCacheForLocation(
  env: Env, 
  lat: number, 
  lon: number, 
  locationName: string,
  loadGeo: (env: Env, r2Key: string) => Promise<void>,
  lookupRiding: (env: Env, pathname: string, lon: number, lat: number) => Promise<any>
): Promise<boolean> {
  try {
    // Warm all three datasets for this location
    const datasets = [
      { pathname: "/api", r2Key: "federalridings-2024.geojson" },
      { pathname: "/api/qc", r2Key: "quebecridings-2025.geojson" },
      { pathname: "/api/on", r2Key: "ontarioridings-2022.geojson" }
    ];

    for (const dataset of datasets) {
      try {
        // Load the GeoJSON data to populate caches
        await loadGeo(env, dataset.r2Key);
        
        // Perform a lookup to warm the spatial index
        await lookupRiding(env, dataset.pathname, lon, lat);
        
        console.log(`Cache warmed for ${locationName} on ${dataset.pathname}`);
      } catch (error) {
        console.warn(`Failed to warm cache for ${locationName} on ${dataset.pathname}:`, error);
      }
    }
    
    return true;
  } catch (error) {
    console.error(`Cache warming failed for ${locationName}:`, error);
    return false;
  }
}

export async function warmCacheForPostalCode(
  env: Env, 
  postalCode: string,
  loadGeo: (env: Env, r2Key: string) => Promise<void>,
  lookupRiding: (env: Env, pathname: string, lon: number, lat: number) => Promise<any>
): Promise<boolean> {
  try {
    // Geocode the postal code first
    const query: QueryParams = { postal: postalCode };
    const { lon, lat } = await geocodeIfNeeded(env, query);
    
    // Warm cache for all datasets
    return await warmCacheForLocation(env, lat, lon, `Postal Code ${postalCode}`, loadGeo, lookupRiding);
  } catch (error) {
    console.error(`Cache warming failed for postal code ${postalCode}:`, error);
    return false;
  }
}

export async function performCacheWarming(
  env: Env,
  loadGeo: (env: Env, r2Key: string) => Promise<void>,
  lookupRiding: (env: Env, pathname: string, lon: number, lat: number) => Promise<any>
): Promise<void> {
  if (!CACHE_WARMING_CONFIG.ENABLED) {
    return;
  }

  // Atomic check and set using lock to prevent race conditions
  if (cacheWarmingLock || cacheWarmingState.isRunning) {
    return;
  }
  
  const now = Date.now();
  if (now < cacheWarmingState.nextWarmingTime) {
    return;
  }

  // Acquire lock atomically
  cacheWarmingLock = true;
  if (cacheWarmingState.isRunning) {
    cacheWarmingLock = false;
    return;
  }
  
  cacheWarmingState.isRunning = true;
  cacheWarmingLock = false;
  cacheWarmingState.currentBatch = 0;
  cacheWarmingState.successCount = 0;
  cacheWarmingState.failureCount = 0;

  try {
    console.log("Starting cache warming process...");

    // Calculate total batches
    const totalLocations = CACHE_WARMING_CONFIG.POPULAR_LOCATIONS.length + CACHE_WARMING_CONFIG.POPULAR_POSTAL_CODES.length;
    cacheWarmingState.totalBatches = Math.ceil(totalLocations / CACHE_WARMING_CONFIG.BATCH_SIZE);

    // Warm popular locations
    for (let i = 0; i < CACHE_WARMING_CONFIG.POPULAR_LOCATIONS.length; i += CACHE_WARMING_CONFIG.BATCH_SIZE) {
      const batch = CACHE_WARMING_CONFIG.POPULAR_LOCATIONS.slice(i, i + CACHE_WARMING_CONFIG.BATCH_SIZE);
      cacheWarmingState.currentBatch++;

      console.log(`Warming batch ${cacheWarmingState.currentBatch}/${cacheWarmingState.totalBatches} (locations)`);

      const promises = batch.map(async (location) => {
        const success = await warmCacheForLocation(env, location.lat, location.lon, location.name, loadGeo, lookupRiding);
        if (success) {
          cacheWarmingState.successCount++;
        } else {
          cacheWarmingState.failureCount++;
        }
        return success;
      });

      await Promise.allSettled(promises);

      // Small delay between batches to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Warm popular postal codes
    for (let i = 0; i < CACHE_WARMING_CONFIG.POPULAR_POSTAL_CODES.length; i += CACHE_WARMING_CONFIG.BATCH_SIZE) {
      const batch = CACHE_WARMING_CONFIG.POPULAR_POSTAL_CODES.slice(i, i + CACHE_WARMING_CONFIG.BATCH_SIZE);
      cacheWarmingState.currentBatch++;

      console.log(`Warming batch ${cacheWarmingState.currentBatch}/${cacheWarmingState.totalBatches} (postal codes)`);

      const promises = batch.map(async (postalCode) => {
        const success = await warmCacheForPostalCode(env, postalCode, loadGeo, lookupRiding);
        if (success) {
          cacheWarmingState.successCount++;
        } else {
          cacheWarmingState.failureCount++;
        }
        return success;
      });

      await Promise.allSettled(promises);

      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    cacheWarmingState.lastWarmed = now;
    cacheWarmingState.nextWarmingTime = now + CACHE_WARMING_CONFIG.WARMING_INTERVAL;

    console.log(`Cache warming completed. Success: ${cacheWarmingState.successCount}, Failures: ${cacheWarmingState.failureCount}`);
  } catch (error) {
    console.error("Cache warming process failed:", error);
    cacheWarmingState.lastError = error instanceof Error ? error.message : 'Unknown error';
  } finally {
    // Release lock and reset running state
    cacheWarmingState.isRunning = false;
    cacheWarmingLock = false;
  }
}

// Start cache warming on worker initialization
export async function initializeCacheWarming(
  env: Env,
  loadGeo: (env: Env, r2Key: string) => Promise<void>,
  lookupRiding: (env: Env, pathname: string, lon: number, lat: number) => Promise<any>
): Promise<void> {
  if (!CACHE_WARMING_CONFIG.ENABLED) {
    return;
  }

  // Start warming immediately
  performCacheWarming(env, loadGeo, lookupRiding).catch(error => {
    console.error("Initial cache warming failed:", error);
  });

  // Set up periodic warming
  setInterval(() => {
    performCacheWarming(env, loadGeo, lookupRiding).catch(error => {
      console.error("Periodic cache warming failed:", error);
    });
  }, CACHE_WARMING_CONFIG.WARMING_INTERVAL);
}

// Get cache warming status
export function getCacheWarmingStatus(): CacheWarmingState {
  return { ...cacheWarmingState };
}

// Cache utility functions
export function getCachedGeoJSON(key: string): GeoJSONFeatureCollection | undefined {
  // Try LRU cache first
  const cached = geoCacheLRU.get(key);
  if (cached) {
    return cached;
  }

  // Fallback to old cache
  const oldCached = geoCache.get(key);
  if (oldCached) {
    geoCacheLRU.set(key, oldCached);
    return oldCached;
  }

  return undefined;
}

export function setCachedGeoJSON(key: string, data: GeoJSONFeatureCollection): void {
  geoCacheLRU.set(key, data);
  geoCache.set(key, data);
  enforceCacheSizeLimit(geoCache, MAX_GLOBAL_CACHE_SIZE);
}

export function getCachedSpatialIndex(key: string): SpatialIndex | undefined {
  // Try LRU cache first
  const cached = spatialIndexCacheLRU.get(key);
  if (cached) {
    return cached;
  }

  // Fallback to old cache
  const oldCached = spatialIndexCache.get(key);
  if (oldCached) {
    spatialIndexCacheLRU.set(key, oldCached);
    return oldCached;
  }

  return undefined;
}

export function setCachedSpatialIndex(key: string, data: SpatialIndex): void {
  spatialIndexCacheLRU.set(key, data);
  spatialIndexCache.set(key, data);
  enforceCacheSizeLimit(spatialIndexCache, MAX_GLOBAL_CACHE_SIZE);
}

export function getCachedSimplifiedBoundary(cacheKey: string): any | undefined {
  return simplifiedBoundariesCache.get(cacheKey);
}

export function setCachedSimplifiedBoundary(cacheKey: string, geometry: any): void {
  simplifiedBoundariesCache.set(cacheKey, geometry);
  enforceCacheSizeLimit(simplifiedBoundariesCache, MAX_GLOBAL_CACHE_SIZE);
}
