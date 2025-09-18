import { Env, QueryParams, GeoJSONGeometry, GeoJSONFeature } from './types';

// Configuration constants
export const DEFAULT_TIMEOUTS = {
  geocoding: 10000,
  lookup: 5000,
  batch: 30000,
  total: 60000
};

export const DEFAULT_RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 5000,
  backoffMultiplier: 2,
  jitter: true
};

export const DEFAULT_RATE_LIMIT = 100; // requests per minute

// Rate limiting store
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

// Validation interfaces
export interface ValidationResult {
  valid: boolean;
  sanitized?: QueryParams;
  error?: string;
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  jitter: boolean;
}

// Geometry utility functions
export function isPointInPolygon(lon: number, lat: number, geometry: GeoJSONGeometry): boolean {
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

export function polygonContains(point: number[], polygon: number[][][]): boolean {
  // polygon: [ [ [lon,lat], ... ] outerRing, hole1, hole2, ... ]
  if (!Array.isArray(polygon) || polygon.length === 0) return false;
  // Must be inside outer ring and outside holes
  if (!ringContains(point, polygon[0] as number[][])) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (ringContains(point, polygon[i])) return false; // inside a hole
  }
  return true;
}

export function ringContains(point: number[], ring: number[][]): boolean {
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

// Input validation and sanitization
export function sanitizeString(input: string | undefined, maxLength: number = 1000): string | undefined {
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
export function validateCoordinates(lat: number | undefined, lon: number | undefined): { valid: boolean; lat?: number; lon?: number; error?: string } {
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
export function validatePostalCode(postal: string): { valid: boolean; sanitized?: string; error?: string } {
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
export function validateAndSanitizeQuery(query: QueryParams): ValidationResult {
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

// Retry utility function
export async function withRetry<T>(
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
        config.baseDelay * Math.pow(config.backoffMultiplier, attempt - 1),
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

// Timeout utility function
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${operation} timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  
  return Promise.race([promise, timeoutPromise]);
}

// Rate limiting functions
export function checkRateLimit(env: Env, clientId: string): boolean {
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

export function getClientId(request: Request): string {
  // Use IP address or API key for rate limiting
  const apiKey = request.headers.get("X-Google-API-Key");
  if (apiKey) return `api:${apiKey}`;
  
  const cfConnectingIp = request.headers.get("CF-Connecting-IP");
  const xForwardedFor = request.headers.get("X-Forwarded-For");
  const ip = cfConnectingIp || xForwardedFor?.split(',')[0] || "unknown";
  return `ip:${ip}`;
}

// Dataset selection
export function pickDataset(pathname: string): { r2Key: string } {
  // Map routes to R2 object keys
  if (pathname === "/api/qc") return { r2Key: "quebecridings-2025.geojson" };
  if (pathname === "/api/on") return { r2Key: "ontarioridings-2022.geojson" };
  // default federal
  return { r2Key: "federalridings-2024.geojson" };
}

// Query parsing
export function parseQuery(request: Request): { query: QueryParams; validation: ValidationResult } {
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

// Response utility functions
export function badRequest(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" }
  });
}

export function unauthorizedResponse() {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { 
      "content-type": "application/json; charset=UTF-8",
      "WWW-Authenticate": "Basic realm=\"Riding Lookup API\""
    }
  });
}

export function rateLimitExceededResponse() {
  return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
    status: 429,
    headers: { 
      "content-type": "application/json; charset=UTF-8",
      "Retry-After": "60"
    }
  });
}

// Authentication
export function checkBasicAuth(request: Request, env: Env): boolean {
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

// Geometry simplification
export function simplifyGeometry(geometry: any, tolerance: number, maxVertices: number): GeoJSONGeometry {
  // Handle Point geometry (no simplification needed)
  if (geometry.type === 'Point') {
    return geometry;
  }
  
  // Handle LineString geometry
  if (geometry.type === 'LineString') {
    return {
      type: 'LineString',
      coordinates: simplifyLineString(geometry.coordinates, tolerance, maxVertices)
    };
  }
  
  // Handle Polygon geometry
  if (geometry.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: geometry.coordinates.map((ring: number[][]) => 
        simplifyLineString(ring, tolerance, maxVertices)
      )
    };
  }
  
  // Handle MultiPolygon geometry
  if (geometry.type === 'MultiPolygon') {
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map((polygon: number[][][]) =>
        polygon.map((ring: number[][]) => 
          simplifyLineString(ring, tolerance, maxVertices)
        )
      )
    };
  }
  
  // Return original geometry if type is not supported
  return geometry;
}

export function simplifyLineString(coordinates: number[][], tolerance: number, maxVertices: number): number[][] {
  if (coordinates.length <= 2) {
    return coordinates;
  }
  
  // Simple Douglas-Peucker algorithm implementation
  const simplified: number[][] = [];
  const start = coordinates[0];
  const end = coordinates[coordinates.length - 1];
  
  simplified.push(start);
  
  let maxDistance = 0;
  let maxIndex = 0;
  
  for (let i = 1; i < coordinates.length - 1; i++) {
    const distance = pointToLineDistance(coordinates[i], start, end);
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }
  
  if (maxDistance > tolerance && simplified.length < maxVertices) {
    const left = coordinates.slice(0, maxIndex + 1);
    const right = coordinates.slice(maxIndex);
    
    const leftSimplified = simplifyLineString(left, tolerance, maxVertices);
    const rightSimplified = simplifyLineString(right, tolerance, maxVertices);
    
    simplified.push(...leftSimplified.slice(1, -1));
    simplified.push(...rightSimplified.slice(1));
  } else {
    simplified.push(end);
  }
  
  return simplified;
}

function pointToLineDistance(point: number[], lineStart: number[], lineEnd: number[]): number {
  const A = point[0] - lineStart[0];
  const B = point[1] - lineStart[1];
  const C = lineEnd[0] - lineStart[0];
  const D = lineEnd[1] - lineStart[1];
  
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  
  if (lenSq === 0) {
    return Math.sqrt(A * A + B * B);
  }
  
  const param = dot / lenSq;
  
  let xx, yy;
  if (param < 0) {
    xx = lineStart[0];
    yy = lineStart[1];
  } else if (param > 1) {
    xx = lineEnd[0];
    yy = lineEnd[1];
  } else {
    xx = lineStart[0] + param * C;
    yy = lineStart[1] + param * D;
  }
  
  const dx = point[0] - xx;
  const dy = point[1] - yy;
  
  return Math.sqrt(dx * dx + dy * dy);
}
