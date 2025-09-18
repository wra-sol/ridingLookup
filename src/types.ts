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

// Geocoding interfaces
export interface MapboxFeature {
  center: [number, number];
}

export interface MapboxResponse {
  features: MapboxFeature[];
}

export interface NominatimResult {
  lon: string;
  lat: string;
}

export interface GoogleGeocodeLocation { 
  lat: number; 
  lng: number; 
}

export interface GoogleGeocodeGeometry { 
  location: GoogleGeocodeLocation; 
}

export interface GoogleGeocodeResult { 
  geometry: GoogleGeocodeGeometry; 
}

export interface GoogleGeocodeResponse { 
  status: string; 
  results: GoogleGeocodeResult[]; 
}

// Google Maps Batch Geocoding API types
export interface GoogleBatchGeocodeRequest {
  addresses: Array<{
    address: string;
  }>;
}

export interface GoogleBatchGeocodeResponse {
  results: Array<{
    address: string;
    geocoded_address: string;
    partial_match: boolean;
    place_id: string;
    postcode_localities: string[];
    types: string[];
    geometry: {
      location: {
        lat: number;
        lng: number;
      };
      location_type: string;
      viewport: {
        northeast: { lat: number; lng: number };
        southwest: { lat: number; lng: number };
      };
    };
  }>;
}

// GeoJSON interfaces
export interface GeoJSONGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][] | number[][][][];
}

export interface GeoJSONFeature {
  type: "Feature";
  geometry: GeoJSONGeometry;
  properties: Record<string, unknown>;
}

export interface GeoJSONFeatureCollection {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
}

// Query and result interfaces
export interface QueryParams {
  address?: string;
  postal?: string;
  lat?: number;
  lon?: number;
  city?: string;
  state?: string; // province/state
  country?: string;
}

export interface LookupResult {
  properties: Record<string, unknown> | null;
}

// Batch processing interfaces
export interface BatchLookupRequest {
  id: string;
  query: QueryParams;
  pathname: string;
}

export interface BatchRequest {
  endpoint: string;
  queries: Array<{
    id?: string;
    query: QueryParams;
  }>;
}

export interface BatchLookupResponse {
  id: string;
  query: QueryParams;
  point?: { lon: number; lat: number };
  properties: Record<string, unknown> | null;
  error?: string;
  processingTime: number;
}

export interface BatchJob {
  id: string;
  requests: BatchLookupRequest[];
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
  results: BatchLookupResponse[];
  errors: string[];
}

// Configuration interfaces
export interface TimeoutConfig {
  geocoding: number;
  lookup: number;
  batch: number;
  total: number;
}

// Webhook interfaces
export interface WebhookConfig {
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  createdAt: number;
  lastDelivery?: number;
  failureCount: number;
  maxFailures: number;
}

export interface WebhookEvent {
  id: string;
  webhookId: string;
  eventType: string;
  batchId: string;
  payload: any;
  createdAt: number;
  attempts: number;
  maxAttempts: number;
  status: 'pending' | 'delivered' | 'failed';
  lastAttempt?: number;
  nextRetry?: number;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  status: 'success' | 'failed';
  responseCode?: number;
  responseBody?: string;
  attemptedAt: number;
  duration: number;
  error?: string;
}

// Spatial database interfaces
export interface SpatialDatabaseFeature {
  id: string;
  dataset: string;
  name: string;
  geometry: string; // WKT format
  properties: string; // JSON string
  centroid_lon: number;
  centroid_lat: number;
  bbox_min_lon: number;
  bbox_min_lat: number;
  bbox_max_lon: number;
  bbox_max_lat: number;
  created_at: number;
  updated_at: number;
}

// Circuit breaker interfaces
export interface CircuitBreakerState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failureCount: number;
  lastFailureTime: number;
  successCount: number;
  nextAttemptTime: number;
}

// Metrics interfaces
export interface Metrics {
  geocodingRequests: number;
  geocodingCacheHits: number;
  geocodingCacheMisses: number;
  geocodingErrors: number;
  geocodingSuccesses: number;
  geocodingFailures: number;
  geocodingCircuitBreakerTrips: number;
  r2Requests: number;
  r2CacheHits: number;
  r2CacheMisses: number;
  r2Errors: number;
  r2Successes: number;
  r2Failures: number;
  r2CircuitBreakerTrips: number;
  spatialIndexHits: number;
  spatialIndexMisses: number;
  totalSpatialIndexTime: number;
  lookupRequests: number;
  lookupCacheHits: number;
  lookupCacheMisses: number;
  lookupErrors: number;
  batchRequests: number;
  batchErrors: number;
  webhookDeliveries: number;
  webhookFailures: number;
  requestCount: number;
  errorCount: number;
  totalLookupTime: number;
  totalGeocodingTime: number;
  totalR2Time: number;
  totalBatchTime: number;
  totalWebhookTime: number;
}

// Cache warming interfaces
export interface CacheWarmingState {
  isRunning: boolean;
  lastWarmed: number;
  warmingCount: number;
  errorCount: number;
  lastError?: string;
}

// Spatial index interfaces
export interface SpatialIndex {
  entries: Array<{
    feature: GeoJSONFeature;
    boundingBox: {
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
    };
  }>;
  boundingBox: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
}
