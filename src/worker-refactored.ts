/// <reference types="@cloudflare/workers-types" />

import { Env, QueryParams, LookupResult, GeoJSONFeatureCollection, SpatialIndex } from './types';
import { geocodeIfNeeded, geocodeBatch } from './geocoding';
import { 
  geoCacheLRU, 
  spatialIndexCacheLRU, 
  getCachedGeoJSON, 
  setCachedGeoJSON, 
  getCachedSpatialIndex, 
  setCachedSpatialIndex,
  getCachedSimplifiedBoundary,
  setCachedSimplifiedBoundary,
  initializeCacheWarming,
  getCacheWarmingStatus
} from './cache';
import { geocodingCircuitBreaker, r2CircuitBreaker } from './circuit-breaker';
import { incrementMetric, recordTiming, getMetrics, getMetricsSummary } from './metrics';
import { 
  isPointInPolygon, 
  withTimeout, 
  withRetry, 
  pickDataset, 
  parseQuery, 
  checkBasicAuth, 
  badRequest, 
  unauthorizedResponse, 
  rateLimitExceededResponse,
  checkRateLimit,
  getClientId,
  simplifyGeometry
} from './utils';
import { 
  createSpatialIndex, 
  findCandidateFeatures, 
  isPointInBoundingBox,
  queryRidingFromDatabase,
  SPATIAL_DB_CONFIG
} from './spatial';
import { 
  initializeWebhookProcessing, 
  triggerBatchCompletionWebhook,
  getAllWebhooks,
  getWebhookEvents,
  getWebhookDeliveries
} from './webhooks';
import { 
  processBatchLookup, 
  processBatchLookupWithBatchGeocoding,
  submitBatchToQueue,
  getBatchStatus,
  processQueueJobs,
  BATCH_CONFIG
} from './batch';

// Configuration constants
const DEFAULT_TIMEOUTS = {
  geocoding: 10000,
  lookup: 5000,
  batch: 30000,
  total: 60000
};

const DEFAULT_RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 5000,
  backoffMultiplier: 2,
  jitter: true
};

// Global state
let cacheWarmingInitialized = false;

// Main lookup function
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

// Load GeoJSON data from R2
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

  // Fallback to old cache
  const oldCached = geoCache.get(key);
  if (oldCached) {
    incrementMetric('r2CacheHits');
    geoCacheLRU.set(key, oldCached);
    recordTiming('totalR2Time', Date.now() - startTime);
    return oldCached;
  }

  incrementMetric('r2CacheMisses');
  
  try {
    const geo = await r2CircuitBreaker.execute(`r2:${key}`, async () => {
      return await withRetry(async () => {
        const obj = await env.RIDINGS.get(key);
        if (!obj) throw new Error(`R2 object not found: ${key}`);
        const text = await obj.text();
        return JSON.parse(text) as GeoJSONFeatureCollection;
      }, DEFAULT_RETRY_CONFIG, `R2 fetch ${key}`);
    });
    
    // Cache the result
    setCachedGeoJSON(key, geo);
    
    // Create spatial index
    const spatialIndex = createSpatialIndex(geo);
    setCachedSpatialIndex(key, spatialIndex);
    
    incrementMetric('r2Successes');
    recordTiming('totalR2Time', Date.now() - startTime);
    return geo;
  } catch (error) {
    incrementMetric('r2Failures');
    if (error instanceof Error && error.message.includes('Circuit breaker is OPEN')) {
      incrementMetric('r2CircuitBreakerTrips');
    }
    recordTiming('totalR2Time', Date.now() - startTime);
    throw error;
  }
}

// Lookup riding using spatial index
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

// Check if point is in polygon and return properties
function featurePropertiesIfContains(ridingFeature: any, lon: number, lat: number): Record<string, unknown> | null {
  const geom = ridingFeature?.geometry;
  if (!geom) return null;
  if (isPointInPolygon(lon, lat, geom)) {
    return ridingFeature?.properties || {};
  }
  return null;
}

// Main worker export
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startTime = Date.now();
    incrementMetric('requestCount');
    
    // Initialize cache warming on first request
    if (!cacheWarmingInitialized) {
      cacheWarmingInitialized = true;
      initializeCacheWarming(env, loadGeo, lookupRiding).catch(error => {
        console.error("Failed to initialize cache warming:", error);
      });
    }
    
    // Initialize webhook processing
    initializeWebhookProcessing();
    
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      
      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Google-API-Key',
            'Access-Control-Max-Age': '86400'
          }
        });
      }
      
      // Health check endpoint
      if (pathname === '/health') {
        const metrics = getMetrics();
        const circuitBreakerStates = {
          geocoding: geocodingCircuitBreaker.getStateInfo('geocoding:nominatim'),
          r2: r2CircuitBreaker.getStateInfo('r2:federalridings-2024.geojson')
        };
        
        return new Response(JSON.stringify({
          status: 'healthy',
          timestamp: Date.now(),
          metrics,
          circuitBreakers: circuitBreakerStates,
          cacheWarming: getCacheWarmingStatus()
        }), {
          headers: { 
            "content-type": "application/json; charset=UTF-8",
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      
      // Metrics endpoint
      if (pathname === '/metrics') {
        const metrics = getMetricsSummary();
        return new Response(JSON.stringify(metrics), {
          headers: { 
            "content-type": "application/json; charset=UTF-8",
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      
      // Webhook management endpoints
      if (pathname.startsWith('/webhooks')) {
        if (!checkBasicAuth(request, env)) {
          return unauthorizedResponse();
        }
        
        if (pathname === '/webhooks' && request.method === 'GET') {
          const webhooks = Array.from(getAllWebhooks().entries()).map(([id, config]) => ({
            id,
            url: config.url,
            events: config.events,
            active: config.active,
            createdAt: config.createdAt,
            lastDelivery: config.lastDelivery,
            failureCount: config.failureCount
          }));
          
          return new Response(JSON.stringify({ webhooks }), {
            headers: { 
              "content-type": "application/json; charset=UTF-8",
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
        
        if (pathname === '/webhooks/events' && request.method === 'GET') {
          const events = getWebhookEvents();
          return new Response(JSON.stringify({ events }), {
            headers: { 
              "content-type": "application/json; charset=UTF-8",
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
        
        if (pathname === '/webhooks/deliveries' && request.method === 'GET') {
          const deliveries = getWebhookDeliveries();
          return new Response(JSON.stringify({ deliveries }), {
            headers: { 
              "content-type": "application/json; charset=UTF-8",
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
      }
      
      // Cache warming status endpoint
      if (pathname === '/cache-warming' && request.method === 'GET') {
        const status = getCacheWarmingStatus();
        return new Response(JSON.stringify({
          ...status,
          config: {
            enabled: true,
            interval: 6 * 60 * 60 * 1000, // 6 hours
            batchSize: 5
          }
        }), {
          headers: { 
            "content-type": "application/json; charset=UTF-8",
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      
      // Batch processing endpoints
      if (pathname.startsWith('/batch')) {
        if (!checkBasicAuth(request, env)) {
          return unauthorizedResponse();
        }
        
        if (pathname === '/batch' && request.method === 'POST') {
          try {
            const body = await request.json() as { requests: any[] };
            const requests = body.requests.map((req, index) => ({
              id: req.id || `req_${index}`,
              query: req.query,
              pathname: req.pathname || '/api'
            }));
            
            const results = await processBatchLookupWithBatchGeocoding(
              env, 
              requests, 
              geocodeIfNeeded, 
              lookupRiding, 
              geocodeBatch
            );
            
            return new Response(JSON.stringify({ results }), {
              headers: { 
                "content-type": "application/json; charset=UTF-8",
                'Access-Control-Allow-Origin': '*'
              }
            });
          } catch (error) {
            return badRequest(
              error instanceof Error ? error.message : "Batch processing failed",
              500
            );
          }
        }
        
        if (pathname.startsWith('/batch/') && request.method === 'GET') {
          const batchId = pathname.split('/')[2];
          try {
            const status = await getBatchStatus(env, batchId);
            return new Response(JSON.stringify(status), {
              headers: { 
                "content-type": "application/json; charset=UTF-8",
                'Access-Control-Allow-Origin': '*'
              }
            });
          } catch (error) {
            return badRequest(
              error instanceof Error ? error.message : "Failed to get batch status",
              500
            );
          }
        }
      }
      
      // Queue processing endpoint
      if (pathname === '/queue/process' && request.method === 'POST') {
        if (!checkBasicAuth(request, env)) {
          return unauthorizedResponse();
        }
        
        try {
          const body = await request.json() as { maxJobs?: number };
          const result = await processQueueJobs(env, body.maxJobs || 10);
          return new Response(JSON.stringify(result), {
            headers: { 
              "content-type": "application/json; charset=UTF-8",
              'Access-Control-Allow-Origin': '*'
            }
          });
        } catch (error) {
          return badRequest(
            error instanceof Error ? error.message : "Queue processing failed",
            500
          );
        }
      }
      
      // Main lookup endpoint
      if (pathname.startsWith('/api')) {
        // Check rate limiting
        const clientId = getClientId(request);
        if (!checkRateLimit(env, clientId)) {
          return rateLimitExceededResponse();
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
            geocodeIfNeeded(env, sanitizedQuery, request, { incrementMetric, recordTiming }, geocodingCircuitBreaker),
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
            headers: { 
              "content-type": "application/json; charset=UTF-8",
              'Access-Control-Allow-Origin': '*'
            }
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
