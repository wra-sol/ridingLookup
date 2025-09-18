import { 
  Env, 
  QueryParams, 
  MapboxResponse, 
  NominatimResult, 
  GoogleGeocodeResponse,
  GoogleBatchGeocodeRequest,
  GoogleBatchGeocodeResponse
} from './types';

// Geocoding cache entry interface
interface GeocodingCacheEntry {
  lon: number;
  lat: number;
  timestamp: number;
  provider: string;
}

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
  backoffMultiplier: 2
};

const BATCH_GEOCODING_CONFIG = {
  ENABLED: true,
  MAX_BATCH_SIZE: 10,
  PROVIDER: 'google' // 'google' or 'individual'
};

// Generate cache key for geocoding requests
export function generateGeocodingCacheKey(query: QueryParams, provider: string): string {
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
export async function getCachedGeocoding(env: Env, cacheKey: string): Promise<{ lon: number; lat: number } | null> {
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
export async function setCachedGeocoding(env: Env, cacheKey: string, lon: number, lat: number, provider: string): Promise<void> {
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

// Retry utility function
async function withRetry<T>(
  fn: () => Promise<T>,
  config: typeof DEFAULT_RETRY_CONFIG,
  operation: string
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt === config.maxAttempts) {
        throw lastError;
      }
      
      const delay = Math.min(
        config.baseDelay * Math.pow(config.backoffMultiplier, attempt - 1),
        config.maxDelay
      );
      
      console.warn(`${operation} attempt ${attempt} failed, retrying in ${delay}ms:`, lastError.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError!;
}

// Timeout utility function
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  
  return Promise.race([promise, timeoutPromise]);
}

// Main geocoding function
export async function geocodeIfNeeded(
  env: Env, 
  qp: QueryParams, 
  request?: Request,
  metrics?: {
    incrementMetric: (key: keyof import('./types').Metrics, value?: number) => void;
    recordTiming: (key: keyof import('./types').Metrics, duration: number) => void;
  },
  circuitBreaker?: {
    execute: (key: string, fn: () => Promise<any>) => Promise<any>;
  }
): Promise<{ lon: number; lat: number; }> {
  if (typeof qp.lat === "number" && typeof qp.lon === "number") {
    return { lon: qp.lon, lat: qp.lat };
  }
  const query = qp.address || qp.postal || qp.city || qp.state || qp.country;
  if (!query) throw new Error("Missing location: provide lat/lon or address/postal");

  const timeoutMs = env.BATCH_TIMEOUT || DEFAULT_TIMEOUTS.geocoding;
  
  const geocodePromise = (async () => {
    const startTime = Date.now();
    metrics?.incrementMetric('geocodingRequests');
    
    const provider = (env.GEOCODER || "nominatim").toLowerCase();
    
    // Check cache first
    const cacheKey = generateGeocodingCacheKey(qp, provider);
    const cached = await getCachedGeocoding(env, cacheKey);
    if (cached) {
      metrics?.incrementMetric('geocodingCacheHits');
      metrics?.recordTiming('totalGeocodingTime', Date.now() - startTime);
      return cached;
    }
    
    metrics?.incrementMetric('geocodingCacheMisses');
    
    // Use circuit breaker and retry for geocoding
    let result: { lon: number; lat: number };
    try {
      const geocodeFn = async () => {
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
      };

      if (circuitBreaker) {
        result = await circuitBreaker.execute(`geocoding:${provider}`, async () => {
          return await withRetry(geocodeFn, DEFAULT_RETRY_CONFIG, `Geocoding ${provider}`);
        });
      } else {
        result = await withRetry(geocodeFn, DEFAULT_RETRY_CONFIG, `Geocoding ${provider}`);
      }
      
      metrics?.incrementMetric('geocodingSuccesses');
    } catch (error) {
      metrics?.incrementMetric('geocodingFailures');
      if (error instanceof Error && error.message.includes('Circuit breaker is OPEN')) {
        metrics?.incrementMetric('geocodingCircuitBreakerTrips');
      }
      throw error;
    }
    
    // Cache the result
    await setCachedGeocoding(env, cacheKey, result.lon, result.lat, provider);
    
    metrics?.recordTiming('totalGeocodingTime', Date.now() - startTime);
    return result;
  })();

  return withTimeout(geocodePromise, timeoutMs, "Geocoding");
}

// Batch geocoding with Google
export async function geocodeBatchWithGoogle(
  env: Env, 
  queries: QueryParams[], 
  apiKey: string
): Promise<Array<{ lon: number; lat: number; success: boolean; error?: string }>> {
  const results: Array<{ lon: number; lat: number; success: boolean; error?: string }> = [];
  
  // Convert queries to Google batch format
  const addresses = queries.map(query => {
    const addressParts: string[] = [];
    
    if (query.address) addressParts.push(query.address);
    if (query.postal) addressParts.push(query.postal);
    if (query.city) addressParts.push(query.city);
    if (query.state) addressParts.push(query.state);
    if (query.country) addressParts.push(query.country);
    
    return {
      address: addressParts.join(', ')
    };
  });

  const batchRequest: GoogleBatchGeocodeRequest = {
    addresses
  };

  try {
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
    
    if (data.results) {
      for (let i = 0; i < data.results.length; i++) {
        const result = data.results[i];
        const query = queries[i];
        
        if (result.geometry && result.geometry.location) {
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
            error: `No results for query: ${query.address || query.postal || query.city}`
          });
        }
      }
    } else {
      // Fallback to individual geocoding if batch fails
      for (const query of queries) {
        try {
          const result = await geocodeIfNeeded(env, query);
          results.push({ ...result, success: true });
        } catch (error) {
          results.push({
            lon: 0,
            lat: 0,
            success: false,
            error: error instanceof Error ? error.message : 'Geocoding failed'
          });
        }
      }
    }
  } catch (error) {
    console.error('Google batch geocoding failed:', error);
    
    // Fallback to individual geocoding
    for (const query of queries) {
      try {
        const result = await geocodeIfNeeded(env, query);
        results.push({ ...result, success: true });
      } catch (individualError) {
        results.push({
          lon: 0,
          lat: 0,
          success: false,
          error: individualError instanceof Error ? individualError.message : 'Geocoding failed'
        });
      }
    }
  }

  return results;
}

// Batch geocoding function
export async function geocodeBatch(
  env: Env, 
  queries: QueryParams[], 
  request?: Request,
  metrics?: {
    incrementMetric: (key: keyof import('./types').Metrics, value?: number) => void;
    recordTiming: (key: keyof import('./types').Metrics, duration: number) => void;
  },
  circuitBreaker?: {
    execute: (key: string, fn: () => Promise<any>) => Promise<any>;
  }
): Promise<Array<{ lon: number; lat: number; success: boolean; error?: string }>> {
  if (!BATCH_GEOCODING_CONFIG.ENABLED || queries.length === 0) {
    return [];
  }

  const results: Array<{ lon: number; lat: number; success: boolean; error?: string }> = [];
  
  // Process in batches
  const batchSize = BATCH_GEOCODING_CONFIG.MAX_BATCH_SIZE;
  for (let i = 0; i < queries.length; i += batchSize) {
    const batch = queries.slice(i, i + batchSize);
    
    try {
      if (BATCH_GEOCODING_CONFIG.PROVIDER === 'google' && env.GOOGLE_MAPS_KEY) {
        const batchResults = await geocodeBatchWithGoogle(env, batch, env.GOOGLE_MAPS_KEY);
        results.push(...batchResults);
      } else {
        // Individual geocoding fallback
        for (const query of batch) {
          try {
            const result = await geocodeIfNeeded(env, query, request, metrics, circuitBreaker);
            results.push({ ...result, success: true });
          } catch (error) {
            results.push({ 
              lon: 0, 
              lat: 0, 
              success: false, 
              error: error instanceof Error ? error.message : 'Geocoding failed' 
            });
          }
        }
      }
    } catch (error) {
      console.error(`Batch geocoding failed for batch ${i / BATCH_GEOCODING_CONFIG.MAX_BATCH_SIZE + 1}:`, error);
      
      // Fallback to individual geocoding for this batch
      for (const query of batch) {
        try {
          const result = await geocodeIfNeeded(env, query, request, metrics, circuitBreaker);
          results.push({ ...result, success: true });
        } catch (individualError) {
          results.push({ 
            lon: 0, 
            lat: 0, 
            success: false, 
            error: individualError instanceof Error ? individualError.message : 'Geocoding failed' 
          });
        }
      }
    }
  }

  return results;
}
