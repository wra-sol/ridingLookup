/// <reference types="@cloudflare/workers-types" />

export interface Env {
  RIDINGS: R2Bucket;
  GEOCODER?: string;
  MAPBOX_TOKEN?: string;
  GOOGLE_MAPS_KEY?: string;
  BASIC_AUTH?: string;
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

// Minimal Google Geocoding API response types we use
interface GoogleGeocodeLocation { lat: number; lng: number }
interface GoogleGeocodeGeometry { location: GoogleGeocodeLocation }
interface GoogleGeocodeResult { geometry: GoogleGeocodeGeometry }
interface GoogleGeocodeResponse { status: string; results: GoogleGeocodeResult[] }

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

async function loadGeo(env: Env, key: string): Promise<GeoJSONFeatureCollection> {
  const cached = geoCache.get(key);
  if (cached) return cached;
  const obj = await env.RIDINGS.get(key);
  if (!obj) throw new Error(`GeoJSON not found in R2: ${key}`);
  const text = await obj.text();
  const json = JSON.parse(text);
  // Basic shape check
  if (!json || json.type !== "FeatureCollection" || !Array.isArray(json.features)) {
    throw new Error(`Invalid GeoJSON FeatureCollection: ${key}`);
  }
  geoCache.set(key, json);
  return json;
}

function pickDataset(pathname: string): { r2Key: string } {
  // Map routes to R2 object keys
  if (pathname === "/qc") return { r2Key: "quebecridings-2025.geojson" };
  if (pathname === "/on") return { r2Key: "ontarioridings-2022.geojson" };
  // default federal
  return { r2Key: "federalridings-2024.geojson" };
}

function parseQuery(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams;
  const address = q.get("address") || undefined;
  const postal = q.get("postal") || q.get("postal_code") || undefined;
  const city = q.get("city") || undefined;
  const state = q.get("state") || q.get("province") || undefined;
  const country = q.get("country") || undefined;
  const latStr = q.get("lat");
  const lonStr = q.get("lon") || q.get("lng") || q.get("long");
  const lat = latStr ? Number(latStr) : undefined;
  const lon = lonStr ? Number(lonStr) : undefined;
  return { address, postal, city, state, country, lat, lon };
}

async function geocodeIfNeeded(env: Env, qp: QueryParams): Promise<{ lon: number; lat: number; }> {
  if (typeof qp.lat === "number" && typeof qp.lon === "number") {
    return { lon: qp.lon, lat: qp.lat };
  }
  const query = qp.address || qp.postal || qp.city || qp.state || qp.country;
  if (!query) throw new Error("Missing location: provide lat/lon or address/postal");

  const provider = (env.GEOCODER || "nominatim").toLowerCase();
  if (provider === "google") {
    const key = env.GOOGLE_MAPS_KEY;
    if (!key) throw new Error("GOOGLE_MAPS_KEY not configured");
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
    return { lon: loc.lng, lat: loc.lat };
  }
  if (provider === "mapbox") {
    const token = env.MAPBOX_TOKEN;
    if (!token) throw new Error("MAPBOX_TOKEN not configured");
    const resp = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?limit=1&proximity=ca&access_token=${token}`, {
      headers: { "User-Agent": "riding-lookup/1.0" }
    });
    if (!resp.ok) throw new Error(`Mapbox error: ${resp.status}`);
    const data = await resp.json() as MapboxResponse;
    const feat = data?.features?.[0];
    if (!feat?.center) throw new Error("No results from Mapbox");
    return { lon: feat.center[0], lat: feat.center[1] };
  }

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
  return { lon: Number(first.lon), lat: Number(first.lat) };
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
  const { r2Key } = pickDataset(pathname);
  const fc = await loadGeo(env, r2Key);
  for (const feat of fc.features) {
    const props = featurePropertiesIfContains(feat, lon, lat);
    if (props) return { properties: props };
  }
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      // Check basic authentication first
      if (!checkBasicAuth(request, env)) {
        return unauthorizedResponse();
      }
      
      const url = new URL(request.url);
      const pathname = url.pathname;
      if (request.method !== "GET") return badRequest("Only GET supported", 405);
      if (pathname !== "/" && pathname !== "/qc" && pathname !== "/on") {
        return badRequest("Not found", 404);
      }

      const q = parseQuery(request);
      const { lon, lat } = await geocodeIfNeeded(env, q);
      const result = await lookupRiding(env, pathname, lon, lat);
      return new Response(JSON.stringify({ query: q, point: { lon, lat }, ...result }), {
        headers: { "content-type": "application/json; charset=UTF-8" }
      });
    } catch (err: unknown) {
      return badRequest(err instanceof Error ? err.message : "Unexpected error", 400);
    }
  }
};
