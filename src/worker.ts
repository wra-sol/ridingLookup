/// <reference types="@cloudflare/workers-types" />

import { Env, QueryParams, LookupResult, GeoJSONFeatureCollection, SpatialIndex } from './types';
import { geocodeIfNeeded, geocodeBatch } from './geocoding';
import { 
  geoCacheLRU, 
  spatialIndexCacheLRU, 
  geoCache,
  spatialIndexCache,
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
  initializeSpatialDatabase,
  insertFeaturesIntoDatabase,
  getAllFeaturesFromDatabase,
  syncGeoJSONToDatabase,
  SPATIAL_DB_CONFIG
} from './spatial';
import { 
  initializeWebhookProcessing, 
  triggerBatchCompletionWebhook,
  getAllWebhooks,
  getWebhookEvents,
  getWebhookDeliveries,
  generateWebhookId,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  getWebhook
} from './webhooks';
import { 
  processBatchLookup, 
  processBatchLookupWithBatchGeocoding,
  submitBatchToQueue,
  getBatchStatus,
  processQueueJobs,
  BATCH_CONFIG
} from './batch';
import { QueueManagerDO } from './queue-manager';
import { createLandingPage, createSwaggerUI, createOpenAPISpec } from './docs';

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
      initializeCacheWarming(env, async (env: Env, r2Key: string) => {
        await loadGeo(env, r2Key);
      }, lookupRiding).catch(error => {
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
      
      // Handle landing page
      if (pathname === "/") {
        const baseUrl = `${url.protocol}//${url.host}`;
        return new Response(createLandingPage(baseUrl), {
          headers: { 
            "content-type": "text/html; charset=UTF-8",
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      
      // Handle OpenAPI docs
      if (pathname === "/api/docs") {
        const baseUrl = `${url.protocol}//${url.host}`;
        return new Response(JSON.stringify(createOpenAPISpec(baseUrl)), {
          headers: { 
            "content-type": "application/json; charset=UTF-8",
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      // Handle Swagger UI
      if (pathname === "/api/swagger" || pathname === "/swagger") {
        const baseUrl = `${url.protocol}//${url.host}`;
        const swaggerHtml = createSwaggerUI(baseUrl);
        return new Response(swaggerHtml, {
          headers: { 
            "content-type": "text/html; charset=UTF-8",
            'Access-Control-Allow-Origin': '*'
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
      
      // Handle database endpoints
      if (pathname.startsWith('/api/database')) {
        if (pathname === '/api/database/init' && request.method === 'POST') {
          if (!checkBasicAuth(request, env)) {
            return unauthorizedResponse();
          }
          
          try {
            const success = await initializeSpatialDatabase(env);
            return new Response(JSON.stringify({
              success,
              message: success ? "Database initialized successfully" : "Database initialization failed"
            }), {
              headers: { 
                "content-type": "application/json; charset=UTF-8",
                'Access-Control-Allow-Origin': '*'
              }
            });
          } catch (error) {
            return badRequest(
              error instanceof Error ? error.message : "Database initialization failed",
              500
            );
          }
        }
        
        if (pathname === '/api/database/sync' && request.method === 'POST') {
          if (!checkBasicAuth(request, env)) {
            return unauthorizedResponse();
          }
          
          try {
            const body = await request.json() as { dataset?: string };
            const dataset = body.dataset || 'federalridings-2024.geojson';
            
            const success = await syncGeoJSONToDatabase(env, dataset, loadGeo);
            return new Response(JSON.stringify({
              success,
              message: success ? `Database synced for ${dataset}` : "Database sync failed",
              dataset
            }), {
              headers: { 
                "content-type": "application/json; charset=UTF-8",
                'Access-Control-Allow-Origin': '*'
              }
            });
          } catch (error) {
            return badRequest(
              error instanceof Error ? error.message : "Database sync failed",
              500
            );
          }
        }
        
        if (pathname === '/api/database/stats' && request.method === 'GET') {
          if (!checkBasicAuth(request, env)) {
            return unauthorizedResponse();
          }
          
          try {
            // This would need to be implemented to get actual database stats
            return new Response(JSON.stringify({
              enabled: SPATIAL_DB_CONFIG.ENABLED,
              features: 0, // Would need actual count
              lastSync: null, // Would need actual timestamp
              status: SPATIAL_DB_CONFIG.ENABLED ? "active" : "disabled"
            }), {
              headers: { 
                "content-type": "application/json; charset=UTF-8",
                'Access-Control-Allow-Origin': '*'
              }
            });
          } catch (error) {
            return badRequest(
              error instanceof Error ? error.message : "Failed to get database stats",
              500
            );
          }
        }
        
        if (pathname === '/api/database/query' && request.method === 'GET') {
          const lat = parseFloat(url.searchParams.get('lat') || '');
          const lon = parseFloat(url.searchParams.get('lon') || '');
          const dataset = url.searchParams.get('dataset') || 'federalridings-2024.geojson';
          
          if (isNaN(lat) || isNaN(lon)) {
            return badRequest('Invalid lat/lon parameters', 400);
          }
          
          try {
            const result = await queryRidingFromDatabase(env, dataset, lon, lat);
            return new Response(JSON.stringify(result), {
              headers: { 
                "content-type": "application/json; charset=UTF-8",
                'Access-Control-Allow-Origin': '*'
              }
            });
          } catch (error) {
            return badRequest(
              error instanceof Error ? error.message : "Database query failed",
              500
            );
          }
        }
        
        return badRequest("Database endpoint not found", 404);
      }
      
      // Handle boundaries endpoints
      if (pathname.startsWith('/api/boundaries')) {
        if (pathname === '/api/boundaries/lookup' && request.method === 'GET') {
          const lat = parseFloat(url.searchParams.get('lat') || '');
          const lon = parseFloat(url.searchParams.get('lon') || '');
          const dataset = url.searchParams.get('dataset') || 'federalridings-2024.geojson';
          
          if (isNaN(lat) || isNaN(lon)) {
            return badRequest('Invalid lat/lon parameters', 400);
          }
          
          try {
            const result = await lookupRiding(env, `/api`, lon, lat);
            return new Response(JSON.stringify(result), {
              headers: { 
                "content-type": "application/json; charset=UTF-8",
                'Access-Control-Allow-Origin': '*'
              }
            });
          } catch (error) {
            return badRequest(
              error instanceof Error ? error.message : "Boundaries lookup failed",
              500
            );
          }
        }
        
        if (pathname === '/api/boundaries/all' && request.method === 'GET') {
          const dataset = url.searchParams.get('dataset') || 'federalridings-2024.geojson';
          const limit = parseInt(url.searchParams.get('limit') || '100');
          const offset = parseInt(url.searchParams.get('offset') || '0');
          
          try {
            if (SPATIAL_DB_CONFIG.ENABLED && env.RIDING_DB) {
              const result = await getAllFeaturesFromDatabase(env, dataset, limit, offset);
              return new Response(JSON.stringify(result), {
                headers: { 
                  "content-type": "application/json; charset=UTF-8",
                  'Access-Control-Allow-Origin': '*'
                }
              });
            } else {
              return badRequest('Spatial database not enabled', 503);
            }
          } catch (error) {
            return badRequest(
              error instanceof Error ? error.message : "Failed to get boundaries",
              500
            );
          }
        }
        
        if (pathname === '/api/boundaries/config' && request.method === 'GET') {
          return new Response(JSON.stringify({
            enabled: SPATIAL_DB_CONFIG.ENABLED,
            useRtreeIndex: SPATIAL_DB_CONFIG.USE_RTREE_INDEX,
            batchInsertSize: SPATIAL_DB_CONFIG.BATCH_INSERT_SIZE,
            datasets: ['federalridings-2024.geojson', 'quebecridings-2025.geojson', 'ontarioridings-2022.geojson']
          }), {
            headers: { 
              "content-type": "application/json; charset=UTF-8",
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
        
        return badRequest("Boundaries endpoint not found", 404);
      }
      
      // Handle geocoding batch status endpoint
      if (pathname === "/api/geocoding/batch/status") {
        if (request.method === "GET") {
          return new Response(JSON.stringify({
            enabled: true,
            maxBatchSize: 10,
            timeout: 30000,
            retryAttempts: 3,
            fallbackToIndividual: true,
            hasGoogleApiKey: !!(env.GOOGLE_MAPS_KEY),
            timestamp: Date.now()
          }), {
            headers: { 
              "content-type": "application/json; charset=UTF-8",
              'Access-Control-Allow-Origin': '*'
            }
          });
        } else {
          return badRequest("Method not allowed", 405);
        }
      }
      
      // Handle cache warming endpoints
      if (pathname === "/api/cache/warm") {
        if (request.method === "POST") {
          if (!checkBasicAuth(request, env)) {
            return unauthorizedResponse();
          }
          
          try {
            const body = await request.json() as { locations?: Array<{ lat: number; lon: number; postal?: string }> };
            const locations = body.locations || [];
            
            for (const location of locations) {
              if (location.lat && location.lon) {
                await loadGeo(env, 'federalridings-2024.geojson');
              } else if (location.postal) {
                console.log(`Cache warming for postal code: ${location.postal}`);
              }
            }
            
            return new Response(JSON.stringify({
              message: "Cache warming initiated",
              locations: locations.length,
              timestamp: Date.now()
            }), {
              headers: { 
                "content-type": "application/json; charset=UTF-8",
                'Access-Control-Allow-Origin': '*'
              }
            });
          } catch (error) {
            return badRequest(
              error instanceof Error ? error.message : "Cache warming failed",
              500
            );
          }
        } else {
          return badRequest("Method not allowed", 405);
        }
      }
      
      // Handle webhook management endpoints
      if (pathname.startsWith('/api/webhooks')) {
        if (pathname === '/api/webhooks' && request.method === 'GET') {
          if (!checkBasicAuth(request, env)) {
            return unauthorizedResponse();
          }
          
          const webhooks = Array.from(getAllWebhooks().entries()).map(([id, config]) => ({
            id,
            url: config.url,
            events: config.events,
            secret: config.secret ? '***' : undefined,
            createdAt: config.createdAt,
            lastDelivery: config.lastDelivery,
            failureCount: config.failureCount,
            maxFailures: config.maxFailures,
            active: config.active
          }));
          
          return new Response(JSON.stringify({ webhooks }), {
            headers: { 
              "content-type": "application/json; charset=UTF-8",
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
        
        if (pathname === '/api/webhooks' && request.method === 'POST') {
          if (!checkBasicAuth(request, env)) {
            return unauthorizedResponse();
          }
          
          try {
            const body = await request.json() as { url: string; events: string[]; secret?: string };
            const webhookId = createWebhook({
              url: body.url,
              events: body.events,
              secret: body.secret || '',
              active: true
            });
            
            return new Response(JSON.stringify({
              webhookId,
              message: "Webhook created successfully"
            }), {
              headers: { 
                "content-type": "application/json; charset=UTF-8",
                'Access-Control-Allow-Origin': '*'
              }
            });
          } catch (error) {
            return badRequest(
              error instanceof Error ? error.message : "Failed to create webhook",
              500
            );
          }
        }
        
        if (pathname === '/api/webhooks/events' && request.method === 'GET') {
          if (!checkBasicAuth(request, env)) {
            return unauthorizedResponse();
          }
          
          const url = new URL(request.url);
          const status = url.searchParams.get('status');
          const webhookId = url.searchParams.get('webhookId');
          
          const events = getWebhookEvents(webhookId || undefined);
          const filteredEvents = status ? events.filter(e => e.status === status) : events;
          
          return new Response(JSON.stringify({ events: filteredEvents }), {
            headers: { 
              "content-type": "application/json; charset=UTF-8",
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
        
        if (pathname === '/api/webhooks/deliveries' && request.method === 'GET') {
          if (!checkBasicAuth(request, env)) {
            return unauthorizedResponse();
          }
          
          const url = new URL(request.url);
          const webhookId = url.searchParams.get('webhookId');
          const status = url.searchParams.get('status');
          
          const deliveries = getWebhookDeliveries(webhookId || undefined);
          const filteredDeliveries = status ? deliveries.filter(d => d.status === status) : deliveries;
          
          return new Response(JSON.stringify({ deliveries: filteredDeliveries }), {
            headers: { 
              "content-type": "application/json; charset=UTF-8",
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
        
        return badRequest("Webhook endpoint not found", 404);
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
      
      // Handle queue-based batch submission
      if (pathname === "/api/queue/submit") {
        if (request.method !== "POST") {
          return badRequest("Only POST supported for queue submit", 405);
        }
        
        // Check basic authentication
        if (!checkBasicAuth(request, env)) {
          return unauthorizedResponse();
        }
        
        try {
          const body = await request.json() as { requests: any[] };
          
          if (!body.requests || !Array.isArray(body.requests)) {
            return badRequest("Invalid request body. Expected 'requests' array.", 400);
          }
          
          const result = await submitBatchToQueue(env, body.requests);
          return new Response(JSON.stringify(result), {
            headers: { 
              "content-type": "application/json; charset=UTF-8",
              'Access-Control-Allow-Origin': '*'
            }
          });
        } catch (error) {
          return badRequest(
            error instanceof Error ? error.message : "Failed to submit batch to queue",
            500
          );
        }
      }
      
      // Handle batch status check
      if (pathname === "/api/queue/status") {
        if (request.method !== "GET") {
          return badRequest("Only GET supported for status check", 405);
        }
        
        // Check basic authentication
        if (!checkBasicAuth(request, env)) {
          return unauthorizedResponse();
        }
        
        const batchId = url.searchParams.get('batchId');
        if (!batchId) {
          return badRequest("Missing required parameter: batchId", 400);
        }
        
        try {
          const result = await getBatchStatus(env, batchId);
          return new Response(JSON.stringify(result), {
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
      
      // Handle queue processing (for workers)
      if (pathname === "/api/queue/process") {
        if (request.method !== "POST") {
          return badRequest("Only POST supported for queue processing", 405);
        }
        
        // Check basic authentication
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
        
        // Check basic authentication
        if (!checkBasicAuth(request, env)) {
          return unauthorizedResponse();
        }
        
        try {
          // Get queue stats from the queue manager
          if (!env.QUEUE_MANAGER) {
            return badRequest("Queue manager not configured", 503);
          }
          
          const queueManagerId = env.QUEUE_MANAGER.idFromName("main-queue");
          const queueManager = env.QUEUE_MANAGER.get(queueManagerId);
          const response = await queueManager.fetch(new Request("https://queue.local/queue/stats"));
          
          if (!response.ok) {
            const error = await response.json() as { error?: string };
            throw new Error(error.error || "Failed to get queue stats");
          }
          
          const stats = await response.json();
          return new Response(JSON.stringify(stats), {
            headers: { 
              "content-type": "application/json; charset=UTF-8",
              'Access-Control-Allow-Origin': '*'
            }
          });
        } catch (error) {
          return badRequest(
            error instanceof Error ? error.message : "Failed to get queue stats",
            500
          );
        }
      }
      
      // Queue processing endpoint (legacy)
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

// Export Durable Object
export { QueueManagerDO };
