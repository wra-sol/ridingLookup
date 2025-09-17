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
  if (pathname === "/api/qc") return { r2Key: "quebecridings-2025.geojson" };
  if (pathname === "/api/on") return { r2Key: "ontarioridings-2022.geojson" };
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

async function geocodeIfNeeded(env: Env, qp: QueryParams, request?: Request): Promise<{ lon: number; lat: number; }> {
  if (typeof qp.lat === "number" && typeof qp.lon === "number") {
    return { lon: qp.lon, lat: qp.lat };
  }
  const query = qp.address || qp.postal || qp.city || qp.state || qp.country;
  if (!query) throw new Error("Missing location: provide lat/lon or address/postal");

  const provider = (env.GEOCODER || "nominatim").toLowerCase();
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

function createOpenAPISpec(baseUrl: string) {
  return {
    openapi: "3.0.0",
    info: {
      title: "Riding Lookup API",
      description: "Find Canadian federal, provincial, and territorial ridings by location. Supports multiple geocoding providers including Google Maps (BYOK), Mapbox, and Nominatim. Built on Cloudflare Workers for global edge performance.",
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
        
        <div class="byok-note">
            <strong>BYOK Benefits:</strong> Using your own Google Maps API key bypasses basic authentication and provides unlimited requests with enhanced geocoding accuracy. You get your own usage tracking and billing.
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
            <a href="${baseUrl}/api/docs" target="_blank">OpenAPI Docs</a>
            <a href="https://github.com" target="_blank">GitHub</a>
        </div>
    </div>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      
      if (request.method !== "GET") return badRequest("Only GET supported", 405);
      
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
      
      // Handle API routes (require authentication)
      if (pathname === "/api" || pathname === "/api/qc" || pathname === "/api/on") {
        // Check basic authentication for API routes
        if (!checkBasicAuth(request, env)) {
          return unauthorizedResponse();
        }
        
        const q = parseQuery(request);
        const { lon, lat } = await geocodeIfNeeded(env, q, request);
        const result = await lookupRiding(env, pathname, lon, lat);
        return new Response(JSON.stringify({ query: q, point: { lon, lat }, ...result }), {
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
      }
      
      return badRequest("Not found", 404)
    } catch (err: unknown) {
      return badRequest(err instanceof Error ? err.message : "Unexpected error", 400);
    }
  }
};
