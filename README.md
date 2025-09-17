## Riding Lookup Cloudflare Worker

Provides three GET routes that return riding properties for a given location in Canada by testing the point against large GeoJSON datasets stored in R2.

- `/` — Federal ridings
- `/qc` — Quebec provincial ridings
- `/on` — Ontario provincial ridings

### Query parameters
Provide either coordinates or a geocodable string:

- `lat` and `lon` (or `lng` / `long`)
- `address` or `postal` (e.g., `H2X 1Y4` or `M5V 2T6`)

Examples:
- `GET /?lat=45.5017&lon=-73.5673`
- `GET /qc?address=350%20Rue%20St-Paul%20E,%20Montréal`
- `GET /on?postal=M5V2T6`

Response:
```json
{
  "query": { "lat": 45.5017, "lon": -73.5673 },
  "point": { "lon": -73.5673, "lat": 45.5017 },
  "properties": { /* properties from matching feature, or null */ }
}
```

### Setup

1) Install Wrangler and login
```bash
npm i -g wrangler
wrangler login
```

2) Create R2 bucket and set bindings
- Bucket is defined in `wrangler.toml` as `RIDINGS` named `ridings`.
```bash
wrangler r2 bucket create ridings
```

3) Upload GeoJSON files to R2 with exact keys expected by the worker:
```bash
wrangler r2 object put ridings/federalridings-2024.geojson --file ./federalridings-2024.geojson
wrangler r2 object put ridings/quebecridings-2025.geojson --file ./quebecridings-2025.geojson
wrangler r2 object put ridings/ontarioridings-2022.geojson --file ./ontarioridings-2022.geojson
```

4) Configure geocoder (optional)
- Default: Nominatim (no key). Set `GEOCODER = "nominatim"` in `wrangler.toml` (already set).
- Mapbox:
```bash
wrangler secret put MAPBOX_TOKEN
```
And set `GEOCODER = "mapbox"` in `wrangler.toml`.

### Develop and deploy
- Local dev (uses remote R2):
```bash
wrangler dev
```
- Deploy:
```bash
wrangler deploy
```

### Notes
- Very large GeoJSONs are parsed and cached in-memory per Worker isolate. Deploy with sufficient memory/CPU if needed.
- Point-in-polygon uses ray casting and supports `Polygon` and `MultiPolygon`.
