/// <reference types="@cloudflare/workers-types" />

export interface Env {
  RIDINGS: R2Bucket;
  GEOCODER?: string;
  MAPBOX_TOKEN?: string;
  GOOGLE_MAPS_KEY?: string;
  BASIC_AUTH?: string;
  BATCH_QUEUE?: DurableObjectNamespace;
  QUEUE_MANAGER?: DurableObjectNamespace;
  BATCH_SIZE?: number;
  BATCH_TIMEOUT?: number;
  RATE_LIMIT?: number;
  GEOCODING_CACHE?: KVNamespace;
  RIDING_DB?: D1Database;
}

interface MapboxFeature {
  center: [number, number];
}

interface MapboxResponse {
  features: MapboxFeature[];
}

interface NominatimResult {
  lon: string;
  lat: string;
}

interface GeoJSONGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][] | number[][][][];
}

interface GeoJSONFeature {
  type: "Feature";
  geometry: GeoJSONGeometry;
  properties: Record<string, unknown>;
}

interface GeoJSONFeatureCollection {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
}

interface QueryParams {
  address?: string;
  postal?: string;
  lat?: number;
  lon?: number;
  city?: string;
  state?: string; // province/state
  country?: string;
}

interface LookupResult {
  properties: Record<string, unknown> | null;
}

interface BatchLookupRequest {
  id: string;
  query: QueryParams;
  pathname: string;
}

interface BatchRequest {
  endpoint: string;
  queries: Array<{
    id?: string;
    query: QueryParams;
  }>;
}

interface BatchLookupResponse {
  id: string;
  query: QueryParams;
  point?: { lon: number; lat: number };
  properties: Record<string, unknown> | null;
  error?: string;
  processingTime: number;
}

interface BatchJob {
  id: string;
  requests: BatchLookupRequest[];
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
  results: BatchLookupResponse[];
  errors: string[];
}

interface TimeoutConfig {
  geocoding: number;
  lookup: number;
  batch: number;
  total: number;
}

// Minimal Google Geocoding API response types we use
interface GoogleGeocodeLocation { lat: number; lng: number }
interface GoogleGeocodeGeometry { location: GoogleGeocodeLocation }
interface GoogleGeocodeResult { geometry: GoogleGeocodeGeometry }
interface GoogleGeocodeResponse { status: string; results: GoogleGeocodeResult[] }

// Google Maps Batch Geocoding API types
interface GoogleBatchGeocodeRequest {
  addresses: Array<{
    address: string;
    region?: string;
    components?: Record<string, string>;
  }>;
}

interface GoogleBatchGeocodeResponse {
  results: Array<{
    address: string;
    geocoded_address: string;
    partial_match: boolean;
    place_id: string;
    postcode_localities: string[];
    types: string[];
    geometry: {
      location: { lat: number; lng: number };
      location_type: string;
      viewport: {
        northeast: { lat: number; lng: number };
        southwest: { lat: number; lng: number };
      };
    };
    plus_code: {
      global_code: string;
      compound_code: string;
    };
  }>;
  status: string;
}

// Batch geocoding configuration
const BATCH_GEOCODING_CONFIG = {
  ENABLED: true,
  MAX_BATCH_SIZE: 10, // Google's limit is 10 addresses per batch
  TIMEOUT: 30000, // 30 seconds
  RETRY_ATTEMPTS: 3,
  FALLBACK_TO_INDIVIDUAL: true
};

// Webhook configuration
interface WebhookConfig {
  url: string;
  secret: string;
  events: string[];
  retryAttempts: number;
  retryDelay: number;
  timeout: number;
  enabled: boolean;
}

interface WebhookEvent {
  id: string;
  webhookId: string;
  eventType: string;
  batchId: string;
  status: 'pending' | 'delivered' | 'failed' | 'retrying';
  payload: any;
  timestamp: number;
  attempts: number;
  lastAttempt?: number;
  nextRetryAt?: number;
  error?: string;
}

interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  status: 'pending' | 'delivered' | 'failed' | 'retrying';
  attempts: number;
  lastAttempt: number;
  nextRetryAt?: number;
  responseCode?: number;
  responseBody?: string;
  error?: string;
}

const webhookConfigs = new Map<string, WebhookConfig>();
const webhookEvents = new Map<string, WebhookEvent>();
const webhookDeliveries = new Map<string, WebhookDelivery>();

// Webhook configuration
const WEBHOOK_CONFIG = {
  ENABLED: true,
  MAX_RETRY_ATTEMPTS: 5,
  RETRY_DELAY: 5000, // 5 seconds
  TIMEOUT: 30000, // 30 seconds
  MAX_WEBHOOKS: 10,
  CLEANUP_INTERVAL: 24 * 60 * 60 * 1000, // 24 hours
  MAX_EVENT_AGE: 7 * 24 * 60 * 60 * 1000 // 7 days
};

// Riding boundaries configuration
const BOUNDARIES_CONFIG = {
  ENABLED: true,
  DEFAULT_SIMPLIFICATION_TOLERANCE: 0.001, // ~100m at equator
  MAX_SIMPLIFICATION_TOLERANCE: 0.01, // ~1km at equator
  MIN_SIMPLIFICATION_TOLERANCE: 0.0001, // ~10m at equator
  MAX_VERTICES: 1000, // Maximum vertices in simplified geometry
  CACHE_SIMPLIFIED_BOUNDARIES: true,
  CACHE_TTL: 24 * 60 * 60 * 1000, // 24 hours
  MAX_CACHE_SIZE: 1000
};

// Cache for simplified boundaries
const simplifiedBoundariesCache = new Map<string, GeoJSONGeometry>();

// Spatial database configuration
const SPATIAL_DB_CONFIG = {
  ENABLED: false, // Enable when D1 database is configured
  USE_RTREE_INDEX: true,
  BATCH_INSERT_SIZE: 1000,
  SPATIAL_INDEX_PRECISION: 6, // Decimal places for lat/lon indexing
  ENABLE_QUERY_OPTIMIZATION: true,
  CACHE_PREPARED_STATEMENTS: true
};

// Generate webhook ID
function generateWebhookId(): string {
  return `webhook_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Generate event ID
function generateEventId(): string {
  return `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Generate delivery ID
function generateDeliveryId(): string {
  return `delivery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Simple point-in-polygon test using ray casting.
// Supports Polygon and MultiPolygon GeoJSON geometries.
function isPointInPolygon(lon: number, lat: number, geometry: GeoJSONGeometry): boolean {
  const point = [lon, lat];
  const type = geometry?.type;
  const coords = geometry?.coordinates;
  if (!type || !coords) return false;

  if (type === "Polygon") {
    return polygonContains(point, coords as number[][][]);
  }
  if (type === "MultiPolygon") {
    for (const poly of coords) {
      if (polygonContains(point, poly as number[][][])) return true;
    }
    return false;
  }
  return false;
}

function polygonContains(point: number[], polygon: number[][][]): boolean {
  // polygon: [ [ [lon,lat], ... ] outerRing, hole1, hole2, ... ]
  if (!Array.isArray(polygon) || polygon.length === 0) return false;
  // Must be inside outer ring and outside holes
  if (!ringContains(point, polygon[0] as number[][])) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (ringContains(point, polygon[i])) return false; // inside a hole
  }
  return true;
}

function ringContains(point: number[], ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > point[1]) !== (yj > point[1])) &&
      (point[0] < (xj - xi) * (point[1] - yi) / (yj - yi + 0.0) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Minimal in-memory cache of parsed FeatureCollections by key
const geoCache: Map<string, GeoJSONFeatureCollection> = new Map();

// Spatial index cache for bounding boxes
const spatialIndexCache: Map<string, SpatialIndex> = new Map();

// Cache configuration
const CACHE_CONFIG = {
  MAX_SIZE: 10, // Maximum number of datasets to cache
  MAX_AGE: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
};

// Cache warming configuration
const CACHE_WARMING_CONFIG = {
  ENABLED: true,
  POPULAR_LOCATIONS: [
    // Major Canadian cities
    { name: "Toronto", lat: 43.6532, lon: -79.3832, province: "ON" },
    { name: "Montreal", lat: 45.5017, lon: -73.5673, province: "QC" },
    { name: "Vancouver", lat: 49.2827, lon: -123.1207, province: "BC" },
    { name: "Calgary", lat: 51.0447, lon: -114.0719, province: "AB" },
    { name: "Edmonton", lat: 53.5461, lon: -113.4938, province: "AB" },
    { name: "Ottawa", lat: 45.4215, lon: -75.6972, province: "ON" },
    { name: "Winnipeg", lat: 49.8951, lon: -97.1384, province: "MB" },
    { name: "Quebec City", lat: 46.8139, lon: -71.2080, province: "QC" },
    { name: "Hamilton", lat: 43.2557, lon: -79.8711, province: "ON" },
    { name: "Kitchener", lat: 43.4501, lon: -80.4829, province: "ON" },
    { name: "London", lat: 42.9849, lon: -81.2453, province: "ON" },
    { name: "Victoria", lat: 48.4284, lon: -123.3656, province: "BC" },
    { name: "Halifax", lat: 44.6488, lon: -63.5752, province: "NS" },
    { name: "Oshawa", lat: 43.8971, lon: -78.8658, province: "ON" },
    { name: "Windsor", lat: 42.3149, lon: -83.0364, province: "ON" }
  ],
  POPULAR_POSTAL_CODES: [
    // Major postal codes for each province
    "K1A 0A6", // Ottawa (Parliament Hill)
    "M5H 2N2", // Toronto (Financial District)
    "H3B 2Y7", // Montreal (Downtown)
    "V6B 1A1", // Vancouver (Downtown)
    "T2P 1J9", // Calgary (Downtown)
    "T5J 0N6", // Edmonton (Downtown)
    "R3C 1A5", // Winnipeg (Downtown)
    "G1R 4P5", // Quebec City (Old Quebec)
    "L8P 4X3", // Hamilton (Downtown)
    "N2H 4Y2", // Kitchener (Downtown)
    "N6A 3K7", // London (Downtown)
    "V8W 1P1", // Victoria (Downtown)
    "B3H 2Y1", // Halifax (Downtown)
    "L1H 7K4", // Oshawa (Downtown)
    "N9A 6K3"  // Windsor (Downtown)
  ],
  WARMING_INTERVAL: 30 * 60 * 1000, // 30 minutes
  BATCH_SIZE: 5, // Number of locations to warm per batch
  MAX_RETRIES: 3
};

// Cache warming state
interface CacheWarmingState {
  isRunning: boolean;
  lastWarmed: number;
  currentBatch: number;
  totalBatches: number;
  successCount: number;
  failureCount: number;
  nextWarmingTime: number;
}

const cacheWarmingState: CacheWarmingState = {
  isRunning: false,
  lastWarmed: 0,
  currentBatch: 0,
  totalBatches: 0,
  successCount: 0,
  failureCount: 0,
  nextWarmingTime: 0
};

// LRU cache implementation
class LRUCache<K, V> {
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

// Create LRU cache instances
const geoCacheLRU = new LRUCache<string, GeoJSONFeatureCollection>(CACHE_CONFIG.MAX_SIZE, CACHE_CONFIG.MAX_AGE);
const spatialIndexCacheLRU = new LRUCache<string, SpatialIndex>(CACHE_CONFIG.MAX_SIZE, CACHE_CONFIG.MAX_AGE);

// Cache warming functions
async function warmCacheForLocation(env: Env, lat: number, lon: number, locationName: string): Promise<boolean> {
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

async function warmCacheForPostalCode(env: Env, postalCode: string): Promise<boolean> {
  try {
    // Geocode the postal code first
    const query: QueryParams = { postal: postalCode };
    const { lon, lat } = await geocodeIfNeeded(env, query);
    
    // Warm cache for all datasets
    return await warmCacheForLocation(env, lat, lon, `Postal Code ${postalCode}`);
    } catch (error) {
    console.error(`Cache warming failed for postal code ${postalCode}:`, error);
    return false;
  }
}

async function performCacheWarming(env: Env): Promise<void> {
  if (!CACHE_WARMING_CONFIG.ENABLED || cacheWarmingState.isRunning) {
    return;
  }

  const now = Date.now();
  if (now < cacheWarmingState.nextWarmingTime) {
    return;
  }

  cacheWarmingState.isRunning = true;
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
        const success = await warmCacheForLocation(env, location.lat, location.lon, location.name);
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
        const success = await warmCacheForPostalCode(env, postalCode);
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
  } finally {
    cacheWarmingState.isRunning = false;
  }
}

// Start cache warming on worker initialization
async function initializeCacheWarming(env: Env): Promise<void> {
  if (!CACHE_WARMING_CONFIG.ENABLED) {
    return;
  }

  // Start warming immediately
  performCacheWarming(env).catch(error => {
    console.error("Initial cache warming failed:", error);
  });

  // Set up periodic warming
  setInterval(() => {
    performCacheWarming(env).catch(error => {
      console.error("Periodic cache warming failed:", error);
    });
  }, CACHE_WARMING_CONFIG.WARMING_INTERVAL);
}

// Get cache warming status
function getCacheWarmingStatus(): CacheWarmingState {
  return { ...cacheWarmingState };
}

// Batch geocoding functions
async function geocodeBatch(env: Env, queries: QueryParams[], request?: Request): Promise<Array<{ lon: number; lat: number; success: boolean; error?: string }>> {
  if (!BATCH_GEOCODING_CONFIG.ENABLED || queries.length === 0) {
    return [];
  }

  const results: Array<{ lon: number; lat: number; success: boolean; error?: string }> = [];
  
  // Check if we have a Google API key
  const headerKey = request?.headers.get("X-Google-API-Key");
  const key = headerKey || env.GOOGLE_MAPS_KEY;
  
  if (!key) {
    // Fallback to individual geocoding
    if (BATCH_GEOCODING_CONFIG.FALLBACK_TO_INDIVIDUAL) {
      console.log("No Google API key available, falling back to individual geocoding");
      for (const query of queries) {
        try {
          const result = await geocodeIfNeeded(env, query, request);
          results.push({ ...result, success: true });
        } catch (error) {
          results.push({ 
            lon: 0, 
            lat: 0, 
            success: false, 
            error: error instanceof Error ? error.message : "Geocoding failed" 
          });
        }
      }
    }
    return results;
  }

  // Process queries in batches
  for (let i = 0; i < queries.length; i += BATCH_GEOCODING_CONFIG.MAX_BATCH_SIZE) {
    const batch = queries.slice(i, i + BATCH_GEOCODING_CONFIG.MAX_BATCH_SIZE);
    
    try {
      const batchResults = await geocodeBatchWithGoogle(env, batch, key);
      results.push(...batchResults);
    } catch (error) {
      console.error(`Batch geocoding failed for batch ${i / BATCH_GEOCODING_CONFIG.MAX_BATCH_SIZE + 1}:`, error);
      
      // Fallback to individual geocoding for this batch
      if (BATCH_GEOCODING_CONFIG.FALLBACK_TO_INDIVIDUAL) {
        for (const query of batch) {
          try {
            const result = await geocodeIfNeeded(env, query, request);
            results.push({ ...result, success: true });
          } catch (individualError) {
            results.push({ 
              lon: 0, 
              lat: 0, 
              success: false, 
              error: individualError instanceof Error ? individualError.message : "Geocoding failed" 
            });
          }
        }
      } else {
        // Mark all queries in this batch as failed
        for (const query of batch) {
          results.push({ 
            lon: 0, 
            lat: 0, 
            success: false, 
            error: error instanceof Error ? error.message : "Batch geocoding failed" 
          });
        }
      }
    }
  }

  return results;
}

async function geocodeBatchWithGoogle(env: Env, queries: QueryParams[], apiKey: string): Promise<Array<{ lon: number; lat: number; success: boolean; error?: string }>> {
  const results: Array<{ lon: number; lat: number; success: boolean; error?: string }> = [];
  
  // Convert queries to Google batch format
  const addresses = queries.map(query => {
    const addressParts: string[] = [];
    
    if (query.address) addressParts.push(query.address);
    if (query.city) addressParts.push(query.city);
    if (query.state) addressParts.push(query.state);
    if (query.country) addressParts.push(query.country);
    if (query.postal) addressParts.push(query.postal);
    
    const fullAddress = addressParts.join(", ");
    
    const batchAddress: any = {
      address: fullAddress || "Canada" // Fallback to Canada if no address provided
    };
    
    // Add components for better accuracy
    const components: Record<string, string> = {};
    if (query.postal) components.postal_code = query.postal;
    if (query.city) components.locality = query.city;
    if (query.state) components.administrative_area = query.state;
    if (query.country) components.country = query.country;
    
    if (Object.keys(components).length > 0) {
      batchAddress.components = components;
    }
    
    // Add region bias for Canada
    batchAddress.region = "CA";
    
    return batchAddress;
  });

  const batchRequest: GoogleBatchGeocodeRequest = { addresses };
  
  // Make the batch geocoding request
  const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'riding-lookup/1.0'
    },
    body: JSON.stringify(batchRequest)
  });

  if (!response.ok) {
    throw new Error(`Google batch geocoding error: ${response.status}`);
  }

  const data = await response.json() as GoogleBatchGeocodeResponse;
  
  if (data.status !== 'OK') {
    throw new Error(`Google batch geocoding failed: ${data.status}`);
  }

  // Process results
  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    const result = data.results[i];
    
    if (result && result.geometry && result.geometry.location) {
      results.push({
        lon: result.geometry.location.lng,
        lat: result.geometry.location.lat,
        success: true
      });
  } else {
      results.push({
        lon: 0,
        lat: 0,
        success: false,
        error: `No geocoding result for query: ${JSON.stringify(query)}`
      });
    }
  }

  return results;
}

// Enhanced batch processing with batch geocoding
async function processBatchLookupWithBatchGeocoding(env: Env, requests: BatchLookupRequest[]): Promise<BatchLookupResponse[]> {
  const results: BatchLookupResponse[] = [];
  const batchSize = env.BATCH_SIZE || DEFAULT_BATCH_SIZE;
  
  // Group requests by geocoding needs
  const geocodingNeeded: Array<{ request: BatchLookupRequest; index: number }> = [];
  const coordinatesProvided: Array<{ request: BatchLookupRequest; index: number; lon: number; lat: number }> = [];
  
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    if (req.query.lat !== undefined && req.query.lon !== undefined) {
      coordinatesProvided.push({
        request: req,
        index: i,
        lon: req.query.lon,
        lat: req.query.lat
      });
  } else {
      geocodingNeeded.push({
        request: req,
        index: i
      });
    }
  }
  
  // Process coordinates-provided requests immediately
  for (const { request, index, lon, lat } of coordinatesProvided) {
    const startTime = Date.now();
    try {
      const result = await lookupRiding(env, request.pathname, lon, lat);
      const processingTime = Date.now() - startTime;
      
      results[index] = {
        id: request.id,
        query: request.query,
        point: { lon, lat },
        properties: result.properties,
        processingTime
      };
    } catch (error) {
      const processingTime = Date.now() - startTime;
      results[index] = {
        id: request.id,
        query: request.query,
        properties: null,
        error: error instanceof Error ? error.message : "Lookup failed",
        processingTime
      };
    }
  }
  
  // Process geocoding-needed requests in batches
  if (geocodingNeeded.length > 0) {
    const queries = geocodingNeeded.map(item => item.request.query);
    const geocodingResults = await geocodeBatch(env, queries);
    
    for (let i = 0; i < geocodingNeeded.length; i++) {
      const { request, index } = geocodingNeeded[i];
      const geocodingResult = geocodingResults[i];
      const startTime = Date.now();
      
      if (geocodingResult.success) {
        try {
          const result = await lookupRiding(env, request.pathname, geocodingResult.lon, geocodingResult.lat);
          const processingTime = Date.now() - startTime;
          
          results[index] = {
            id: request.id,
            query: request.query,
            point: { lon: geocodingResult.lon, lat: geocodingResult.lat },
            properties: result.properties,
            processingTime
          };
        } catch (error) {
          const processingTime = Date.now() - startTime;
          results[index] = {
            id: request.id,
            query: request.query,
            properties: null,
            error: error instanceof Error ? error.message : "Lookup failed",
            processingTime
          };
        }
  } else {
        const processingTime = Date.now() - startTime;
        results[index] = {
          id: request.id,
          query: request.query,
          properties: null,
          error: geocodingResult.error || "Geocoding failed",
          processingTime
        };
      }
    }
  }
  
  return results;
}

// Webhook functions
async function createWebhookEvent(webhookId: string, eventType: string, batchId: string, payload: any): Promise<string> {
  const eventId = generateEventId();
  const event: WebhookEvent = {
    id: eventId,
    webhookId,
    eventType,
    batchId,
    status: 'pending',
    payload,
    timestamp: Date.now(),
    attempts: 0
  };
  
  webhookEvents.set(eventId, event);
  return eventId;
}

async function deliverWebhook(webhookId: string, eventId: string): Promise<boolean> {
  const webhook = webhookConfigs.get(webhookId);
  const event = webhookEvents.get(eventId);
  
  if (!webhook || !event || !webhook.enabled) {
    return false;
  }
  
  const deliveryId = generateDeliveryId();
  const delivery: WebhookDelivery = {
    id: deliveryId,
    webhookId,
    eventId,
    status: 'pending',
    attempts: 0,
    lastAttempt: Date.now()
  };
  
  webhookDeliveries.set(deliveryId, delivery);
  
  try {
    // Create signature
    const signature = await createWebhookSignature(webhook.secret, JSON.stringify(event.payload));
    
    // Make the webhook request
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'riding-lookup-webhook/1.0',
        'X-Webhook-Event': event.eventType,
        'X-Webhook-Signature': signature,
        'X-Webhook-Delivery': deliveryId
      },
      body: JSON.stringify(event.payload),
      signal: AbortSignal.timeout(webhook.timeout)
    });
    
    delivery.attempts++;
    delivery.lastAttempt = Date.now();
    delivery.responseCode = response.status;
    delivery.responseBody = await response.text();
    
    if (response.ok) {
      delivery.status = 'delivered';
      event.status = 'delivered';
      event.attempts++;
      webhookEvents.set(eventId, event);
      webhookDeliveries.set(deliveryId, delivery);
      return true;
    } else {
      delivery.status = 'failed';
      delivery.error = `HTTP ${response.status}: ${delivery.responseBody}`;
      webhookDeliveries.set(deliveryId, delivery);
      
      // Schedule retry if within limits
      if (event.attempts < webhook.retryAttempts) {
        event.status = 'retrying';
        event.attempts++;
        event.nextRetryAt = Date.now() + webhook.retryDelay * Math.pow(2, event.attempts - 1);
        webhookEvents.set(eventId, event);
      } else {
        event.status = 'failed';
        event.error = `Max retry attempts exceeded: ${delivery.error}`;
        webhookEvents.set(eventId, event);
      }
      
      return false;
    }
  } catch (error) {
    delivery.attempts++;
    delivery.lastAttempt = Date.now();
    delivery.status = 'failed';
    delivery.error = error instanceof Error ? error.message : 'Unknown error';
    webhookDeliveries.set(deliveryId, delivery);
    
    // Schedule retry if within limits
    if (event.attempts < webhook.retryAttempts) {
      event.status = 'retrying';
      event.attempts++;
      event.nextRetryAt = Date.now() + webhook.retryDelay * Math.pow(2, event.attempts - 1);
      webhookEvents.set(eventId, event);
    } else {
      event.status = 'failed';
      event.error = `Max retry attempts exceeded: ${delivery.error}`;
      webhookEvents.set(eventId, event);
    }
    
    return false;
  }
}

async function createWebhookSignature(secret: string, payload: string): Promise<string> {
  // Simple HMAC-SHA256 signature (in a real implementation, you'd use a proper crypto library)
  const encoder = new TextEncoder();
  const key = encoder.encode(secret);
  const data = encoder.encode(payload);
  
  // This is a simplified implementation - in production, use a proper HMAC library
  const combined = new Uint8Array(key.length + data.length);
  combined.set(key);
  combined.set(data, key.length);
  
  const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return `sha256=${hashHex}`;
}

async function processWebhookEvents(): Promise<void> {
  if (!WEBHOOK_CONFIG.ENABLED) {
    return;
  }
  
  const now = Date.now();
  const eventsToProcess: WebhookEvent[] = [];
  
  // Find events that need processing
  for (const event of webhookEvents.values()) {
    if (event.status === 'pending' || 
        (event.status === 'retrying' && event.nextRetryAt && now >= event.nextRetryAt)) {
      eventsToProcess.push(event);
    }
  }
  
  // Process events
  for (const event of eventsToProcess) {
    try {
      await deliverWebhook(event.webhookId, event.id);
    } catch (error) {
      console.error(`Failed to process webhook event ${event.id}:`, error);
    }
  }
}

async function cleanupWebhookData(): Promise<void> {
  const now = Date.now();
  const maxAge = WEBHOOK_CONFIG.MAX_EVENT_AGE;
  
  // Clean up old events
  for (const [eventId, event] of webhookEvents.entries()) {
    if (now - event.timestamp > maxAge) {
      webhookEvents.delete(eventId);
    }
  }
  
  // Clean up old deliveries
  for (const [deliveryId, delivery] of webhookDeliveries.entries()) {
    if (now - delivery.lastAttempt > maxAge) {
      webhookDeliveries.delete(deliveryId);
    }
  }
}

// Start webhook processing
function initializeWebhookProcessing(): void {
  if (!WEBHOOK_CONFIG.ENABLED) {
    return;
  }
  
  // Process webhook events every 30 seconds
  setInterval(() => {
    processWebhookEvents().catch(error => {
      console.error("Webhook processing failed:", error);
    });
  }, 30000);
  
  // Cleanup old data every hour
  setInterval(() => {
    cleanupWebhookData().catch(error => {
      console.error("Webhook cleanup failed:", error);
    });
  }, 60 * 60 * 1000);
}

// Trigger webhook for batch completion
async function triggerBatchCompletionWebhook(batchId: string, batchStatus: any): Promise<void> {
  if (!WEBHOOK_CONFIG.ENABLED) {
    return;
  }
  
  const payload = {
    event: 'batch.completed',
    batchId,
    status: batchStatus.status,
    totalJobs: batchStatus.totalJobs,
    completedJobs: batchStatus.completedJobs,
    failedJobs: batchStatus.failedJobs,
    createdAt: batchStatus.createdAt,
    completedAt: batchStatus.completedAt,
    timestamp: Date.now()
  };
  
  // Find webhooks that listen for batch completion events
  for (const [webhookId, webhook] of webhookConfigs.entries()) {
    if (webhook.enabled && webhook.events.includes('batch.completed')) {
      try {
        await createWebhookEvent(webhookId, 'batch.completed', batchId, payload);
      } catch (error) {
        console.error(`Failed to create webhook event for ${webhookId}:`, error);
      }
    }
  }
}

// Riding boundaries functions
async function getRidingBoundary(env: Env, pathname: string, lon: number, lat: number, options?: {
  simplify?: boolean;
  tolerance?: number;
  maxVertices?: number;
}): Promise<{ geometry: GeoJSONGeometry | null; properties: Record<string, unknown> | null }> {
  if (!BOUNDARIES_CONFIG.ENABLED) {
    return { geometry: null, properties: null };
  }

  const { r2Key } = pickDataset(pathname);
  
  // Load the GeoJSON data
  const featureCollection = await loadGeo(env, r2Key);
  
  // Find the riding that contains the point
  let foundFeature: GeoJSONFeature | null = null;
  
  for (const feature of featureCollection.features) {
    if (isPointInPolygon(lon, lat, feature.geometry)) {
      foundFeature = feature;
      break;
    }
  }
  
  if (!foundFeature) {
    return { geometry: null, properties: null };
  }
  
  let geometry = foundFeature.geometry;
  
  // Apply simplification if requested
  if (options?.simplify !== false) {
    const tolerance = Math.max(
      BOUNDARIES_CONFIG.MIN_SIMPLIFICATION_TOLERANCE,
      Math.min(
        BOUNDARIES_CONFIG.MAX_SIMPLIFICATION_TOLERANCE,
        options?.tolerance || BOUNDARIES_CONFIG.DEFAULT_SIMPLIFICATION_TOLERANCE
      )
    );
    
    const maxVertices = options?.maxVertices || BOUNDARIES_CONFIG.MAX_VERTICES;
    
    // Check cache first
    const cacheKey = `${r2Key}_${foundFeature.properties?.FED_NUM || 'unknown'}_${tolerance}_${maxVertices}`;
    
    if (BOUNDARIES_CONFIG.CACHE_SIMPLIFIED_BOUNDARIES) {
      const cached = simplifiedBoundariesCache.get(cacheKey);
      if (cached) {
        geometry = cached;
      } else {
        geometry = simplifyGeometry(foundFeature.geometry, tolerance, maxVertices);
        simplifiedBoundariesCache.set(cacheKey, geometry);
      }
    } else {
      geometry = simplifyGeometry(foundFeature.geometry, tolerance, maxVertices);
    }
  }
  
  return {
    geometry,
    properties: foundFeature.properties
  };
}

// Get riding boundary by riding ID
async function getRidingBoundaryById(env: Env, pathname: string, ridingId: string, options?: {
  simplify?: boolean;
  tolerance?: number;
  maxVertices?: number;
}): Promise<{ geometry: GeoJSONGeometry | null; properties: Record<string, unknown> | null }> {
  if (!BOUNDARIES_CONFIG.ENABLED) {
    return { geometry: null, properties: null };
  }

  const { r2Key } = pickDataset(pathname);
  
  // Load the GeoJSON data
  const featureCollection = await loadGeo(env, r2Key);
  
  // Find the riding by ID
  let foundFeature: GeoJSONFeature | null = null;
  
  for (const feature of featureCollection.features) {
    const featureId = feature.properties?.FED_NUM || feature.properties?.RIDING_NUM || feature.properties?.ID;
    if (featureId && featureId.toString() === ridingId.toString()) {
      foundFeature = feature;
      break;
    }
  }
  
  if (!foundFeature) {
    return { geometry: null, properties: null };
  }
  
  let geometry = foundFeature.geometry;
  
  // Apply simplification if requested
  if (options?.simplify !== false) {
    const tolerance = Math.max(
      BOUNDARIES_CONFIG.MIN_SIMPLIFICATION_TOLERANCE,
      Math.min(
        BOUNDARIES_CONFIG.MAX_SIMPLIFICATION_TOLERANCE,
        options?.tolerance || BOUNDARIES_CONFIG.DEFAULT_SIMPLIFICATION_TOLERANCE
      )
    );
    
    const maxVertices = options?.maxVertices || BOUNDARIES_CONFIG.MAX_VERTICES;
    
    // Check cache first
    const cacheKey = `${r2Key}_${ridingId}_${tolerance}_${maxVertices}`;
    
    if (BOUNDARIES_CONFIG.CACHE_SIMPLIFIED_BOUNDARIES) {
      const cached = simplifiedBoundariesCache.get(cacheKey);
      if (cached) {
        geometry = cached;
      } else {
        geometry = simplifyGeometry(foundFeature.geometry, tolerance, maxVertices);
        simplifiedBoundariesCache.set(cacheKey, geometry);
      }
    } else {
      geometry = simplifyGeometry(foundFeature.geometry, tolerance, maxVertices);
    }
  }
  
  return {
    geometry,
    properties: foundFeature.properties
  };
}

// Get all riding boundaries for a dataset
async function getAllRidingBoundaries(env: Env, pathname: string, options?: {
  simplify?: boolean;
  tolerance?: number;
  maxVertices?: number;
  limit?: number;
  offset?: number;
}): Promise<{ features: GeoJSONFeature[]; total: number }> {
  if (!BOUNDARIES_CONFIG.ENABLED) {
    return { features: [], total: 0 };
  }

  const { r2Key } = pickDataset(pathname);
  
  // Load the GeoJSON data
  const featureCollection = await loadGeo(env, r2Key);
  
  let features = featureCollection.features;
  
  // Apply simplification if requested
  if (options?.simplify !== false) {
    const tolerance = Math.max(
      BOUNDARIES_CONFIG.MIN_SIMPLIFICATION_TOLERANCE,
      Math.min(
        BOUNDARIES_CONFIG.MAX_SIMPLIFICATION_TOLERANCE,
        options?.tolerance || BOUNDARIES_CONFIG.DEFAULT_SIMPLIFICATION_TOLERANCE
      )
    );
    
    const maxVertices = options?.maxVertices || BOUNDARIES_CONFIG.MAX_VERTICES;
    
    features = features.map(feature => ({
      ...feature,
      geometry: simplifyGeometry(feature.geometry, tolerance, maxVertices)
    }));
  }
  
  // Apply pagination
  const offset = options?.offset || 0;
  const limit = options?.limit || features.length;
  const paginatedFeatures = features.slice(offset, offset + limit);
  
  return {
    features: paginatedFeatures,
    total: features.length
  };
}

// Geometry simplification function
function simplifyGeometry(geometry: any, tolerance: number, maxVertices: number): GeoJSONGeometry {
  // Handle Point geometry (no simplification needed)
  if (geometry.type === 'Point') {
    return geometry;
  }
  
  // Handle LineString geometry
  if (geometry.type === 'LineString') {
    return {
      ...geometry,
      coordinates: simplifyLineString(geometry.coordinates as unknown as number[][], tolerance, maxVertices)
    };
  }
  
  // Handle Polygon geometry
  if (geometry.type === 'Polygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map(ring => 
        simplifyLineString(ring as unknown as number[][], tolerance, maxVertices)
      )
    };
  }
  
  // Handle MultiPolygon geometry
  if (geometry.type === 'MultiPolygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map(polygon =>
        polygon.map(ring => 
          simplifyLineString(ring as unknown as number[][], tolerance, maxVertices)
        )
      )
    };
  }
  
  // Return original geometry for any other types
  return geometry;
}

// Spatial database functions
interface SpatialDatabaseFeature {
  id: string;
  dataset: string;
  feature_data: string; // JSON string of the GeoJSON feature
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
  centroid_lon: number;
  centroid_lat: number;
  area: number;
  created_at: string;
}

// Initialize spatial database tables
async function initializeSpatialDatabase(env: Env): Promise<boolean> {
  if (!SPATIAL_DB_CONFIG.ENABLED || !env.RIDING_DB) {
    return false;
  }

  try {
    // Create the main features table with spatial indexes
    await env.RIDING_DB.prepare(`
      CREATE TABLE IF NOT EXISTS spatial_features (
        id TEXT PRIMARY KEY,
        dataset TEXT NOT NULL,
        feature_data TEXT NOT NULL,
        minx REAL NOT NULL,
        miny REAL NOT NULL,
        maxx REAL NOT NULL,
        maxy REAL NOT NULL,
        centroid_lon REAL NOT NULL,
        centroid_lat REAL NOT NULL,
        area REAL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // Create spatial indexes for better query performance
    await env.RIDING_DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_spatial_bounds ON spatial_features(minx, miny, maxx, maxy)
    `).run();

    await env.RIDING_DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_spatial_centroid ON spatial_features(centroid_lon, centroid_lat)
    `).run();

    await env.RIDING_DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_dataset ON spatial_features(dataset)
    `).run();

    // Create R-tree virtual table for spatial indexing if enabled
    if (SPATIAL_DB_CONFIG.USE_RTREE_INDEX) {
      await env.RIDING_DB.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS spatial_rtree USING rtree(
          id,
          minx, maxx,
          miny, maxy
        )
      `).run();
    }

    console.log('Spatial database initialized successfully');
    return true;
  } catch (error) {
    console.error('Failed to initialize spatial database:', error);
    return false;
  }
}

// Insert features into spatial database
async function insertFeaturesIntoDatabase(env: Env, dataset: string, features: GeoJSONFeature[]): Promise<boolean> {
  if (!SPATIAL_DB_CONFIG.ENABLED || !env.RIDING_DB) {
    return false;
  }

  try {
    const statements: D1PreparedStatement[] = [];

    for (const feature of features) {
      const bbox = calculateBoundingBox(feature.geometry);
      const centroid = calculateCentroid(feature.geometry);
      const area = 0; // Placeholder for area calculation

      const featureId = `${dataset}_${feature.properties?.FED_NUM || feature.properties?.RIDING_NUM || feature.properties?.ID || Date.now()}`;

      // Insert into main table
      statements.push(env.RIDING_DB.prepare(`
        INSERT OR REPLACE INTO spatial_features 
        (id, dataset, feature_data, minx, miny, maxx, maxy, centroid_lon, centroid_lat, area)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        featureId,
        dataset,
        JSON.stringify(feature),
        bbox.minX,
        bbox.minY,
        bbox.maxX,
        bbox.maxY,
        centroid.lon,
        centroid.lat,
        area
      ));

      // Insert into R-tree index if enabled
      if (SPATIAL_DB_CONFIG.USE_RTREE_INDEX) {
        statements.push(env.RIDING_DB.prepare(`
          INSERT OR REPLACE INTO spatial_rtree (id, minx, maxx, miny, maxy)
          VALUES (?, ?, ?, ?, ?)
        `).bind(featureId, bbox.minX, bbox.maxX, bbox.minY, bbox.maxY));
      }
    }

    await env.RIDING_DB.batch(statements);
    console.log(`Inserted ${features.length} features into spatial database for dataset: ${dataset}`);
    return true;
  } catch (error) {
    console.error('Failed to insert features into spatial database:', error);
    return false;
  }
}

// Query spatial database for point-in-polygon lookup
async function queryRidingFromDatabase(env: Env, dataset: string, lon: number, lat: number): Promise<GeoJSONFeature | null> {
  if (!SPATIAL_DB_CONFIG.ENABLED || !env.RIDING_DB) {
    return null;
  }

  try {
    // Use R-tree index for initial spatial filtering if available
    let query = '';
    let params: any[] = [];

    if (SPATIAL_DB_CONFIG.USE_RTREE_INDEX) {
      query = `
        SELECT sf.feature_data 
        FROM spatial_features sf
        JOIN spatial_rtree sr ON sf.id = sr.id
        WHERE sf.dataset = ? 
        AND sr.minx <= ? AND sr.maxx >= ?
        AND sr.miny <= ? AND sr.maxy >= ?
      `;
      params = [dataset, lon, lon, lat, lat];
    } else {
      query = `
        SELECT feature_data 
        FROM spatial_features 
        WHERE dataset = ? 
        AND minx <= ? AND maxx >= ?
        AND miny <= ? AND maxy >= ?
      `;
      params = [dataset, lon, lon, lat, lat];
    }

    const results = await env.RIDING_DB.prepare(query).bind(...params).all();

    // Perform precise point-in-polygon check on candidates
    for (const result of results.results) {
      const feature: GeoJSONFeature = JSON.parse(result.feature_data as string);
      if (isPointInPolygon(lon, lat, feature.geometry)) {
        return feature;
      }
    }

    return null;
  } catch (error) {
    console.error('Failed to query spatial database:', error);
    return null;
  }
}

// Get all features from database with pagination
async function getAllFeaturesFromDatabase(env: Env, dataset: string, limit: number = 100, offset: number = 0): Promise<{ features: GeoJSONFeature[]; total: number }> {
  if (!SPATIAL_DB_CONFIG.ENABLED || !env.RIDING_DB) {
    return { features: [], total: 0 };
  }

  try {
    // Get total count
    const countResult = await env.RIDING_DB.prepare(`
      SELECT COUNT(*) as total FROM spatial_features WHERE dataset = ?
    `).bind(dataset).first();

    const total = countResult?.total as number || 0;

    // Get features with pagination
    const results = await env.RIDING_DB.prepare(`
      SELECT feature_data 
      FROM spatial_features 
      WHERE dataset = ? 
      ORDER BY id
      LIMIT ? OFFSET ?
    `).bind(dataset, limit, offset).all();

    const features: GeoJSONFeature[] = results.results.map(result => 
      JSON.parse(result.feature_data as string)
    );

    return { features, total };
  } catch (error) {
    console.error('Failed to get features from spatial database:', error);
    return { features: [], total: 0 };
  }
}

// Calculate centroid of a geometry
function calculateCentroid(geometry: any): { lon: number; lat: number } {
  if (geometry.type === 'Point') {
    return { lon: geometry.coordinates[0] as number, lat: geometry.coordinates[1] as number };
  }
  
  if (geometry.type === 'Polygon') {
    // Simple centroid calculation for polygon
    const coords = geometry.coordinates[0] as number[][]; // Use exterior ring
    let lonSum = 0, latSum = 0;
    for (const coord of coords) {
      lonSum += coord[0] as number;
      latSum += coord[1] as number;
    }
    return { lon: lonSum / coords.length, lat: latSum / coords.length };
  }
  
  if (geometry.type === 'MultiPolygon') {
    // Calculate centroid of the largest polygon
    let largestPolygon = geometry.coordinates[0];
    let largestVertexCount = 0;
    
    for (const polygon of geometry.coordinates) {
      const vertexCount = polygon[0].length;
      if (vertexCount > largestVertexCount) {
        largestVertexCount = vertexCount;
        largestPolygon = polygon;
      }
    }
    
    // Simple centroid calculation for the largest polygon
    const coords = largestPolygon[0] as number[][]; // Use exterior ring
    let lonSum = 0, latSum = 0;
    for (const coord of coords) {
      lonSum += coord[0] as number;
      latSum += coord[1] as number;
    }
    return { lon: lonSum / coords.length, lat: latSum / coords.length };
  }
  
  // Default to (0, 0) for other geometry types
  return { lon: 0, lat: 0 };
}

// Sync GeoJSON data to spatial database
async function syncGeoJSONToDatabase(env: Env, dataset: string): Promise<boolean> {
  if (!SPATIAL_DB_CONFIG.ENABLED || !env.RIDING_DB) {
    return false;
  }

  try {
    console.log(`Starting sync of ${dataset} to spatial database...`);
    
    // Load GeoJSON data from R2
    const featureCollection = await loadGeo(env, dataset);
    
    // Initialize database if needed
    await initializeSpatialDatabase(env);
    
    // Clear existing data for this dataset
    await env.RIDING_DB.prepare(`DELETE FROM spatial_features WHERE dataset = ?`).bind(dataset).run();
    
    if (SPATIAL_DB_CONFIG.USE_RTREE_INDEX) {
      // Clear R-tree entries for this dataset
      const existingIds = await env.RIDING_DB.prepare(`
        SELECT id FROM spatial_features WHERE dataset = ?
      `).bind(dataset).all();
      
      for (const row of existingIds.results) {
        await env.RIDING_DB.prepare(`DELETE FROM spatial_rtree WHERE id = ?`).bind(row.id).run();
      }
    }
    
    // Insert features in batches
    const batchSize = SPATIAL_DB_CONFIG.BATCH_INSERT_SIZE;
    for (let i = 0; i < featureCollection.features.length; i += batchSize) {
      const batch = featureCollection.features.slice(i, i + batchSize);
      await insertFeaturesIntoDatabase(env, dataset, batch);
    }
    
    console.log(`Successfully synced ${featureCollection.features.length} features to spatial database`);
    return true;
  } catch (error) {
    console.error('Failed to sync GeoJSON to spatial database:', error);
    return false;
  }
}

// Douglas-Peucker line simplification
function simplifyLineString(coordinates: number[][], tolerance: number, maxVertices: number): number[][] {
  if (coordinates.length <= 2) {
    return coordinates;
  }
  
  // If we're already under the max vertices, return as is
  if (coordinates.length <= maxVertices) {
    return coordinates;
  }
  
  // Simple decimation for now - take every nth point
  const step = Math.ceil(coordinates.length / maxVertices);
  const simplified: number[][] = [];
  
  for (let i = 0; i < coordinates.length; i += step) {
    simplified.push(coordinates[i]);
  }
  
  // Always include the last point
  if (simplified[simplified.length - 1] !== coordinates[coordinates.length - 1]) {
    simplified.push(coordinates[coordinates.length - 1]);
  }
  
  return simplified;
}

// Handle spatial database requests
async function handleSpatialDatabaseRequest(request: Request, env: Env, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  
  try {
    // Initialize spatial database
    if (pathname === '/api/database/init') {
      if (request.method !== 'POST') {
        return badRequest('Method not allowed', 405);
      }
      
      const success = await initializeSpatialDatabase(env);
      
      return new Response(JSON.stringify({
        success,
        message: success ? 'Spatial database initialized successfully' : 'Failed to initialize spatial database',
        enabled: SPATIAL_DB_CONFIG.ENABLED,
        hasDatabase: !!env.RIDING_DB
      }), {
        headers: { "content-type": "application/json; charset=UTF-8" }
      });
    }
    
    // Sync GeoJSON data to database
    if (pathname === '/api/database/sync') {
      if (request.method !== 'POST') {
        return badRequest('Method not allowed', 405);
      }
      
      const dataset = url.searchParams.get('dataset') || 'federalridings-2024.geojson';
      const success = await syncGeoJSONToDatabase(env, dataset);
      
      return new Response(JSON.stringify({
        success,
        dataset,
        message: success ? `Dataset ${dataset} synced successfully` : `Failed to sync dataset ${dataset}`,
        enabled: SPATIAL_DB_CONFIG.ENABLED,
        hasDatabase: !!env.RIDING_DB
      }), {
        headers: { "content-type": "application/json; charset=UTF-8" }
      });
    }
    
    // Get database statistics
    if (pathname === '/api/database/stats') {
      if (request.method !== 'GET') {
        return badRequest('Method not allowed', 405);
      }
      
      if (!SPATIAL_DB_CONFIG.ENABLED || !env.RIDING_DB) {
        return new Response(JSON.stringify({
          enabled: false,
          message: 'Spatial database not enabled or configured'
        }), {
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
      }
      
      try {
        // Get table statistics
        const featuresCount = await env.RIDING_DB.prepare(`
          SELECT COUNT(*) as total FROM spatial_features
        `).first();
        
        const datasetStats = await env.RIDING_DB.prepare(`
          SELECT dataset, COUNT(*) as count 
          FROM spatial_features 
          GROUP BY dataset
        `).all();
        
        let rtreeCount = 0;
        if (SPATIAL_DB_CONFIG.USE_RTREE_INDEX) {
          const rtreeResult = await env.RIDING_DB.prepare(`
            SELECT COUNT(*) as total FROM spatial_rtree
          `).first();
          rtreeCount = rtreeResult?.total as number || 0;
        }
        
        return new Response(JSON.stringify({
          enabled: SPATIAL_DB_CONFIG.ENABLED,
          totalFeatures: featuresCount?.total || 0,
          rtreeEntries: rtreeCount,
          datasetStats: datasetStats.results,
          config: SPATIAL_DB_CONFIG
        }), {
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          error: 'Failed to get database statistics',
          message: error instanceof Error ? error.message : 'Unknown error'
        }), {
          status: 500,
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
      }
    }
    
    // Query database directly
    if (pathname === '/api/database/query') {
      if (request.method !== 'GET') {
        return badRequest('Method not allowed', 405);
      }
      
      const lon = parseFloat(url.searchParams.get('lon') || '');
      const lat = parseFloat(url.searchParams.get('lat') || '');
      const dataset = url.searchParams.get('dataset') || 'federalridings-2024.geojson';
      
      if (isNaN(lon) || isNaN(lat)) {
        return badRequest('Invalid coordinates. lon and lat are required.');
      }
      
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        return badRequest('Invalid coordinates. lon must be between -180 and 180, lat must be between -90 and 90.');
      }
      
      const result = await queryRidingFromDatabase(env, dataset, lon, lat);
      
      if (!result) {
        return new Response(JSON.stringify({
          error: 'No riding found for the given coordinates',
          coordinates: { lon, lat }
        }), {
          status: 404,
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
      }
      
      return new Response(JSON.stringify({
        riding: result.properties?.ENGLISH_NAME || result.properties?.NAME_EN || 'Unknown',
        properties: result.properties,
        coordinates: { lon, lat },
        source: 'database'
      }), {
        headers: { "content-type": "application/json; charset=UTF-8" }
      });
    }
    
    return badRequest('Invalid database endpoint', 404);
    
  } catch (error) {
    console.error('Spatial database request error:', error);
    return new Response(JSON.stringify({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { "content-type": "application/json; charset=UTF-8" }
    });
  }
}

// Handle boundary requests
async function handleBoundaryRequest(request: Request, env: Env, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  
  try {
    // Get boundary by coordinates
    if (pathname === '/api/boundaries/lookup') {
      if (request.method !== 'GET') {
        return badRequest('Method not allowed', 405);
      }
      
      const lon = parseFloat(url.searchParams.get('lon') || '');
      const lat = parseFloat(url.searchParams.get('lat') || '');
      const simplify = url.searchParams.get('simplify') !== 'false';
      const tolerance = parseFloat(url.searchParams.get('tolerance') || '0.001');
      const maxVertices = parseInt(url.searchParams.get('maxVertices') || '1000');
      
      if (isNaN(lon) || isNaN(lat)) {
        return badRequest('Invalid coordinates. lon and lat are required.');
      }
      
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        return badRequest('Invalid coordinates. lon must be between -180 and 180, lat must be between -90 and 90.');
      }
      
      const result = await getRidingBoundary(env, pathname, lon, lat, {
        simplify,
        tolerance,
        maxVertices
      });
      
      if (!result.geometry) {
        return new Response(JSON.stringify({
          error: 'No riding found for the given coordinates',
          coordinates: { lon, lat }
        }), {
          status: 404,
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
      }
      
      return new Response(JSON.stringify({
        geometry: result.geometry,
        properties: result.properties,
        coordinates: { lon, lat },
        options: { simplify, tolerance, maxVertices }
      }), {
        headers: { "content-type": "application/json; charset=UTF-8" }
      });
    }
    
    // Get boundary by riding ID
    if (pathname.startsWith('/api/boundaries/riding/')) {
      if (request.method !== 'GET') {
        return badRequest('Method not allowed', 405);
      }
      
      const ridingId = pathname.split('/')[4];
      if (!ridingId) {
        return badRequest('Riding ID is required');
      }
      
      const simplify = url.searchParams.get('simplify') !== 'false';
      const tolerance = parseFloat(url.searchParams.get('tolerance') || '0.001');
      const maxVertices = parseInt(url.searchParams.get('maxVertices') || '1000');
      
      const result = await getRidingBoundaryById(env, pathname, ridingId, {
        simplify,
        tolerance,
        maxVertices
      });
      
      if (!result.geometry) {
        return new Response(JSON.stringify({
          error: 'Riding not found',
          ridingId
        }), {
          status: 404,
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
      }
      
      return new Response(JSON.stringify({
        geometry: result.geometry,
        properties: result.properties,
        ridingId,
        options: { simplify, tolerance, maxVertices }
      }), {
        headers: { "content-type": "application/json; charset=UTF-8" }
      });
    }
    
    // Get all boundaries for a dataset
    if (pathname === '/api/boundaries/all') {
      if (request.method !== 'GET') {
        return badRequest('Method not allowed', 405);
      }
      
      const simplify = url.searchParams.get('simplify') !== 'false';
      const tolerance = parseFloat(url.searchParams.get('tolerance') || '0.001');
      const maxVertices = parseInt(url.searchParams.get('maxVertices') || '1000');
      const limit = parseInt(url.searchParams.get('limit') || '100');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      
      const result = await getAllRidingBoundaries(env, pathname, {
        simplify,
        tolerance,
        maxVertices,
        limit,
        offset
      });
      
      return new Response(JSON.stringify({
        features: result.features,
        total: result.total,
        limit,
        offset,
        hasMore: result.features.length === limit,
        options: { simplify, tolerance, maxVertices }
      }), {
        headers: { "content-type": "application/json; charset=UTF-8" }
      });
    }
    
    // Get boundary configuration
    if (pathname === '/api/boundaries/config') {
      if (request.method !== 'GET') {
        return badRequest('Method not allowed', 405);
      }
      
      return new Response(JSON.stringify({
        enabled: BOUNDARIES_CONFIG.ENABLED,
        cacheSimplifiedBoundaries: BOUNDARIES_CONFIG.CACHE_SIMPLIFIED_BOUNDARIES,
        defaultSimplificationTolerance: BOUNDARIES_CONFIG.DEFAULT_SIMPLIFICATION_TOLERANCE,
        minSimplificationTolerance: BOUNDARIES_CONFIG.MIN_SIMPLIFICATION_TOLERANCE,
        maxSimplificationTolerance: BOUNDARIES_CONFIG.MAX_SIMPLIFICATION_TOLERANCE,
        maxVertices: BOUNDARIES_CONFIG.MAX_VERTICES,
        cacheSize: simplifiedBoundariesCache.size,
        maxCacheSize: BOUNDARIES_CONFIG.MAX_CACHE_SIZE
      }), {
        headers: { "content-type": "application/json; charset=UTF-8" }
      });
    }
    
    return badRequest('Invalid boundary endpoint', 404);
    
  } catch (error) {
    console.error('Boundary request error:', error);
    return new Response(JSON.stringify({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { "content-type": "application/json; charset=UTF-8" }
    });
  }
}

// Circuit breaker implementation
interface CircuitBreakerState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failureCount: number;
  lastFailureTime: number;
  successCount: number;
}

class CircuitBreaker {
  private states = new Map<string, CircuitBreakerState>();
  private failureThreshold: number;
  private recoveryTimeout: number;
  private successThreshold: number;

  constructor(failureThreshold = 5, recoveryTimeout = 60000, successThreshold = 3) {
    this.failureThreshold = failureThreshold;
    this.recoveryTimeout = recoveryTimeout;
    this.successThreshold = successThreshold;
  }

  async execute<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const state = this.getState(key);
    
    if (state.state === 'OPEN') {
      if (Date.now() - state.lastFailureTime > this.recoveryTimeout) {
        state.state = 'HALF_OPEN';
        state.successCount = 0;
      } else {
        throw new Error(`Circuit breaker is OPEN for ${key}`);
      }
    }

    try {
      const result = await operation();
      this.onSuccess(key);
      return result;
  } catch (error) {
      this.onFailure(key);
      throw error;
    }
  }

  private getState(key: string): CircuitBreakerState {
    if (!this.states.has(key)) {
      this.states.set(key, {
        state: 'CLOSED',
        failureCount: 0,
        lastFailureTime: 0,
        successCount: 0
      });
    }
    return this.states.get(key)!;
  }

  private onSuccess(key: string): void {
    const state = this.getState(key);
    state.failureCount = 0;
    
    if (state.state === 'HALF_OPEN') {
      state.successCount++;
      if (state.successCount >= this.successThreshold) {
        state.state = 'CLOSED';
      }
    }
  }

  private onFailure(key: string): void {
    const state = this.getState(key);
    state.failureCount++;
    state.lastFailureTime = Date.now();
    
    if (state.failureCount >= this.failureThreshold) {
      state.state = 'OPEN';
    }
  }

  getStateInfo(key: string): CircuitBreakerState | null {
    return this.states.get(key) || null;
  }
}

// Create circuit breaker instances
const geocodingCircuitBreaker = new CircuitBreaker(3, 30000, 2); // 3 failures, 30s timeout, 2 successes to close
const r2CircuitBreaker = new CircuitBreaker(5, 60000, 3); // 5 failures, 60s timeout, 3 successes to close

// Metrics collection
interface Metrics {
  geocodingRequests: number;
  geocodingCacheHits: number;
  geocodingCacheMisses: number;
  geocodingSuccesses: number;
  geocodingFailures: number;
  geocodingCircuitBreakerTrips: number;
  r2Requests: number;
  r2CacheHits: number;
  r2CacheMisses: number;
  r2Successes: number;
  r2Failures: number;
  r2CircuitBreakerTrips: number;
  spatialIndexHits: number;
  spatialIndexMisses: number;
  totalLookupTime: number;
  totalGeocodingTime: number;
  totalR2Time: number;
  totalSpatialIndexTime: number;
  requestCount: number;
  errorCount: number;
}

const metrics: Metrics = {
  geocodingRequests: 0,
  geocodingCacheHits: 0,
  geocodingCacheMisses: 0,
  geocodingSuccesses: 0,
  geocodingFailures: 0,
  geocodingCircuitBreakerTrips: 0,
  r2Requests: 0,
  r2CacheHits: 0,
  r2CacheMisses: 0,
  r2Successes: 0,
  r2Failures: 0,
  r2CircuitBreakerTrips: 0,
  spatialIndexHits: 0,
  spatialIndexMisses: 0,
  totalLookupTime: 0,
  totalGeocodingTime: 0,
  totalR2Time: 0,
  totalSpatialIndexTime: 0,
  requestCount: 0,
  errorCount: 0
};

// Metrics helper functions
function incrementMetric(key: keyof Metrics, value: number = 1): void {
  metrics[key] += value;
}

function recordTiming(key: keyof Metrics, duration: number): void {
  metrics[key] += duration;
}

function getMetrics(): Metrics {
  return { ...metrics };
}

function resetMetrics(): void {
  Object.keys(metrics).forEach(key => {
    metrics[key as keyof Metrics] = 0;
  });
}

// Input validation and sanitization
interface ValidationResult {
  valid: boolean;
  sanitized?: QueryParams;
  error?: string;
}

// Sanitize string input
function sanitizeString(input: string | undefined, maxLength: number = 1000): string | undefined {
  if (!input) return undefined;
  
  // Remove null bytes and control characters
  let sanitized = input.replace(/[\x00-\x1F\x7F]/g, '');
  
  // Trim whitespace
  sanitized = sanitized.trim();
  
  // Limit length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }
  
  return sanitized.length > 0 ? sanitized : undefined;
}

// Validate and sanitize coordinates
function validateCoordinates(lat: number | undefined, lon: number | undefined): { valid: boolean; lat?: number; lon?: number; error?: string } {
  if (lat === undefined && lon === undefined) {
    return { valid: true };
  }
  
  if (lat === undefined || lon === undefined) {
    return { valid: false, error: "Both lat and lon must be provided together" };
  }
  
  // Check for valid coordinate ranges
  if (lat < -90 || lat > 90) {
    return { valid: false, error: "Latitude must be between -90 and 90" };
  }
  
  if (lon < -180 || lon > 180) {
    return { valid: false, error: "Longitude must be between -180 and 180" };
  }
  
  // Check for NaN or Infinity
  if (!isFinite(lat) || !isFinite(lon)) {
    return { valid: false, error: "Coordinates must be finite numbers" };
  }
  
  return { valid: true, lat, lon };
}

// Validate postal code format
function validatePostalCode(postal: string): { valid: boolean; sanitized?: string; error?: string } {
  if (!postal) return { valid: true };
  
  // Canadian postal code pattern: A1A 1A1 or A1A1A1
  const canadianPattern = /^[A-Za-z]\d[A-Za-z][\s]?\d[A-Za-z]\d$/;
  const sanitized = postal.replace(/\s+/g, '').toUpperCase();
  
  if (!canadianPattern.test(sanitized)) {
    return { valid: false, error: "Invalid Canadian postal code format" };
  }
  
  return { valid: true, sanitized: sanitized.substring(0, 3) + ' ' + sanitized.substring(3) };
}

// Validate and sanitize query parameters
function validateAndSanitizeQuery(query: QueryParams): ValidationResult {
  const sanitized: QueryParams = {};
  
  // Sanitize string inputs
  sanitized.address = sanitizeString(query.address, 500);
  sanitized.city = sanitizeString(query.city, 100);
  sanitized.state = sanitizeString(query.state, 100);
  sanitized.country = sanitizeString(query.country, 100);
  
  // Validate postal code
  if (query.postal) {
    const postalValidation = validatePostalCode(query.postal);
    if (!postalValidation.valid) {
      return { valid: false, error: postalValidation.error };
    }
    sanitized.postal = postalValidation.sanitized;
  }
  
  // Validate coordinates
  const coordValidation = validateCoordinates(query.lat, query.lon);
  if (!coordValidation.valid) {
    return { valid: false, error: coordValidation.error };
  }
  if (coordValidation.lat !== undefined && coordValidation.lon !== undefined) {
    sanitized.lat = coordValidation.lat;
    sanitized.lon = coordValidation.lon;
  }
  
  // Check that at least one location parameter is provided
  const hasLocation = sanitized.address || sanitized.postal || sanitized.city || 
                     sanitized.state || sanitized.country || 
                     (sanitized.lat !== undefined && sanitized.lon !== undefined);
  
  if (!hasLocation) {
    return { valid: false, error: "At least one location parameter must be provided" };
  }
  
  return { valid: true, sanitized };
}

// Validate request size
function validateRequestSize(request: Request): { valid: boolean; error?: string } {
  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    const maxSize = 1024 * 1024; // 1MB
    if (size > maxSize) {
      return { valid: false, error: `Request too large. Maximum size is ${maxSize} bytes` };
    }
  }
  return { valid: true };
}

// Rate limiting with enhanced tracking
const enhancedRateLimitStore: Map<string, { count: number; resetTime: number; blocked: boolean }> = new Map();

function checkEnhancedRateLimit(env: Env, clientId: string): { allowed: boolean; retryAfter?: number; reason?: string } {
  const rateLimit = env.RATE_LIMIT || DEFAULT_RATE_LIMIT;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  
  const current = enhancedRateLimitStore.get(clientId);
  if (!current || now > current.resetTime) {
    enhancedRateLimitStore.set(clientId, { count: 1, resetTime: now + windowMs, blocked: false });
    return { allowed: true };
  }
  
  if (current.blocked) {
    return { 
      allowed: false, 
      retryAfter: Math.ceil((current.resetTime - now) / 1000),
      reason: "Client temporarily blocked due to excessive requests"
    };
  }
  
  if (current.count >= rateLimit) {
    // Block client for the rest of the window
    current.blocked = true;
    return { 
      allowed: false, 
      retryAfter: Math.ceil((current.resetTime - now) / 1000),
      reason: "Rate limit exceeded"
    };
  }
  
  current.count++;
  return { allowed: true };
}

// Retry configuration
interface RetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  jitter: boolean;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelay: 1000, // 1 second
  maxDelay: 10000, // 10 seconds
  jitter: true
};

// Retry with exponential backoff
async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  context: string = 'operation'
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt === config.maxAttempts) {
        console.error(`${context} failed after ${config.maxAttempts} attempts:`, lastError.message);
        throw lastError;
      }
      
      // Calculate delay with exponential backoff
      const delay = Math.min(
        config.baseDelay * Math.pow(2, attempt - 1),
        config.maxDelay
      );
      
      // Add jitter to prevent thundering herd
      const jitteredDelay = config.jitter 
        ? delay + Math.random() * 1000 
        : delay;
      
      console.warn(`${context} attempt ${attempt} failed, retrying in ${Math.round(jitteredDelay)}ms:`, lastError.message);
      await new Promise(resolve => setTimeout(resolve, jitteredDelay));
    }
  }
  
  throw lastError!;
}

// Simple spatial index using bounding boxes for pre-filtering
interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface SpatialIndexEntry {
  feature: GeoJSONFeature;
  boundingBox: BoundingBox;
}

interface SpatialIndex {
  entries: SpatialIndexEntry[];
  boundingBox: BoundingBox;
}

// Calculate bounding box for a GeoJSON geometry
function calculateBoundingBox(geometry: GeoJSONGeometry): BoundingBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  const processCoordinates = (coords: number[][]) => {
    for (const coord of coords) {
      const [x, y] = coord;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  };
  
  if (geometry.type === "Polygon") {
    const coords = geometry.coordinates as number[][][];
    for (const ring of coords) {
      processCoordinates(ring);
    }
  } else if (geometry.type === "MultiPolygon") {
    const coords = geometry.coordinates as number[][][][];
    for (const polygon of coords) {
      for (const ring of polygon) {
        processCoordinates(ring);
      }
    }
  }
  
  return { minX, minY, maxX, maxY };
}

// Create spatial index for a FeatureCollection
function createSpatialIndex(featureCollection: GeoJSONFeatureCollection): SpatialIndex {
  const entries: SpatialIndexEntry[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  for (const feature of featureCollection.features) {
    const boundingBox = calculateBoundingBox(feature.geometry);
    entries.push({ feature, boundingBox });
    
    // Update overall bounding box
    minX = Math.min(minX, boundingBox.minX);
    minY = Math.min(minY, boundingBox.minY);
    maxX = Math.max(maxX, boundingBox.maxX);
    maxY = Math.max(maxY, boundingBox.maxY);
  }
  
  return {
    entries,
    boundingBox: { minX, minY, maxX, maxY }
  };
}

// Check if point is within bounding box
function isPointInBoundingBox(lon: number, lat: number, boundingBox: BoundingBox): boolean {
  return lon >= boundingBox.minX && lon <= boundingBox.maxX &&
         lat >= boundingBox.minY && lat <= boundingBox.maxY;
}

// Find candidate features using spatial index
function findCandidateFeatures(lon: number, lat: number, spatialIndex: SpatialIndex): GeoJSONFeature[] {
  const candidates: GeoJSONFeature[] = [];
  
  for (const entry of spatialIndex.entries) {
    if (isPointInBoundingBox(lon, lat, entry.boundingBox)) {
      candidates.push(entry.feature);
    }
  }
  
  return candidates;
}

// Geocoding cache functions
interface GeocodingCacheEntry {
  lon: number;
  lat: number;
  timestamp: number;
  provider: string;
}

// Generate cache key for geocoding request
function generateGeocodingCacheKey(query: QueryParams, provider: string): string {
  const normalizedQuery = {
    address: query.address?.toLowerCase().trim(),
    postal: query.postal?.toLowerCase().trim().replace(/\s+/g, ''),
    city: query.city?.toLowerCase().trim(),
    state: query.state?.toLowerCase().trim(),
    country: query.country?.toLowerCase().trim()
  };
  
  return `geocoding:${provider}:${JSON.stringify(normalizedQuery)}`;
}

// Get geocoding result from cache
async function getCachedGeocoding(env: Env, cacheKey: string): Promise<{ lon: number; lat: number } | null> {
  if (!env.GEOCODING_CACHE) return null;
  
  try {
    const cached = await env.GEOCODING_CACHE.get(cacheKey, 'json') as GeocodingCacheEntry | null;
    if (!cached) return null;
    
    // Check if cache entry is still valid (24 hours TTL)
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    if (Date.now() - cached.timestamp > maxAge) {
      await env.GEOCODING_CACHE.delete(cacheKey);
      return null;
    }
    
    return { lon: cached.lon, lat: cached.lat };
  } catch (error) {
    console.warn('Failed to get cached geocoding result:', error);
    return null;
  }
}

// Store geocoding result in cache
async function setCachedGeocoding(env: Env, cacheKey: string, lon: number, lat: number, provider: string): Promise<void> {
  if (!env.GEOCODING_CACHE) return;
  
  try {
    const entry: GeocodingCacheEntry = {
      lon,
      lat,
      timestamp: Date.now(),
      provider
    };
    
    // Store with 24 hour TTL
    await env.GEOCODING_CACHE.put(cacheKey, JSON.stringify(entry), {
      expirationTtl: 24 * 60 * 60 // 24 hours in seconds
    });
  } catch (error) {
    console.warn('Failed to cache geocoding result:', error);
  }
}

// Timeout configuration (in milliseconds)
const DEFAULT_TIMEOUTS: TimeoutConfig = {
  geocoding: 10000,  // 10 seconds for geocoding
  lookup: 5000,      // 5 seconds for riding lookup
  batch: 30000,      // 30 seconds for batch processing
  total: 60000       // 60 seconds total request timeout
};

// Rate limiting configuration
const DEFAULT_RATE_LIMIT = 100; // requests per minute
const DEFAULT_BATCH_SIZE = 50;  // max requests per batch

// Rate limiting storage
const rateLimitStore: Map<string, { count: number; resetTime: number }> = new Map();

// Timeout wrapper function
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${operation} timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  
  return Promise.race([promise, timeoutPromise]);
}

// Rate limiting check
function checkRateLimit(env: Env, clientId: string): boolean {
  const rateLimit = env.RATE_LIMIT || DEFAULT_RATE_LIMIT;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  
  const current = rateLimitStore.get(clientId);
  if (!current || now > current.resetTime) {
    rateLimitStore.set(clientId, { count: 1, resetTime: now + windowMs });
    return true;
  }
  
  if (current.count >= rateLimit) {
    return false;
  }
  
  current.count++;
  return true;
}

// Get client identifier for rate limiting
function getClientId(request: Request): string {
  // Use IP address or API key for rate limiting
  const apiKey = request.headers.get("X-Google-API-Key");
  if (apiKey) return `api:${apiKey}`;
  
  const cfConnectingIp = request.headers.get("CF-Connecting-IP");
  const xForwardedFor = request.headers.get("X-Forwarded-For");
  const ip = cfConnectingIp || xForwardedFor?.split(',')[0] || "unknown";
  return `ip:${ip}`;
}

async function loadGeo(env: Env, key: string): Promise<GeoJSONFeatureCollection> {
  const startTime = Date.now();
  incrementMetric('r2Requests');
  
  // Check LRU cache first
  const cached = geoCacheLRU.get(key);
  if (cached) {
    incrementMetric('r2CacheHits');
    recordTiming('totalR2Time', Date.now() - startTime);
    return cached;
  }
  
  // Fallback to old cache for backward compatibility
  const oldCached = geoCache.get(key);
  if (oldCached) {
    incrementMetric('r2CacheHits');
    geoCacheLRU.set(key, oldCached);
    recordTiming('totalR2Time', Date.now() - startTime);
    return oldCached;
  }
  
  incrementMetric('r2CacheMisses');
  
  // Use circuit breaker and retry for R2 operations
  let json: GeoJSONFeatureCollection;
  try {
    json = await r2CircuitBreaker.execute(`r2:${key}`, async () => {
      return await withRetry(async () => {
        const obj = await env.RIDINGS.get(key);
        if (!obj) throw new Error(`GeoJSON not found in R2: ${key}`);
        const text = await obj.text();
        const parsed = JSON.parse(text);
        
        // Basic shape check
        if (!parsed || parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
          throw new Error(`Invalid GeoJSON FeatureCollection: ${key}`);
        }
        
        return parsed;
      }, DEFAULT_RETRY_CONFIG, `R2 load ${key}`);
    });
    
    incrementMetric('r2Successes');
  } catch (error) {
    incrementMetric('r2Failures');
    if (error instanceof Error && error.message.includes('Circuit breaker is OPEN')) {
      incrementMetric('r2CircuitBreakerTrips');
    }
    throw error;
  }
  
  // Store in both caches for backward compatibility
  geoCache.set(key, json);
  geoCacheLRU.set(key, json);
  
  // Create and cache spatial index
  const spatialIndex = createSpatialIndex(json);
  spatialIndexCache.set(key, spatialIndex);
  spatialIndexCacheLRU.set(key, spatialIndex);
  
  recordTiming('totalR2Time', Date.now() - startTime);
  return json;
}

function pickDataset(pathname: string): { r2Key: string } {
  // Map routes to R2 object keys
  if (pathname === "/api/qc") return { r2Key: "quebecridings-2025.geojson" };
  if (pathname === "/api/on") return { r2Key: "ontarioridings-2022.geojson" };
  // default federal
  return { r2Key: "federalridings-2024.geojson" };
}

function parseQuery(request: Request): { query: QueryParams; validation: ValidationResult } {
  const url = new URL(request.url);
  const q = url.searchParams;
  
  // Parse raw query parameters
  const rawQuery: QueryParams = {
    address: q.get("address") || undefined,
    postal: q.get("postal") || q.get("postal_code") || undefined,
    city: q.get("city") || undefined,
    state: q.get("state") || q.get("province") || undefined,
    country: q.get("country") || undefined,
    lat: q.get("lat") ? Number(q.get("lat")) : undefined,
    lon: q.get("lon") || q.get("lng") || q.get("long") ? Number(q.get("lon") || q.get("lng") || q.get("long")) : undefined
  };
  
  // Validate and sanitize
  const validation = validateAndSanitizeQuery(rawQuery);
  
  return { query: rawQuery, validation };
}

async function geocodeIfNeeded(env: Env, qp: QueryParams, request?: Request): Promise<{ lon: number; lat: number; }> {
  if (typeof qp.lat === "number" && typeof qp.lon === "number") {
    return { lon: qp.lon, lat: qp.lat };
  }
  const query = qp.address || qp.postal || qp.city || qp.state || qp.country;
  if (!query) throw new Error("Missing location: provide lat/lon or address/postal");

  const timeoutMs = env.BATCH_TIMEOUT || DEFAULT_TIMEOUTS.geocoding;
  
  const geocodePromise = (async () => {
    const startTime = Date.now();
    incrementMetric('geocodingRequests');
    
    const provider = (env.GEOCODER || "nominatim").toLowerCase();
    
    // Check cache first
      const cacheKey = generateGeocodingCacheKey(qp, provider);
      const cached = await getCachedGeocoding(env, cacheKey);
      if (cached) {
        incrementMetric('geocodingCacheHits');
        recordTiming('totalGeocodingTime', Date.now() - startTime);
        return cached;
    }
    
    incrementMetric('geocodingCacheMisses');
    
    // Use circuit breaker and retry for geocoding
    let result: { lon: number; lat: number };
    try {
      result = await geocodingCircuitBreaker.execute(`geocoding:${provider}`, async () => {
        return await withRetry(async () => {
          let geocodeResult: { lon: number; lat: number };
    
    if (provider === "google") {
    // Check for Google API key in header first, then fall back to environment variable
    const headerKey = request?.headers.get("X-Google-API-Key");
    const key = headerKey || env.GOOGLE_MAPS_KEY;
    if (!key) throw new Error("Google API key not provided. Set X-Google-API-Key header or configure GOOGLE_MAPS_KEY environment variable");
    const params = new URLSearchParams({ key });
    // Prefer structured components when available
    const components: string[] = [];
    if (qp.postal) components.push(`postal_code:${qp.postal}`);
    if (qp.city) components.push(`locality:${qp.city}`);
    if (qp.state) components.push(`administrative_area:${qp.state}`);
    if (qp.country) components.push(`country:${qp.country}`);
    if (components.length) params.set("components", components.join("|"));
    if (qp.address) params.set("address", qp.address);

    const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;
    const resp = await fetch(url, { headers: { "User-Agent": "riding-lookup/1.0" } });
    if (!resp.ok) throw new Error(`Google error: ${resp.status}`);
    const data = await resp.json() as GoogleGeocodeResponse;
    if (data.status !== "OK" || !data.results?.length) throw new Error("No results from Google");
    const loc = data.results[0].geometry.location;
          geocodeResult = { lon: loc.lng, lat: loc.lat };
  } else if (provider === "mapbox") {
    const token = env.MAPBOX_TOKEN;
    if (!token) throw new Error("MAPBOX_TOKEN not configured");
          const resp = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?limit=1&proximity=ca&access_token=${token}`, {
      headers: { "User-Agent": "riding-lookup/1.0" }
    });
    if (!resp.ok) throw new Error(`Mapbox error: ${resp.status}`);
    const data = await resp.json() as MapboxResponse;
    const feat = data?.features?.[0];
    if (!feat?.center) throw new Error("No results from Mapbox");
          geocodeResult = { lon: feat.center[0], lat: feat.center[1] };
  } else {
    // Default to Nominatim (OpenStreetMap)
    const nominatimParams = new URLSearchParams({ format: "jsonv2", limit: "1", country: "canada" });
    if (qp.address) nominatimParams.set("street", qp.address);
    if (qp.city) nominatimParams.set("city", qp.city);
    if (qp.state) nominatimParams.set("state", qp.state);
    if (qp.country) nominatimParams.set("country", qp.country);
    if (qp.postal) nominatimParams.set("postalcode", qp.postal);
    // Fallback free-form
    if (![qp.address, qp.city, qp.state, qp.country, qp.postal].some(Boolean)) {
            nominatimParams.set("q", query);
    }
    console.log(nominatimParams.toString());
    const nominatimUrl = `https://nominatim.openstreetmap.org/search?${nominatimParams.toString()}`;
    const resp = await fetch(nominatimUrl, { headers: { "User-Agent": "riding-lookup/1.0" } });
    if (!resp.ok) throw new Error(`Nominatim error: ${resp.status}`);
    const results = await resp.json() as NominatimResult[];
    const first = results?.[0];
    if (!first) throw new Error("No results from Nominatim");
          geocodeResult = { lon: Number(first.lon), lat: Number(first.lat) };
        }
        
          return geocodeResult;
        }, DEFAULT_RETRY_CONFIG, `Geocoding ${provider}`);
      });
      
      incrementMetric('geocodingSuccesses');
  } catch (error) {
      incrementMetric('geocodingFailures');
      if (error instanceof Error && error.message.includes('Circuit breaker is OPEN')) {
        incrementMetric('geocodingCircuitBreakerTrips');
      }
    throw error;
  }
    
    // Cache the result
    await setCachedGeocoding(env, cacheKey, result.lon, result.lat, provider);
    
    recordTiming('totalGeocodingTime', Date.now() - startTime);
    return result;
  })();

  return withTimeout(geocodePromise, timeoutMs, "Geocoding");
}

function featurePropertiesIfContains(ridingFeature: GeoJSONFeature, lon: number, lat: number): Record<string, unknown> | null {
  const geom = ridingFeature?.geometry;
  if (!geom) return null;
  if (isPointInPolygon(lon, lat, geom)) {
    return ridingFeature?.properties || {};
  }
  return null;
}

async function lookupRiding(env: Env, pathname: string, lon: number, lat: number): Promise<LookupResult> {
  const timeoutMs = env.BATCH_TIMEOUT || DEFAULT_TIMEOUTS.lookup;
  
  const lookupPromise = (async () => {
    const { r2Key } = pickDataset(pathname);
    
    // Try spatial database first if enabled
    if (SPATIAL_DB_CONFIG.ENABLED && env.RIDING_DB) {
      try {
        const dbResult = await queryRidingFromDatabase(env, r2Key, lon, lat);
        if (dbResult) {
          return {
            riding: dbResult.properties?.ENGLISH_NAME || dbResult.properties?.NAME_EN || 'Unknown',
            properties: dbResult.properties || {},
            source: 'database'
          };
        }
      } catch (error) {
        console.warn('Database lookup failed, falling back to spatial index:', error);
      }
    }
    
    // Check LRU cache first
    let spatialIndex = spatialIndexCacheLRU.get(r2Key);
    if (!spatialIndex) {
      // Fallback to old cache
      spatialIndex = spatialIndexCache.get(r2Key);
      if (spatialIndex) {
        spatialIndexCacheLRU.set(r2Key, spatialIndex);
      }
    }
    
    if (!spatialIndex) {
        // Load GeoJSON to create spatial index
        await loadGeo(env, r2Key);
        spatialIndex = spatialIndexCacheLRU.get(r2Key) || spatialIndexCache.get(r2Key);
        if (!spatialIndex) throw new Error(`Failed to create spatial index for ${r2Key}`);
    }
    
    return lookupRidingWithIndex(spatialIndex, lon, lat);
  })();

  return withTimeout(lookupPromise, timeoutMs, "Riding lookup");
}

function lookupRidingWithIndex(spatialIndex: SpatialIndex, lon: number, lat: number): LookupResult {
  const startTime = Date.now();
  
  // First check if point is within the overall bounding box
  if (!isPointInBoundingBox(lon, lat, spatialIndex.boundingBox)) {
    incrementMetric('spatialIndexHits');
    recordTiming('totalSpatialIndexTime', Date.now() - startTime);
    return { properties: null };
  }
  
  // Find candidate features using spatial index
  const candidates = findCandidateFeatures(lon, lat, spatialIndex);
  
  if (candidates.length === 0) {
    incrementMetric('spatialIndexHits');
    recordTiming('totalSpatialIndexTime', Date.now() - startTime);
    return { properties: null };
  }
  
  incrementMetric('spatialIndexMisses');
  
  // Only test point-in-polygon for candidates
  for (const feat of candidates) {
    const props = featurePropertiesIfContains(feat, lon, lat);
    if (props) {
      recordTiming('totalSpatialIndexTime', Date.now() - startTime);
      return { properties: props };
    }
  }
  
  recordTiming('totalSpatialIndexTime', Date.now() - startTime);
  return { properties: null };
}

function badRequest(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" }
  });
}

function checkBasicAuth(request: Request, env: Env): boolean {
  // If BASIC_AUTH is not configured, skip authentication
  if (!env.BASIC_AUTH) return true;
  
  // If user provides their own Google API key, bypass basic auth
  const googleApiKey = request.headers.get("X-Google-API-Key");
  if (googleApiKey) return true;
  
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return false;
  }
  
  try {
    const encoded = authHeader.substring(6); // Remove "Basic " prefix
    const decoded = atob(encoded);
    return decoded === env.BASIC_AUTH;
  } catch {
    return false;
  }
}

function unauthorizedResponse() {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { 
      "content-type": "application/json; charset=UTF-8",
      "WWW-Authenticate": "Basic realm=\"Riding Lookup API\""
    }
  });
}

function rateLimitExceededResponse() {
  return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
    status: 429,
    headers: { 
      "content-type": "application/json; charset=UTF-8",
      "Retry-After": "60"
    }
  });
}

// Queue processing functions
async function processBatchLookup(env: Env, requests: BatchLookupRequest[]): Promise<BatchLookupResponse[]> {
  const results: BatchLookupResponse[] = [];
  const batchSize = env.BATCH_SIZE || DEFAULT_BATCH_SIZE;
  
  // Process requests in chunks to avoid overwhelming the system
  for (let i = 0; i < requests.length; i += batchSize) {
    const chunk = requests.slice(i, i + batchSize);
    const chunkPromises = chunk.map(async (req) => {
      const startTime = Date.now();
      try {
        const { lon, lat } = await geocodeIfNeeded(env, req.query);
        const result = await lookupRiding(env, req.pathname, lon, lat);
        const processingTime = Date.now() - startTime;
        
        return {
          id: req.id,
          query: req.query,
          point: { lon, lat },
          properties: result.properties,
          processingTime
        } as BatchLookupResponse;
      } catch (error) {
        const processingTime = Date.now() - startTime;
        return {
          id: req.id,
          query: req.query,
          properties: null,
          error: error instanceof Error ? error.message : "Unknown error",
          processingTime
        } as BatchLookupResponse;
      }
    });
    
    const chunkResults = await Promise.all(chunkPromises);
    results.push(...chunkResults);
  }
  
  return results;
}

// Queue-based batch processing using Durable Objects
async function submitBatchToQueue(env: Env, requests: BatchLookupRequest[]): Promise<{ batchId: string; status: string }> {
  if (!env.QUEUE_MANAGER) {
    throw new Error("Queue manager not configured");
  }

  const queueManagerId = env.QUEUE_MANAGER.idFromName("main-queue");
  const queueManager = env.QUEUE_MANAGER.get(queueManagerId);
  
  const response = await queueManager.fetch(new Request("https://queue.local/queue/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests })
  }));

  if (!response.ok) {
    const error = await response.json() as { error?: string };
    throw new Error(error.error || "Failed to submit batch to queue");
  }

  return await response.json();
}

async function getBatchStatus(env: Env, batchId: string): Promise<any> {
  if (!env.QUEUE_MANAGER) {
    throw new Error("Queue manager not configured");
  }

  const queueManagerId = env.QUEUE_MANAGER.idFromName("main-queue");
  const queueManager = env.QUEUE_MANAGER.get(queueManagerId);
  
  const response = await queueManager.fetch(new Request(`https://queue.local/queue/status?batchId=${batchId}`));
  
  if (!response.ok) {
    const error = await response.json() as { error?: string };
    throw new Error(error.error || "Failed to get batch status");
  }

  return await response.json();
}

async function processQueueJobs(env: Env, maxJobs: number = 10): Promise<any> {
  if (!env.QUEUE_MANAGER) {
    throw new Error("Queue manager not configured");
  }

  const queueManagerId = env.QUEUE_MANAGER.idFromName("main-queue");
  const queueManager = env.QUEUE_MANAGER.get(queueManagerId);
  
  const response = await queueManager.fetch(new Request("https://queue.local/queue/process", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxJobs })
  }));
  
  if (!response.ok) {
    const error = await response.json() as { error?: string };
    throw new Error(error.error || "Failed to process queue jobs");
  }

  return await response.json();
}

async function getQueueStats(env: Env): Promise<any> {
  if (!env.QUEUE_MANAGER) {
    throw new Error("Queue manager not configured");
  }

  const queueManagerId = env.QUEUE_MANAGER.idFromName("main-queue");
  const queueManager = env.QUEUE_MANAGER.get(queueManagerId);
  
  const response = await queueManager.fetch(new Request("https://queue.local/queue/stats"));
  
  if (!response.ok) {
    const error = await response.json() as { error?: string };
    throw new Error(error.error || "Failed to get queue stats");
  }

  return await response.json();
}

// Generate unique batch job ID
function generateBatchId(): string {
  return `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Validate batch request
function validateBatchRequest(body: any): { valid: boolean; requests?: BatchLookupRequest[]; error?: string } {
  // Support both old format { requests: [...] } and new format { endpoint: '/api', queries: [...] }
  if (body.endpoint && Array.isArray(body.queries)) {
    // New format: { endpoint: '/api', queries: [...] }
    if (!body.endpoint || typeof body.endpoint !== 'string') {
      return { valid: false, error: "Invalid endpoint. Expected string." };
    }
    
    if (!['/api', '/api/qc', '/api/on'].includes(body.endpoint)) {
      return { valid: false, error: `Invalid endpoint. Must be one of: /api, /api/qc, /api/on` };
    }
    
    if (!Array.isArray(body.queries) || body.queries.length === 0) {
      return { valid: false, error: "Invalid queries. Expected non-empty array." };
    }
    
    const requests: BatchLookupRequest[] = [];
    const maxBatchSize = DEFAULT_BATCH_SIZE * 2; // Allow larger batches for batch endpoint
    
    if (body.queries.length > maxBatchSize) {
      return { valid: false, error: `Too many queries. Maximum ${maxBatchSize} queries per batch.` };
    }
    
    for (let i = 0; i < body.queries.length; i++) {
      const query = body.queries[i];
      if (!query || typeof query !== 'object') {
        return { valid: false, error: `Invalid query at index ${i}. Expected object.` };
      }
      
      if (!query.query || typeof query.query !== 'object') {
        return { valid: false, error: `Invalid query.query at index ${i}. Expected object.` };
      }
      
      requests.push({
        id: query.id || `req_${i}`,
        query: query.query,
        pathname: body.endpoint
      });
    }
    
    return { valid: true, requests };
  } else if (Array.isArray(body.requests)) {
    // Old format: { requests: [...] }
    const requests: BatchLookupRequest[] = [];
    const maxBatchSize = DEFAULT_BATCH_SIZE * 2; // Allow larger batches for batch endpoint
    
    if (body.requests.length > maxBatchSize) {
      return { valid: false, error: `Too many requests. Maximum ${maxBatchSize} requests per batch.` };
    }
    
    for (let i = 0; i < body.requests.length; i++) {
      const req = body.requests[i];
      if (!req || typeof req !== 'object') {
        return { valid: false, error: `Invalid request at index ${i}. Expected object.` };
      }
      
      if (!req.query || typeof req.query !== 'object') {
        return { valid: false, error: `Invalid query at index ${i}. Expected object.` };
      }
      
      if (!req.pathname || typeof req.pathname !== 'string') {
        return { valid: false, error: `Invalid pathname at index ${i}. Expected string.` };
      }
      
      if (!['/api', '/api/qc', '/api/on'].includes(req.pathname)) {
        return { valid: false, error: `Invalid pathname at index ${i}. Must be one of: /api, /api/qc, /api/on` };
      }
      
      requests.push({
        id: req.id || `req_${i}`,
        query: req.query,
        pathname: req.pathname
      });
    }
    
    return { valid: true, requests };
  } else {
    return { valid: false, error: "Invalid request format. Expected { endpoint: '/api', queries: [...] } or { requests: [...] }" };
  }
}

function createOpenAPISpec(baseUrl: string) {
  return {
    openapi: "3.0.0",
    info: {
      title: "Riding Lookup API",
      description: "Find Canadian federal, provincial, and territorial ridings by location. Supports multiple geocoding providers including Google Maps (BYOK), Mapbox, and Nominatim. Features Google Maps batch geocoding for optimal performance and cost efficiency. Built on Cloudflare Workers for global edge performance.",
      version: "1.0.0",
      contact: {
        name: "Riding Lookup API",
        email: "support@example.com"
      },
      license: {
        name: "MIT"
      }
    },
    servers: [
      {
        url: baseUrl,
        description: "Production server"
      }
    ],
    security: [
      {
        "BasicAuth": []
      },
      {
        "GoogleAPIKey": []
      }
    ],
    components: {
      securitySchemes: {
        "BasicAuth": {
          type: "http",
          scheme: "basic",
          description: "Basic authentication using username and password"
        },
        "GoogleAPIKey": {
          type: "apiKey",
          in: "header",
          name: "X-Google-API-Key",
          description: "Google Maps API key for BYOK (Bring Your Own Key) authentication. Bypasses basic auth and provides unlimited requests with enhanced geocoding accuracy."
        }
      }
    },
    paths: {
      "/api": {
        get: {
          summary: "Lookup Federal Riding",
          description: "Find the federal electoral district for any Canadian location. Supports geocoding via address, postal code, coordinates, or structured location components. Returns comprehensive riding information including district number, name, and administrative details.",
          operationId: "lookupFederalRiding",
          tags: ["Federal Ridings"],
          parameters: [
            {
              name: "address",
              in: "query",
              description: "Full address to geocode",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "postal",
              in: "query",
              description: "Postal code",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "lat",
              in: "query",
              description: "Latitude",
              required: false,
              schema: { type: "number", format: "float" }
            },
            {
              name: "lon",
              in: "query",
              description: "Longitude",
              required: false,
              schema: { type: "number", format: "float" }
            },
            {
              name: "city",
              in: "query",
              description: "City name",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "state",
              in: "query",
              description: "Province or state",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "country",
              in: "query",
              description: "Country",
              required: false,
              schema: { type: "string" }
            }
          ],
          responses: {
            "200": {
              description: "Successful lookup",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      query: { type: "object" },
                      point: {
                        type: "object",
                        properties: {
                          lon: { type: "number" },
                          lat: { type: "number" }
                        }
                      },
                      properties: { type: "object" }
                    }
                  }
                }
              }
            },
            "400": {
              description: "Bad request",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      error: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/qc": {
        get: {
          summary: "Lookup Quebec riding",
          description: "Find the Quebec provincial riding for a given location",
          parameters: [
            {
              name: "address",
              in: "query",
              description: "Full address to geocode",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "postal",
              in: "query",
              description: "Postal code",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "lat",
              in: "query",
              description: "Latitude",
              required: false,
              schema: { type: "number", format: "float" }
            },
            {
              name: "lon",
              in: "query",
              description: "Longitude",
              required: false,
              schema: { type: "number", format: "float" }
            },
            {
              name: "city",
              in: "query",
              description: "City name",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "state",
              in: "query",
              description: "Province or state",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "country",
              in: "query",
              description: "Country",
              required: false,
              schema: { type: "string" }
            }
          ],
          responses: {
            "200": {
              description: "Successful lookup",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      query: { type: "object" },
                      point: {
                        type: "object",
                        properties: {
                          lon: { type: "number" },
                          lat: { type: "number" }
                        }
                      },
                      properties: { type: "object" }
                    }
                  }
                }
              }
            },
            "400": {
              description: "Bad request",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      error: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/on": {
        get: {
          summary: "Lookup Ontario riding",
          description: "Find the Ontario provincial riding for a given location",
          parameters: [
            {
              name: "address",
              in: "query",
              description: "Full address to geocode",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "postal",
              in: "query",
              description: "Postal code",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "lat",
              in: "query",
              description: "Latitude",
              required: false,
              schema: { type: "number", format: "float" }
            },
            {
              name: "lon",
              in: "query",
              description: "Longitude",
              required: false,
              schema: { type: "number", format: "float" }
            },
            {
              name: "city",
              in: "query",
              description: "City name",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "state",
              in: "query",
              description: "Province or state",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "country",
              in: "query",
              description: "Country",
              required: false,
              schema: { type: "string" }
            }
          ],
          responses: {
            "200": {
              description: "Successful lookup",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      query: { type: "object" },
                      point: {
                        type: "object",
                        properties: {
                          lon: { type: "number" },
                          lat: { type: "number" }
                        }
                      },
                      properties: { type: "object" }
                    }
                  }
                }
              }
            },
            "400": {
              description: "Bad request",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      error: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/batch": {
        post: {
          summary: "Batch Riding Lookup (Immediate)",
          description: "Process multiple riding lookups immediately in a single request with Google Maps batch geocoding optimization. Supports up to 100 requests per batch with automatic batching (10 addresses per Google API call), timeout protection, and rate limiting. Significantly faster and more cost-effective than individual requests.",
          operationId: "batchLookup",
          tags: ["Batch Operations"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    endpoint: {
                      type: "string",
                      enum: ["/api", "/api/qc", "/api/on"],
                      description: "API endpoint to use for all lookups (recommended format)"
                    },
                    queries: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: {
                            type: "string",
                            description: "Optional unique identifier for this request"
                          },
                          query: {
                            type: "object",
                            properties: {
                              address: { type: "string" },
                              postal: { type: "string" },
                              lat: { type: "number" },
                              lon: { type: "number" },
                              city: { type: "string" },
                              state: { type: "string" },
                              country: { type: "string" }
                            }
                          }
                        },
                        required: ["query"]
                      },
                      maxItems: 100
                    },
                    requests: {
                      type: "array",
                      description: "Legacy format - use endpoint + queries instead",
                      items: {
                        type: "object",
                        properties: {
                          id: {
                            type: "string",
                            description: "Optional unique identifier for this request"
                          },
                          pathname: {
                            type: "string",
                            enum: ["/api", "/api/qc", "/api/on"],
                            description: "API endpoint to use for lookup"
                          },
                          query: {
                            type: "object",
                            properties: {
                              address: { type: "string" },
                              postal: { type: "string" },
                              lat: { type: "number" },
                              lon: { type: "number" },
                              city: { type: "string" },
                              state: { type: "string" },
                              country: { type: "string" }
                            }
                          }
                        },
                        required: ["pathname", "query"]
                      },
                      maxItems: 100
                    }
                  },
                  oneOf: [
                    { required: ["endpoint", "queries"] },
                    { required: ["requests"] }
                  ]
                }
              }
            }
          },
          responses: {
            "200": {
              description: "Batch processing completed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      batchId: { type: "string" },
                      totalRequests: { type: "number" },
                      successfulRequests: { type: "number" },
                      failedRequests: { type: "number" },
                      totalProcessingTime: { type: "number" },
                      results: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            query: { type: "object" },
                            point: {
                              type: "object",
                              properties: {
                                lon: { type: "number" },
                                lat: { type: "number" }
                              }
                            },
                            properties: { type: "object" },
                            error: { type: "string" },
                            processingTime: { type: "number" }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            "400": {
              description: "Bad request",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      error: { type: "string" }
                    }
                  }
                }
              }
            },
            "429": {
              description: "Rate limit exceeded",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      error: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/queue/submit": {
        post: {
          summary: "Submit Batch to Queue",
          description: "Submit a batch of riding lookups to the persistent queue for asynchronous processing. Returns immediately with batch ID for status tracking.",
          operationId: "submitBatchToQueue",
          tags: ["Queue Operations"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    requests: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          id: { type: "string" },
                          pathname: { type: "string", enum: ["/api", "/api/qc", "/api/on"] },
                          query: { type: "object" }
                        },
                        required: ["pathname", "query"]
                      }
                    }
                  },
                  required: ["requests"]
                }
              }
            }
          },
          responses: {
            "200": {
              description: "Batch submitted successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      batchId: { type: "string" },
                      totalJobs: { type: "number" },
                      status: { type: "string" },
                      message: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/queue/status": {
        get: {
          summary: "Get Batch Status",
          description: "Check the status of a submitted batch job including completion progress and results.",
          operationId: "getBatchStatus",
          tags: ["Queue Operations"],
          parameters: [
            {
              name: "batchId",
              in: "query",
              required: true,
              schema: { type: "string" }
            }
          ],
          responses: {
            "200": {
              description: "Batch status retrieved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      status: { type: "string", enum: ["pending", "processing", "completed", "failed", "partially_completed"] },
                      totalJobs: { type: "number" },
                      completedJobs: { type: "number" },
                      failedJobs: { type: "number" },
                      createdAt: { type: "number" },
                      completedAt: { type: "number" },
                      results: { type: "array" },
                      errors: { type: "array" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/queue/stats": {
        get: {
          summary: "Get Queue Statistics",
          description: "Get comprehensive statistics about the queue including job counts, processing times, and success rates.",
          operationId: "getQueueStats",
          tags: ["Queue Operations"],
          responses: {
            "200": {
              description: "Queue statistics retrieved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      totalJobs: { type: "number" },
                      pendingJobs: { type: "number" },
                      processingJobs: { type: "number" },
                      completedJobs: { type: "number" },
                      failedJobs: { type: "number" },
                      retryingJobs: { type: "number" },
                      deadLetterJobs: { type: "number" },
                      averageProcessingTime: { type: "number" },
                      successRate: { type: "number" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/queue/process": {
        post: {
          summary: "Process Queue Jobs",
          description: "Process pending jobs from the queue. This endpoint is typically called by worker processes.",
          operationId: "processQueueJobs",
          tags: ["Queue Operations"],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    maxJobs: { type: "number", default: 10 }
                  }
                }
              }
            }
          },
          responses: {
            "200": {
              description: "Jobs processed successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      processedJobs: { type: "number" },
                      results: { type: "array" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/docs": {
        get: {
          summary: "OpenAPI documentation",
          description: "Get the OpenAPI specification for this API",
          responses: {
            "200": {
              description: "OpenAPI specification",
              content: {
                "application/json": {
                  schema: {
                    type: "object"
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}

function createSwaggerUI(baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Riding Lookup API - Swagger UI</title>
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui.css" />
  <style>
    html {
      box-sizing: border-box;
      overflow: -moz-scrollbars-vertical;
      overflow-y: scroll;
    }
    *, *:before, *:after {
      box-sizing: inherit;
    }
    body {
      margin:0;
      background: #fafafa;
    }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      const ui = SwaggerUIBundle({
        url: '${baseUrl}/api/docs',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout",
        tryItOutEnabled: true,
        supportedSubmitMethods: ['get', 'post', 'put', 'delete', 'patch'],
        onComplete: function() {
          console.log('Swagger UI loaded');
        },
        onFailure: function(data) {
          console.error('Swagger UI failed to load:', data);
        }
      });
    };
  </script>
</body>
</html>`;
}

function createLandingPage(baseUrl: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Riding Lookup API</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f8f9fa;
        }
        .container {
            background: white;
            padding: 40px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #2c3e50;
            border-bottom: 3px solid #3498db;
            padding-bottom: 10px;
        }
        h2 {
            color: #2c3e50;
            margin-top: 30px;
            margin-bottom: 15px;
        }
        .endpoint {
            background: #f8f9fa;
            border-left: 4px solid #3498db;
            padding: 15px;
            margin: 15px 0;
            border-radius: 0 4px 4px 0;
        }
        .method {
            background: #27ae60;
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            font-weight: bold;
            font-size: 12px;
            margin-right: 10px;
        }
        .url {
            font-family: 'Monaco', 'Menlo', monospace;
            background: #ecf0f1;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 14px;
        }
        .description {
            margin-top: 10px;
            color: #666;
        }
        .example {
            background: #2c3e50;
            color: #ecf0f1;
            padding: 15px;
            border-radius: 4px;
            margin: 10px 0;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 14px;
            overflow-x: auto;
        }
        .param {
            margin: 5px 0;
        }
        .param-name {
            font-weight: bold;
            color: #e74c3c;
            font-family: 'Monaco', 'Menlo', monospace;
        }
        .param-desc {
            color: #666;
            margin-left: 10px;
        }
        .auth-note {
            background: #fff3cd;
            border: 1px solid #ffeaa7;
            padding: 15px;
            border-radius: 4px;
            margin: 20px 0;
        }
        .byok-note {
            background: #d1ecf1;
            border: 1px solid #bee5eb;
            padding: 15px;
            border-radius: 4px;
            margin: 20px 0;
        }
        .links {
            margin-top: 30px;
            text-align: center;
        }
        .links a {
            display: inline-block;
            background: #3498db;
            color: white;
            padding: 10px 20px;
            text-decoration: none;
            border-radius: 4px;
            margin: 0 10px;
            transition: background 0.3s;
        }
        .links a:hover {
            background: #2980b9;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Riding Lookup API</h1>
        <p>Find Canadian federal, provincial, and territorial ridings by location. This API supports geocoding addresses, postal codes, and coordinates to determine which riding a location falls within.</p>
        
        <div class="auth-note">
            <strong>Authentication:</strong> This API uses Basic Authentication. Include your credentials in the Authorization header, or provide your own Google API key via the X-Google-API-Key header to bypass authentication.
        </div>

        <div class="byok-note">
            <strong>Rate Limiting & Timeouts:</strong> The API includes rate limiting (100 requests/minute by default) and timeout protection. Single lookups timeout after 10s for geocoding and 5s for riding lookup. Batch operations timeout after 30s total. All operations have a 60s maximum request timeout.
        </div>

        <h2>API Endpoints</h2>
        
        <div class="endpoint">
            <span class="method">GET</span>
            <span class="url">${baseUrl}/api</span>
            <div class="description">Lookup federal riding by location</div>
        </div>
        
        <div class="endpoint">
            <span class="method">GET</span>
            <span class="url">${baseUrl}/api/qc</span>
            <div class="description">Lookup Quebec provincial riding by location</div>
        </div>
        
        <div class="endpoint">
            <span class="method">GET</span>
            <span class="url">${baseUrl}/api/on</span>
            <div class="description">Lookup Ontario provincial riding by location</div>
        </div>
        
        <div class="endpoint">
            <span class="method">POST</span>
            <span class="url">${baseUrl}/api/batch</span>
            <div class="description">Immediate batch processing with Google Maps batch geocoding (up to 100 requests, 10 per API call)</div>
        </div>
        
        <div class="endpoint">
            <span class="method">POST</span>
            <span class="url">${baseUrl}/api/queue/submit</span>
            <div class="description">Submit batch to persistent queue for asynchronous processing</div>
        </div>
        
        <div class="endpoint">
            <span class="method">GET</span>
            <span class="url">${baseUrl}/api/queue/status</span>
            <div class="description">Check batch processing status and results</div>
        </div>
        
        <div class="endpoint">
            <span class="method">GET</span>
            <span class="url">${baseUrl}/api/queue/stats</span>
            <div class="description">Get queue statistics and performance metrics</div>
        </div>
        
        <div class="endpoint">
            <span class="method">GET</span>
            <span class="url">${baseUrl}/api/docs</span>
            <div class="description">OpenAPI specification (JSON)</div>
        </div>

        <h2>Query Parameters</h2>
        <p>Provide location information using any of these parameters:</p>
        
        <div class="param">
            <span class="param-name">address</span>
            <span class="param-desc">Full address to geocode</span>
        </div>
        <div class="param">
            <span class="param-name">postal</span>
            <span class="param-desc">Canadian postal code (e.g., "K1A 0A6")</span>
        </div>
        <div class="param">
            <span class="param-name">lat</span>
            <span class="param-desc">Latitude coordinate</span>
        </div>
        <div class="param">
            <span class="param-name">lon</span>
            <span class="param-desc">Longitude coordinate</span>
        </div>
        <div class="param">
            <span class="param-name">city</span>
            <span class="param-desc">City name</span>
        </div>
        <div class="param">
            <span class="param-name">state</span>
            <span class="param-desc">Province or state</span>
        </div>
        <div class="param">
            <span class="param-name">country</span>
            <span class="param-desc">Country name</span>
        </div>

        <h2>Example Usage</h2>
        
        <h3>By Postal Code</h3>
        <div class="example">curl -u "username:password" "${baseUrl}/api?postal=K1A 0A6"</div>
        
        <h3>By Address</h3>
        <div class="example">curl -u "username:password" "${baseUrl}/api?address=24 Sussex Drive, Ottawa, ON"</div>
        
        <h3>By Coordinates</h3>
        <div class="example">curl -u "username:password" "${baseUrl}/api?lat=45.4215&lon=-75.6972"</div>
        
        <h3>Quebec Provincial Riding</h3>
        <div class="example">curl -u "username:password" "${baseUrl}/api/qc?address=1234 Rue Saint-Denis, Montréal, QC"</div>

        <h3>Using Your Own Google API Key (BYOK)</h3>
        <div class="example">curl -H "X-Google-API-Key: YOUR_GOOGLE_API_KEY" "${baseUrl}/api?address=24 Sussex Drive, Ottawa, ON"</div>
        
        <h3>Batch Processing with Google Maps</h3>
        <div class="example"># Process multiple addresses efficiently (new format)
curl -H "X-Google-API-Key: YOUR_GOOGLE_API_KEY" -X POST "${baseUrl}/api/batch" \\
  -H "Content-Type: application/json" \\
  -d '{
    "endpoint": "/api",
    "queries": [
      {"id": "1", "query": {"postal": "K1A 0A6"}},
      {"id": "2", "query": {"postal": "M5H 2N2"}},
      {"id": "3", "query": {"address": "1189 Nottingham", "city": "Burlington"}}
    ]
  }'</div>
        
        <div class="example"># Legacy format (still supported)
curl -H "X-Google-API-Key: YOUR_GOOGLE_API_KEY" -X POST "${baseUrl}/api/batch" \\
  -H "Content-Type: application/json" \\
  -d '{
    "requests": [
      {"id": "1", "pathname": "/api", "query": {"postal": "K1A 0A6"}},
      {"id": "2", "pathname": "/api", "query": {"postal": "M5H 2N2"}}
    ]
  }'</div>
        
        <h3>Immediate Batch Processing</h3>
        <div class="example">curl -u "username:password" -X POST "${baseUrl}/api/batch" \\
  -H "Content-Type: application/json" \\
  -d '{
    "requests": [
      {
        "id": "req1",
        "pathname": "/api",
        "query": { "postal": "K1A 0A6" }
      },
      {
        "id": "req2", 
        "pathname": "/api/qc",
        "query": { "address": "1234 Rue Saint-Denis, Montréal, QC" }
      },
      {
        "id": "req3",
        "pathname": "/api/on", 
        "query": { "lat": 43.6532, "lon": -79.3832 }
      }
    ]
  }'</div>

        <h3>Queue-Based Processing</h3>
        <div class="example"># Submit to queue
curl -u "username:password" -X POST "${baseUrl}/api/queue/submit" \\
  -H "Content-Type: application/json" \\
  -d '{
    "requests": [
      {
        "id": "req1",
        "pathname": "/api",
        "query": { "postal": "K1A 0A6" }
      }
    ]
  }'

# Check status
curl -u "username:password" "${baseUrl}/api/queue/status?batchId=batch_1234567890_abc123"

# Get queue stats
curl -u "username:password" "${baseUrl}/api/queue/stats"</div>
        
        <div class="byok-note">
            <strong>BYOK Benefits:</strong> Using your own Google Maps API key bypasses basic authentication and provides unlimited requests with enhanced geocoding accuracy. You get your own usage tracking and billing. <strong>Batch Geocoding:</strong> Process up to 10 addresses per API call for maximum cost efficiency and performance.
        </div>

        <h2>Response Format</h2>
        <div class="example">{
  "query": {
    "postal": "K1A 0A6"
  },
  "point": {
    "lon": -75.6972,
    "lat": 45.4215
  },
  "properties": {
    "FED_NUM": "35047",
    "FED_NAME": "Ottawa Centre",
    "PROV_TERR": "Ontario"
  }
}</div>

        <div class="links">
            <a href="${baseUrl}/swagger" target="_blank">Interactive API Docs (Swagger UI)</a>
            <a href="${baseUrl}/api/docs" target="_blank">OpenAPI Spec (JSON)</a>
            <a href="https://github.com" target="_blank">GitHub</a>
        </div>
    </div>
</body>
</html>`;
}

// Import the Durable Object
import { QueueManagerDO } from './queue-manager';

export { QueueManagerDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startTime = Date.now();
    incrementMetric('requestCount');
    
    // Initialize cache warming on first request
    if (!cacheWarmingState.lastWarmed && CACHE_WARMING_CONFIG.ENABLED) {
      initializeCacheWarming(env).catch(error => {
        console.error("Failed to initialize cache warming:", error);
      });
    }
    
    // Initialize webhook processing on first request
    if (webhookConfigs.size === 0 && WEBHOOK_CONFIG.ENABLED) {
      initializeWebhookProcessing();
    }
    
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      
      // Check rate limiting for all API endpoints
      if (pathname.startsWith('/api')) {
        const clientId = getClientId(request);
        const rateLimitResult = checkEnhancedRateLimit(env, clientId);
        if (!rateLimitResult.allowed) {
          return new Response(JSON.stringify({ 
            error: rateLimitResult.reason || "Rate limit exceeded",
            retryAfter: rateLimitResult.retryAfter
          }), {
            status: 429,
            headers: { 
              "content-type": "application/json; charset=UTF-8",
              "Retry-After": rateLimitResult.retryAfter?.toString() || "60"
            }
          });
        }
      }
      
      // Validate request size for POST requests
      if (request.method === 'POST') {
        const sizeValidation = validateRequestSize(request);
        if (!sizeValidation.valid) {
          return badRequest(sizeValidation.error || "Request too large", 413);
        }
      }
      
      // Handle landing page
      if (pathname === "/") {
        const baseUrl = `${url.protocol}//${url.host}`;
        return new Response(createLandingPage(baseUrl), {
          headers: { "content-type": "text/html; charset=UTF-8" }
        });
      }
      
      // Handle OpenAPI docs
      if (pathname === "/api/docs") {
        const baseUrl = `${url.protocol}//${url.host}`;
        return new Response(JSON.stringify(createOpenAPISpec(baseUrl)), {
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
      }

      // Handle Swagger UI
      if (pathname === "/api/swagger" || pathname === "/swagger") {
        const baseUrl = `${url.protocol}//${url.host}`;
        const swaggerHtml = createSwaggerUI(baseUrl);
        return new Response(swaggerHtml, {
          headers: { "content-type": "text/html; charset=UTF-8" }
        });
      }
      
      // Handle metrics endpoint
      if (pathname === "/api/metrics") {
        const metricsData = getMetrics();
        const circuitBreakerStates = {
          geocoding: geocodingCircuitBreaker.getStateInfo('geocoding:nominatim'),
          r2: r2CircuitBreaker.getStateInfo('r2:federalridings-2024.geojson')
        };
        
        return new Response(JSON.stringify({
          metrics: metricsData,
          circuitBreakers: circuitBreakerStates,
          cache: {
            geoCacheSize: geoCacheLRU.size(),
            spatialIndexCacheSize: spatialIndexCacheLRU.size()
          },
          timestamp: Date.now()
        }), {
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
      }
      
      
      // Handle batch geocoding status endpoint
      if (pathname === "/api/geocoding/batch/status") {
        if (request.method === "GET") {
          return new Response(JSON.stringify({
            enabled: BATCH_GEOCODING_CONFIG.ENABLED,
            maxBatchSize: BATCH_GEOCODING_CONFIG.MAX_BATCH_SIZE,
            timeout: BATCH_GEOCODING_CONFIG.TIMEOUT,
            retryAttempts: BATCH_GEOCODING_CONFIG.RETRY_ATTEMPTS,
            fallbackToIndividual: BATCH_GEOCODING_CONFIG.FALLBACK_TO_INDIVIDUAL,
            hasGoogleApiKey: !!(env.GOOGLE_MAPS_KEY || request.headers.get("X-Google-API-Key")),
          timestamp: Date.now()
          }), {
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
        } else {
          return badRequest("Method not allowed", 405);
        }
      }

      // Handle cache warming endpoints
      if (pathname === "/api/cache/warm") {
        if (request.method === "POST") {
          // Manual cache warming trigger
          if (!checkBasicAuth(request, env)) {
            return unauthorizedResponse();
          }
          
          performCacheWarming(env).catch(error => {
            console.error("Manual cache warming failed:", error);
          });
          
          return new Response(JSON.stringify({
            message: "Cache warming started",
            status: "initiated",
          timestamp: Date.now()
          }), {
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
        } else if (request.method === "GET") {
          // Get cache warming status
          const status = getCacheWarmingStatus();
          return new Response(JSON.stringify({
            ...status,
            config: {
              enabled: CACHE_WARMING_CONFIG.ENABLED,
              interval: CACHE_WARMING_CONFIG.WARMING_INTERVAL,
              batchSize: CACHE_WARMING_CONFIG.BATCH_SIZE,
              totalLocations: CACHE_WARMING_CONFIG.POPULAR_LOCATIONS.length,
              totalPostalCodes: CACHE_WARMING_CONFIG.POPULAR_POSTAL_CODES.length
            },
          timestamp: Date.now()
          }), {
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
        } else {
          return badRequest("Method not allowed", 405);
        }
      }

      // Handle webhook management endpoints
      if (pathname === "/api/webhooks") {
        if (request.method === "GET") {
          // List webhooks
          const webhooks = Array.from(webhookConfigs.entries()).map(([id, config]) => ({
            id,
            url: config.url,
            events: config.events,
            enabled: config.enabled,
            retryAttempts: config.retryAttempts,
            timeout: config.timeout
          }));
          
          return new Response(JSON.stringify({
            webhooks,
            total: webhooks.length,
            timestamp: Date.now()
          }), {
            headers: { 
              "content-type": "application/json; charset=UTF-8"
            }
          });
        } else if (request.method === "POST") {
          // Create webhook
        if (!checkBasicAuth(request, env)) {
          return unauthorizedResponse();
        }
        
        try {
            const body = await request.json() as {
              url: string;
              secret: string;
              events: string[];
              retryAttempts?: number;
              timeout?: number;
            };
            
            // Validate webhook data
            if (!body.url || !body.secret || !body.events || !Array.isArray(body.events)) {
              return badRequest("Invalid webhook data: url, secret, and events are required", 400);
            }
            
            const webhookId = generateWebhookId();
            const webhook: WebhookConfig = {
              url: body.url,
              secret: body.secret,
              events: body.events,
              retryAttempts: body.retryAttempts || 3,
              retryDelay: 5000,
              timeout: body.timeout || 30000,
              enabled: true
            };
            
            webhookConfigs.set(webhookId, webhook);
          
          return new Response(JSON.stringify({
              id: webhookId,
              webhook: {
                url: webhook.url,
                events: webhook.events,
                enabled: webhook.enabled,
                retryAttempts: webhook.retryAttempts,
                timeout: webhook.timeout
              },
              message: 'Webhook created successfully',
            timestamp: Date.now()
          }), {
              status: 201,
            headers: { 
                "content-type": "application/json; charset=UTF-8"
            }
          });
        } catch (error) {
            return badRequest("Invalid JSON data", 400);
          }
        } else {
          return badRequest("Method not allowed", 405);
        }
      }
      
      // Handle webhook events endpoint
      if (pathname === "/api/webhooks/events") {
          const url = new URL(request.url);
        const status = url.searchParams.get('status');
        const limit = parseInt(url.searchParams.get('limit') || '50');
        
        let events = Array.from(webhookEvents.values());
        
        if (status) {
          events = events.filter(event => event.status === status);
        }
        
        // Sort by timestamp (newest first)
        events.sort((a, b) => b.timestamp - a.timestamp);
        
        // Apply limit
        events = events.slice(0, limit);
          
          return new Response(JSON.stringify({
          events,
          total: webhookEvents.size,
          filtered: events.length,
            timestamp: Date.now()
          }), {
            headers: { 
            "content-type": "application/json; charset=UTF-8"
          }
        });
      }
      
      // Handle webhook deliveries endpoint
      if (pathname === "/api/webhooks/deliveries") {
        const url = new URL(request.url);
        const webhookId = url.searchParams.get('webhookId');
        const status = url.searchParams.get('status');
        const limit = parseInt(url.searchParams.get('limit') || '50');
        
        let deliveries = Array.from(webhookDeliveries.values());
        
        if (webhookId) {
          deliveries = deliveries.filter(delivery => delivery.webhookId === webhookId);
        }
        
        if (status) {
          deliveries = deliveries.filter(delivery => delivery.status === status);
        }
        
        // Sort by lastAttempt (newest first)
        deliveries.sort((a, b) => b.lastAttempt - a.lastAttempt);
        
        // Apply limit
        deliveries = deliveries.slice(0, limit);
        
        return new Response(JSON.stringify({
          deliveries,
          total: webhookDeliveries.size,
          filtered: deliveries.length,
          timestamp: Date.now()
        }), {
          headers: { 
            "content-type": "application/json; charset=UTF-8"
          }
        });
      }

      // Handle riding boundaries endpoints
      if (pathname.startsWith('/api/boundaries')) {
        return handleBoundaryRequest(request, env, pathname);
      }

      // Handle spatial database endpoints
      if (pathname.startsWith('/api/database')) {
        return handleSpatialDatabaseRequest(request, env, pathname);
      }
      
      // Handle health check endpoint
      if (pathname === "/api/health") {
        const health = {
          status: "healthy",
          timestamp: Date.now(),
          version: "1.0.0",
          features: {
            spatialIndexing: true,
            geocodingCache: !!env.GEOCODING_CACHE,
            circuitBreaker: true,
            enhancedValidation: true,
            lruCache: true,
            metrics: true,
            cacheWarming: CACHE_WARMING_CONFIG.ENABLED,
            batchGeocoding: BATCH_GEOCODING_CONFIG.ENABLED,
            webhooks: WEBHOOK_CONFIG.ENABLED,
            boundaries: BOUNDARIES_CONFIG.ENABLED,
            spatialDatabase: SPATIAL_DB_CONFIG.ENABLED
          },
          circuitBreakers: {
            geocoding: geocodingCircuitBreaker.getStateInfo('geocoding:nominatim')?.state || 'CLOSED',
            r2: r2CircuitBreaker.getStateInfo('r2:federalridings-2024.geojson')?.state || 'CLOSED'
          },
          cache: {
            geoCacheSize: geoCacheLRU.size(),
            spatialIndexCacheSize: spatialIndexCacheLRU.size()
          },
          cacheWarming: getCacheWarmingStatus(),
          webhooks: {
            enabled: WEBHOOK_CONFIG.ENABLED,
            totalWebhooks: webhookConfigs.size,
            totalEvents: webhookEvents.size,
            totalDeliveries: webhookDeliveries.size
          },
          boundaries: {
            enabled: BOUNDARIES_CONFIG.ENABLED,
            cacheSimplifiedBoundaries: BOUNDARIES_CONFIG.CACHE_SIMPLIFIED_BOUNDARIES,
            cacheSize: simplifiedBoundariesCache.size,
            maxCacheSize: BOUNDARIES_CONFIG.MAX_CACHE_SIZE,
            defaultSimplificationTolerance: BOUNDARIES_CONFIG.DEFAULT_SIMPLIFICATION_TOLERANCE,
            maxVertices: BOUNDARIES_CONFIG.MAX_VERTICES
          },
          spatialDatabase: {
            enabled: SPATIAL_DB_CONFIG.ENABLED,
            hasDatabase: !!env.RIDING_DB,
            useRtreeIndex: SPATIAL_DB_CONFIG.USE_RTREE_INDEX,
            batchInsertSize: SPATIAL_DB_CONFIG.BATCH_INSERT_SIZE,
            spatialIndexPrecision: SPATIAL_DB_CONFIG.SPATIAL_INDEX_PRECISION,
            enableQueryOptimization: SPATIAL_DB_CONFIG.ENABLE_QUERY_OPTIMIZATION,
            cachePreparedStatements: SPATIAL_DB_CONFIG.CACHE_PREPARED_STATEMENTS
          }
        };
        
        return new Response(JSON.stringify(health), {
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
      }
      
      // Handle batch lookup endpoint (immediate processing)
      if (pathname === "/api/batch") {
        if (request.method !== "POST") {
          return badRequest("Only POST supported for batch endpoint", 405);
        }
        
        // Check basic authentication for batch endpoint
        if (!checkBasicAuth(request, env)) {
          return unauthorizedResponse();
        }
        
        const body = await request.json();
        const validation = validateBatchRequest(body);
        if (!validation.valid) {
          return badRequest(validation.error || "Invalid batch request", 400);
        }
        
        const batchId = generateBatchId();
        const startTime = Date.now();
        
        try {
          const results = await withTimeout(
            processBatchLookupWithBatchGeocoding(env, validation.requests!),
            env.BATCH_TIMEOUT || DEFAULT_TIMEOUTS.batch,
            "Batch processing"
          );
          
          const totalTime = Date.now() - startTime;
          
          return new Response(JSON.stringify({
            batchId,
            totalRequests: validation.requests!.length,
            successfulRequests: results.filter(r => !r.error).length,
            failedRequests: results.filter(r => r.error).length,
            totalProcessingTime: totalTime,
            results
          }), {
            headers: { "content-type": "application/json; charset=UTF-8" }
          });
        } catch (error) {
          return badRequest(
            error instanceof Error ? error.message : "Batch processing failed",
            500
          );
        }
      }

      // Handle queue-based batch submission
      if (pathname === "/api/queue/submit") {
        if (request.method !== "POST") {
          return badRequest("Only POST supported for queue submit", 405);
        }
        
        // Check basic authentication
        if (!checkBasicAuth(request, env)) {
          return unauthorizedResponse();
        }
        
        const body = await request.json();
        const validation = validateBatchRequest(body);
        if (!validation.valid) {
          return badRequest(validation.error || "Invalid batch request", 400);
        }
        
        try {
          const result = await submitBatchToQueue(env, validation.requests!);
          return new Response(JSON.stringify(result), {
            headers: { "content-type": "application/json; charset=UTF-8" }
          });
        } catch (error) {
          return badRequest(
            error instanceof Error ? error.message : "Failed to submit to queue",
            500
          );
        }
      }

      // Handle batch status check
      if (pathname === "/api/queue/status") {
        if (request.method !== "GET") {
          return badRequest("Only GET supported for status check", 405);
        }
        
        const url = new URL(request.url);
        const batchId = url.searchParams.get("batchId");
        
        if (!batchId) {
          return badRequest("Missing batchId parameter", 400);
        }
        
        try {
          const status = await getBatchStatus(env, batchId);
          return new Response(JSON.stringify(status), {
            headers: { "content-type": "application/json; charset=UTF-8" }
          });
        } catch (error) {
          return badRequest(
            error instanceof Error ? error.message : "Failed to get batch status",
            500
          );
        }
      }

      // Handle queue processing (for workers)
      if (pathname === "/api/queue/process") {
        if (request.method !== "POST") {
          return badRequest("Only POST supported for queue processing", 405);
        }
        
        const body = await request.json() as { maxJobs?: number };
        const { maxJobs = 10 } = body;
        
        try {
          const result = await processQueueJobs(env, maxJobs);
          return new Response(JSON.stringify(result), {
            headers: { "content-type": "application/json; charset=UTF-8" }
          });
        } catch (error) {
          return badRequest(
            error instanceof Error ? error.message : "Failed to process queue jobs",
            500
          );
        }
      }

      // Handle queue statistics
      if (pathname === "/api/queue/stats") {
        if (request.method !== "GET") {
          return badRequest("Only GET supported for queue stats", 405);
        }
        
        try {
          const stats = await getQueueStats(env);
          return new Response(JSON.stringify(stats), {
            headers: { "content-type": "application/json; charset=UTF-8" }
          });
        } catch (error) {
          return badRequest(
            error instanceof Error ? error.message : "Failed to get queue stats",
            500
          );
        }
      }
      
      // Handle single lookup API routes (require authentication)
      if (pathname === "/api" || pathname === "/api/qc" || pathname === "/api/on") {
        if (request.method !== "GET") {
          return badRequest("Only GET supported for single lookup", 405);
        }
        
        // Check basic authentication for API routes
        if (!checkBasicAuth(request, env)) {
          return unauthorizedResponse();
        }
        
        try {
          const { query, validation } = parseQuery(request);
          
          // Check validation result
          if (!validation.valid) {
            return badRequest(validation.error || "Invalid query parameters", 400);
          }
          
          // Use sanitized query parameters
          const sanitizedQuery = validation.sanitized!;
          
          const { lon, lat } = await withTimeout(
            geocodeIfNeeded(env, sanitizedQuery, request),
            env.BATCH_TIMEOUT || DEFAULT_TIMEOUTS.geocoding,
            "Geocoding"
          );
          const result = await withTimeout(
            lookupRiding(env, pathname, lon, lat),
            env.BATCH_TIMEOUT || DEFAULT_TIMEOUTS.lookup,
            "Riding lookup"
          );
          
          recordTiming('totalLookupTime', Date.now() - startTime);
          return new Response(JSON.stringify({ query: sanitizedQuery, point: { lon, lat }, ...result }), {
            headers: { "content-type": "application/json; charset=UTF-8" }
          });
        } catch (error) {
          incrementMetric('errorCount');
          return badRequest(
            error instanceof Error ? error.message : "Lookup failed",
            500
          );
        }
      }
      
      return badRequest("Not found", 404)
    } catch (err: unknown) {
      incrementMetric('errorCount');
      recordTiming('totalLookupTime', Date.now() - startTime);
      return badRequest(err instanceof Error ? err.message : "Unexpected error", 400);
    }
  }
};
