// Documentation and UI functions

export function createLandingPage(baseUrl: string) {
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
            margin: 0;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
        }
        h1 {
            color: #333;
            text-align: center;
            margin-bottom: 10px;
        }
        .subtitle {
            text-align: center;
            color: #666;
            margin-bottom: 30px;
            font-size: 1.1em;
        }
        .feature {
            background: #f8f9fa;
            padding: 15px;
            margin: 15px 0;
            border-left: 4px solid #667eea;
            border-radius: 4px;
        }
        .example {
            background: #2d3748;
            color: #e2e8f0;
            padding: 15px;
            border-radius: 6px;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 14px;
            overflow-x: auto;
            margin: 15px 0;
        }
        .links {
            text-align: center;
            margin-top: 30px;
        }
        .links a {
            display: inline-block;
            margin: 10px;
            padding: 12px 24px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 6px;
            transition: background 0.3s;
        }
        .links a:hover {
            background: #5a67d8;
        }
        .byok-note {
            background: #e6fffa;
            border: 1px solid #81e6d9;
            padding: 15px;
            border-radius: 6px;
            margin: 20px 0;
        }
        .endpoint {
            background: #f7fafc;
            padding: 10px;
            border-radius: 4px;
            font-family: monospace;
            margin: 10px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🏛️ Riding Lookup API</h1>
        <p class="subtitle">Find Canadian federal, provincial, and territorial ridings by location</p>
        
        <div class="feature">
            <strong>🌍 Multi-Provider Geocoding:</strong> Google Maps (BYOK), Mapbox, and Nominatim support
        </div>
        
        <div class="feature">
            <strong>⚡ High Performance:</strong> Built on Cloudflare Workers with global edge caching
        </div>
        
        <div class="feature">
            <strong>📊 Batch Processing:</strong> Process multiple locations efficiently with queue-based processing
        </div>

        <div class="feature">
            <strong>🔧 BYOK Support:</strong> Bring Your Own Key for Google Maps API with unlimited requests
        </div>

        <h2>Quick Start</h2>
        
        <div class="endpoint">GET ${baseUrl}/api?postal=K1A 0A6</div>
        <div class="example">curl "${baseUrl}/api?postal=K1A 0A6"</div>
        
        <div class="endpoint">GET ${baseUrl}/api?address=123 Main St Toronto</div>
        <div class="example">curl "${baseUrl}/api?address=123%20Main%20St%20Toronto"</div>
        
        <div class="endpoint">GET ${baseUrl}/api?lat=45.4215&lon=-75.6972</div>
        <div class="example">curl "${baseUrl}/api?lat=45.4215&lon=-75.6972"</div>

        <h2>Available Datasets</h2>
        <ul>
            <li><strong>/api</strong> - Federal ridings (338 ridings)</li>
            <li><strong>/api/qc</strong> - Quebec provincial ridings (125 ridings)</li>
            <li><strong>/api/on</strong> - Ontario provincial ridings (124 ridings)</li>
        </ul>

        <h2>Advanced Features</h2>
        
        <h3>Database Operations</h3>
        <div class="example"># Initialize spatial database
curl -u "username:password" -X POST "${baseUrl}/api/database/init"

# Sync GeoJSON to database
curl -u "username:password" -X POST "${baseUrl}/api/database/sync" \\
  -H "Content-Type: application/json" \\
  -d '{"dataset": "federalridings-2024.geojson"}'

# Query database directly
curl "${baseUrl}/api/database/query?lat=45.4215&lon=-75.6972&dataset=federalridings-2024.geojson"

# Get database stats
curl -u "username:password" "${baseUrl}/api/database/stats"</div>

        <h3>Boundaries API</h3>
        <div class="example"># Lookup boundaries by coordinates
curl "${baseUrl}/api/boundaries/lookup?lat=45.4215&lon=-75.6972&dataset=federalridings-2024.geojson"

# Get all boundaries (paginated)
curl "${baseUrl}/api/boundaries/all?dataset=federalridings-2024.geojson&limit=50&offset=0"

# Get boundaries configuration
curl "${baseUrl}/api/boundaries/config"</div>

        <h3>Cache Management</h3>
        <div class="example"># Trigger cache warming
curl -u "username:password" -X POST "${baseUrl}/api/cache/warm" \\
  -H "Content-Type: application/json" \\
  -d '{
    "locations": [
      {"lat": 45.4215, "lon": -75.6972},
      {"postal": "K1A 0A6"}
    ]
  }'</div>

        <h3>Webhook Management</h3>
        <div class="example"># List webhooks
curl -u "username:password" "${baseUrl}/api/webhooks"

# Create webhook
curl -u "username:password" -X POST "${baseUrl}/api/webhooks" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://your-app.com/webhooks/riding-lookup",
    "events": ["batch.completed", "batch.failed"],
    "secret": "your-webhook-secret"
  }'

# Get webhook events
curl -u "username:password" "${baseUrl}/api/webhooks/events?status=pending"

# Get webhook deliveries
curl -u "username:password" "${baseUrl}/api/webhooks/deliveries?webhookId=webhook_123"</div>

        <h2>Authentication</h2>
        <p>For production use, include your credentials:</p>
        <div class="example">curl -u "username:password" "${baseUrl}/api?postal=K1A 0A6"</div>
        
        <p>Or use your own Google Maps API key to bypass authentication:</p>
        <div class="example">curl -H "X-Google-API-Key: YOUR_API_KEY" "${baseUrl}/api?address=123 Main St"</div>

        <h2>Batch Processing</h2>
        
        <h3>Immediate Batch Processing</h3>
        <div class="example">curl -u "username:password" -X POST "${baseUrl}/batch" \\
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
      },
      {
        "id": "req2",
        "pathname": "/api/qc",
        "query": { "address": "1234 Rue Saint-Denis, Montréal, QC" }
      }
    ]
  }'

# Check status
curl -u "username:password" "${baseUrl}/api/queue/status?batchId=batch_1234567890_abc123"

# Get queue stats
curl -u "username:password" "${baseUrl}/api/queue/stats"

# Process queue jobs (for workers)
curl -u "username:password" -X POST "${baseUrl}/api/queue/process" \\
  -H "Content-Type: application/json" \\
  -d '{"maxJobs": 10}'</div>
        
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

export function createSwaggerUI(baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Riding Lookup API - Swagger UI</title>
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@4.15.5/swagger-ui.css" />
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
    .swagger-ui .topbar {
      display: none;
    }
.swagger-ui .wrapper span:last-child div.opblock-tag-section:last-child {
      padding-top: 0;
      padding-bottom: 40px;
    }
}
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@4.15.5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@4.15.5/swagger-ui-standalone-preset.js"></script>
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
        layout: "StandaloneLayout"
      });
    };
  </script>
</body>
</html>`;
}

export function createOpenAPISpec(baseUrl: string) {
  return {
    openapi: "3.0.0",
    info: {
      title: "Riding Lookup API",
      description:
        "Find Canadian federal, provincial, and territorial ridings by location. Supports multiple geocoding providers including Google Maps (BYOK), Mapbox, and Nominatim. Features Google Maps batch geocoding for optimal performance and cost efficiency. Built on Cloudflare Workers for global edge performance.",
      version: "1.0.0",
      contact: {
        name: "API Support",
        url: "https://github.com",
        email: "support@example.com",
      },
      license: {
        name: "MIT",
        url: "https://opensource.org/licenses/MIT",
      },
    },
    servers: [
      {
        url: baseUrl,
        description: "Production server",
      },
    ],
    paths: {
      "/api": {
        get: {
          summary: "Lookup federal riding by location",
          description:
            "Find the federal riding for a given location using postal code, address, or coordinates",
          tags: ["Federal Ridings"],
          parameters: [
            {
              name: "postal",
              in: "query",
              description: "Canadian postal code (e.g., K1A 0A6)",
              required: false,
              schema: { type: "string", example: "K1A 0A6" },
            },
            {
              name: "address",
              in: "query",
              description: "Street address",
              required: false,
              schema: { type: "string", example: "123 Main St, Toronto, ON" },
            },
            {
              name: "lat",
              in: "query",
              description: "Latitude",
              required: false,
              schema: { type: "number", example: 45.4215 },
            },
            {
              name: "lon",
              in: "query",
              description: "Longitude",
              required: false,
              schema: { type: "number", example: -75.6972 },
            },
            {
              name: "city",
              in: "query",
              description: "City name",
              required: false,
              schema: { type: "string", example: "Toronto" },
            },
            {
              name: "state",
              in: "query",
              description: "Province or state",
              required: false,
              schema: { type: "string", example: "Ontario" },
            },
            {
              name: "country",
              in: "query",
              description: "Country",
              required: false,
              schema: { type: "string", example: "Canada" },
            },
          ],
          responses: {
            "200": {
              description: "Successful lookup",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      query: {
                        type: "object",
                        description: "The query parameters used",
                      },
                      point: {
                        type: "object",
                        properties: {
                          lon: { type: "number" },
                          lat: { type: "number" },
                        },
                        description: "Geocoded coordinates",
                      },
                      properties: {
                        type: "object",
                        description:
                          "Riding properties including FED_NUM, FED_NAME, etc.",
                        nullable: true,
                      },
                    },
                  },
                  example: {
                    query: { postal: "K1A 0A6" },
                    point: { lon: -75.6972, lat: 45.4215 },
                    properties: {
                      FED_NUM: "35047",
                      FED_NAME: "Ottawa Centre",
                      PROV_TERR: "Ontario",
                    },
                  },
                },
              },
            },
            "400": {
              description: "Bad request - invalid parameters",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      error: { type: "string" },
                    },
                  },
                },
              },
            },
            "401": {
              description: "Unauthorized - missing or invalid authentication",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      error: { type: "string" },
                    },
                  },
                },
              },
            },
            "429": {
              description: "Rate limit exceeded",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      error: { type: "string" },
                      retryAfter: { type: "number" },
                    },
                  },
                },
              },
            },
          },
          security: [{ basicAuth: [] }, { apiKey: [] }],
        },
      },
      "/api/qc": {
        get: {
          summary: "Lookup Quebec provincial riding by location",
          description: "Find the Quebec provincial riding for a given location",
          tags: ["Quebec Ridings"],
          parameters: [
            {
              name: "postal",
              in: "query",
              description: "Canadian postal code (e.g., H2Y 1C6)",
              required: false,
              schema: { type: "string", example: "H2Y 1C6" },
            },
            {
              name: "address",
              in: "query",
              description: "Street address",
              required: false,
              schema: {
                type: "string",
                example: "1234 Rue Saint-Denis, Montréal, QC",
              },
            },
            {
              name: "lat",
              in: "query",
              description: "Latitude",
              required: false,
              schema: { type: "number", example: 45.5017 },
            },
            {
              name: "lon",
              in: "query",
              description: "Longitude",
              required: false,
              schema: { type: "number", example: -73.5673 },
            },
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
                          lat: { type: "number" },
                        },
                      },
                      properties: {
                        type: "object",
                        nullable: true,
                      },
                    },
                  },
                },
              },
            },
          },
          security: [{ basicAuth: [] }, { apiKey: [] }],
        },
      },
      "/api/on": {
        get: {
          summary: "Lookup Ontario provincial riding by location",
          description:
            "Find the Ontario provincial riding for a given location",
          tags: ["Ontario Ridings"],
          parameters: [
            {
              name: "postal",
              in: "query",
              description: "Canadian postal code (e.g., M5H 2N2)",
              required: false,
              schema: { type: "string", example: "M5H 2N2" },
            },
            {
              name: "address",
              in: "query",
              description: "Street address",
              required: false,
              schema: { type: "string", example: "123 King St, Toronto, ON" },
            },
            {
              name: "lat",
              in: "query",
              description: "Latitude",
              required: false,
              schema: { type: "number", example: 43.6532 },
            },
            {
              name: "lon",
              in: "query",
              description: "Longitude",
              required: false,
              schema: { type: "number", example: -79.3832 },
            },
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
                          lat: { type: "number" },
                        },
                      },
                      properties: {
                        type: "object",
                        nullable: true,
                      },
                    },
                  },
                },
              },
            },
          },
          security: [{ basicAuth: [] }, { apiKey: [] }],
        },
      },
      "/batch": {
        post: {
          summary: "Process batch of lookup requests",
          description: "Process multiple lookup requests in a single call",
          tags: ["Batch Processing"],
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
                          pathname: {
                            type: "string",
                            enum: ["/api", "/api/qc", "/api/on"],
                          },
                          query: {
                            type: "object",
                            properties: {
                              postal: { type: "string" },
                              address: { type: "string" },
                              lat: { type: "number" },
                              lon: { type: "number" },
                              city: { type: "string" },
                              state: { type: "string" },
                              country: { type: "string" },
                            },
                          },
                        },
                        required: ["id", "pathname", "query"],
                      },
                    },
                  },
                  required: ["requests"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Batch processing completed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      results: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            query: { type: "object" },
                            point: { type: "object", nullable: true },
                            properties: { type: "object", nullable: true },
                            error: { type: "string" },
                            processingTime: { type: "number" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          security: [{ basicAuth: [] }, { apiKey: [] }],
        },
      },
      "/api/queue/submit": {
        post: {
          summary: "Submit Batch to Queue",
          description:
            "Submit a batch of riding lookups to the persistent queue for asynchronous processing. Returns immediately with batch ID for status tracking.",
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
                          pathname: {
                            type: "string",
                            enum: ["/api", "/api/qc", "/api/on"],
                          },
                          query: {
                            type: "object",
                            properties: {
                              postal: { type: "string" },
                              address: { type: "string" },
                              lat: { type: "number" },
                              lon: { type: "number" },
                              city: { type: "string" },
                              state: { type: "string" },
                              country: { type: "string" },
                            },
                          },
                        },
                        required: ["id", "pathname", "query"],
                      },
                    },
                  },
                  required: ["requests"],
                },
              },
            },
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
                      status: { type: "string" },
                      message: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          security: [{ basicAuth: [] }, { apiKey: [] }],
        },
      },
      "/api/queue/status": {
        get: {
          summary: "Get Batch Status",
          description:
            "Check the status of a submitted batch job including completion progress and results.",
          tags: ["Queue Operations"],
          parameters: [
            {
              name: "batchId",
              in: "query",
              description: "The batch ID returned from queue submission",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Batch status retrieved successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      batchId: { type: "string" },
                      status: {
                        type: "string",
                        enum: ["pending", "processing", "completed", "failed"],
                      },
                      progress: {
                        type: "object",
                        properties: {
                          total: { type: "number" },
                          completed: { type: "number" },
                          failed: { type: "number" },
                          pending: { type: "number" },
                        },
                      },
                      results: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            query: { type: "object" },
                            point: { type: "object", nullable: true },
                            properties: { type: "object", nullable: true },
                            error: { type: "string" },
                            processingTime: { type: "number" },
                          },
                        },
                      },
                      createdAt: { type: "string", format: "date-time" },
                      updatedAt: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
          },
          security: [{ basicAuth: [] }, { apiKey: [] }],
        },
      },
      "/api/queue/stats": {
        get: {
          summary: "Get Queue Statistics",
          description:
            "Get comprehensive statistics about the queue including job counts, processing times, and success rates.",
          tags: ["Queue Operations"],
          responses: {
            "200": {
              description: "Queue statistics retrieved successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      totalBatches: { type: "number" },
                      pendingBatches: { type: "number" },
                      processingBatches: { type: "number" },
                      completedBatches: { type: "number" },
                      failedBatches: { type: "number" },
                      totalJobs: { type: "number" },
                      pendingJobs: { type: "number" },
                      completedJobs: { type: "number" },
                      failedJobs: { type: "number" },
                      averageProcessingTime: { type: "number" },
                      successRate: { type: "number" },
                      lastUpdated: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
            },
          },
          security: [{ basicAuth: [] }, { apiKey: [] }],
        },
      },
      "/api/queue/process": {
        post: {
          summary: "Process Queue Jobs",
          description:
            "Process pending jobs from the queue. This endpoint is typically called by worker processes.",
          tags: ["Queue Operations"],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    maxJobs: {
                      type: "number",
                      description:
                        "Maximum number of jobs to process (default: 10)",
                      default: 10,
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Queue processing completed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      processed: { type: "number" },
                      successful: { type: "number" },
                      failed: { type: "number" },
                      results: { type: "array" },
                    },
                  },
                },
              },
            },
          },
          security: [{ basicAuth: [] }, { apiKey: [] }],
        },
      },
      "/api/database/init": {
        post: {
          summary: "Initialize Spatial Database",
          description: "Initialize the spatial database with required tables and indexes",
          tags: ["Database Operations"],
          responses: {
            "200": {
              description: "Database initialization completed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      message: { type: "string" }
                    }
                  }
                }
              }
            }
          },
          security: [{ basicAuth: [] }]
        }
      },
      "/api/database/sync": {
        post: {
          summary: "Sync GeoJSON to Database",
          description: "Synchronize GeoJSON data to the spatial database",
          tags: ["Database Operations"],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    dataset: { 
                      type: "string", 
                      enum: ["federalridings-2024.geojson", "quebecridings-2025.geojson", "ontarioridings-2022.geojson"],
                      default: "federalridings-2024.geojson"
                    }
                  }
                }
              }
            }
          },
          responses: {
            "200": {
              description: "Database sync completed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      success: { type: "boolean" },
                      message: { type: "string" },
                      dataset: { type: "string" }
                    }
                  }
                }
              }
            }
          },
          security: [{ basicAuth: [] }]
        }
      },
      "/api/database/stats": {
        get: {
          summary: "Get Database Statistics",
          description: "Get statistics about the spatial database",
          tags: ["Database Operations"],
          responses: {
            "200": {
              description: "Database statistics retrieved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      enabled: { type: "boolean" },
                      features: { type: "number" },
                      lastSync: { type: "string", format: "date-time", nullable: true },
                      status: { type: "string", enum: ["active", "disabled"] }
                    }
                  }
                }
              }
            }
          },
          security: [{ basicAuth: [] }]
        }
      },
      "/api/database/query": {
        get: {
          summary: "Query Database Directly",
          description: "Query the spatial database directly by coordinates",
          tags: ["Database Operations"],
          parameters: [
            {
              name: "lat",
              in: "query",
              description: "Latitude",
              required: true,
              schema: { type: "number", example: 45.4215 }
            },
            {
              name: "lon",
              in: "query",
              description: "Longitude",
              required: true,
              schema: { type: "number", example: -75.6972 }
            },
            {
              name: "dataset",
              in: "query",
              description: "Dataset to query",
              required: false,
              schema: { 
                type: "string", 
                enum: ["federalridings-2024.geojson", "quebecridings-2025.geojson", "ontarioridings-2022.geojson"],
                default: "federalridings-2024.geojson"
              }
            }
          ],
          responses: {
            "200": {
              description: "Database query successful",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      type: { type: "string" },
                      properties: { type: "object" },
                      geometry: { type: "object" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/boundaries/lookup": {
        get: {
          summary: "Lookup Boundaries by Coordinates",
          description: "Find boundaries using coordinates with optional dataset selection",
          tags: ["Boundaries"],
          parameters: [
            {
              name: "lat",
              in: "query",
              description: "Latitude",
              required: true,
              schema: { type: "number", example: 45.4215 }
            },
            {
              name: "lon",
              in: "query",
              description: "Longitude",
              required: true,
              schema: { type: "number", example: -75.6972 }
            },
            {
              name: "dataset",
              in: "query",
              description: "Dataset to search",
              required: false,
              schema: { 
                type: "string", 
                enum: ["federalridings-2024.geojson", "quebecridings-2025.geojson", "ontarioridings-2022.geojson"],
                default: "federalridings-2024.geojson"
              }
            }
          ],
          responses: {
            "200": {
              description: "Boundaries lookup successful",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      riding: { type: "string" },
                      properties: { type: "object" },
                      source: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/boundaries/all": {
        get: {
          summary: "Get All Boundaries",
          description: "Get all boundaries from the database with pagination",
          tags: ["Boundaries"],
          parameters: [
            {
              name: "dataset",
              in: "query",
              description: "Dataset to retrieve",
              required: false,
              schema: { 
                type: "string", 
                enum: ["federalridings-2024.geojson", "quebecridings-2025.geojson", "ontarioridings-2022.geojson"],
                default: "federalridings-2024.geojson"
              }
            },
            {
              name: "limit",
              in: "query",
              description: "Number of results to return",
              required: false,
              schema: { type: "number", default: 100, minimum: 1, maximum: 1000 }
            },
            {
              name: "offset",
              in: "query",
              description: "Number of results to skip",
              required: false,
              schema: { type: "number", default: 0, minimum: 0 }
            }
          ],
          responses: {
            "200": {
              description: "Boundaries retrieved successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      features: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            type: { type: "string" },
                            properties: { type: "object" },
                            geometry: { type: "object" }
                          }
                        }
                      },
                      total: { type: "number" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/boundaries/config": {
        get: {
          summary: "Get Boundaries Configuration",
          description: "Get configuration information for boundaries processing",
          tags: ["Boundaries"],
          responses: {
            "200": {
              description: "Boundaries configuration retrieved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      enabled: { type: "boolean" },
                      useRtreeIndex: { type: "boolean" },
                      batchInsertSize: { type: "number" },
                      datasets: {
                        type: "array",
                        items: { type: "string" }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/geocoding/batch/status": {
        get: {
          summary: "Get Geocoding Batch Status",
          description: "Get status and configuration of batch geocoding functionality",
          tags: ["Geocoding"],
          responses: {
            "200": {
              description: "Geocoding batch status retrieved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      enabled: { type: "boolean" },
                      maxBatchSize: { type: "number" },
                      timeout: { type: "number" },
                      retryAttempts: { type: "number" },
                      fallbackToIndividual: { type: "boolean" },
                      hasGoogleApiKey: { type: "boolean" },
                      timestamp: { type: "number" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/cache/warm": {
        post: {
          summary: "Trigger Cache Warming",
          description: "Manually trigger cache warming for specified locations",
          tags: ["Cache Management"],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    locations: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          lat: { type: "number" },
                          lon: { type: "number" },
                          postal: { type: "string" }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            "200": {
              description: "Cache warming initiated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      message: { type: "string" },
                      locations: { type: "number" },
                      timestamp: { type: "number" }
                    }
                  }
                }
              }
            }
          },
          security: [{ basicAuth: [] }]
        }
      },
      "/api/webhooks": {
        get: {
          summary: "List Webhooks",
          description: "Get list of all configured webhooks",
          tags: ["Webhook Management"],
          responses: {
            "200": {
              description: "Webhooks list retrieved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      webhooks: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            url: { type: "string" },
                            events: { type: "array", items: { type: "string" } },
                            secret: { type: "string", nullable: true },
                            createdAt: { type: "number" },
                            lastDelivery: { type: "number", nullable: true },
                            failureCount: { type: "number" },
                            maxFailures: { type: "number" },
                            active: { type: "boolean" }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          security: [{ basicAuth: [] }]
        },
        post: {
          summary: "Create Webhook",
          description: "Create a new webhook configuration",
          tags: ["Webhook Management"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    url: { type: "string", format: "uri" },
                    events: { 
                      type: "array", 
                      items: { type: "string" },
                      example: ["batch.completed", "batch.failed"]
                    },
                    secret: { type: "string", description: "Optional webhook secret" }
                  },
                  required: ["url", "events"]
                }
              }
            }
          },
          responses: {
            "200": {
              description: "Webhook created successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      webhookId: { type: "string" },
                      message: { type: "string" }
                    }
                  }
                }
              }
            }
          },
          security: [{ basicAuth: [] }]
        }
      },
      "/api/webhooks/events": {
        get: {
          summary: "Get Webhook Events",
          description: "Get webhook events with optional filtering",
          tags: ["Webhook Management"],
          parameters: [
            {
              name: "status",
              in: "query",
              description: "Filter by event status",
              required: false,
              schema: { type: "string", enum: ["pending", "delivered", "failed"] }
            },
            {
              name: "webhookId",
              in: "query",
              description: "Filter by webhook ID",
              required: false,
              schema: { type: "string" }
            }
          ],
          responses: {
            "200": {
              description: "Webhook events retrieved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      events: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            webhookId: { type: "string" },
                            eventType: { type: "string" },
                            status: { type: "string" },
                            payload: { type: "object" },
                            createdAt: { type: "number" }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          security: [{ basicAuth: [] }]
        }
      },
      "/api/webhooks/deliveries": {
        get: {
          summary: "Get Webhook Deliveries",
          description: "Get webhook delivery attempts with optional filtering",
          tags: ["Webhook Management"],
          parameters: [
            {
              name: "webhookId",
              in: "query",
              description: "Filter by webhook ID",
              required: false,
              schema: { type: "string" }
            },
            {
              name: "status",
              in: "query",
              description: "Filter by delivery status",
              required: false,
              schema: { type: "string", enum: ["pending", "success", "failed"] }
            }
          ],
          responses: {
            "200": {
              description: "Webhook deliveries retrieved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      deliveries: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            webhookId: { type: "string" },
                            eventId: { type: "string" },
                            status: { type: "string" },
                            responseCode: { type: "number", nullable: true },
                            responseBody: { type: "string", nullable: true },
                            attemptCount: { type: "number" },
                            createdAt: { type: "number" }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          security: [{ basicAuth: [] }]
        }
      },
      "/health": {
        get: {
          summary: "Health Check",
          description: "Get comprehensive health status including metrics, circuit breakers, and cache warming status",
          tags: ["System"],
          responses: {
            "200": {
              description: "Health status retrieved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", enum: ["healthy", "unhealthy"] },
                      timestamp: { type: "number" },
                      metrics: { type: "object" },
                      circuitBreakers: { type: "object" },
                      cacheWarming: { type: "object" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/metrics": {
        get: {
          summary: "Get Performance Metrics",
          description: "Get detailed performance metrics and statistics",
          tags: ["System"],
          responses: {
            "200": {
              description: "Metrics retrieved successfully",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      requests: {
                        type: "object",
                        properties: {
                          total: { type: "number" },
                          errors: { type: "number" },
                          errorRate: { type: "number" }
                        }
                      },
                      geocoding: { type: "object" },
                      r2: { type: "object" },
                      lookup: { type: "object" },
                      batch: { type: "object" },
                      webhooks: { type: "object" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/cache-warming": {
        get: {
          summary: "Get Cache Warming Status",
          description: "Get current cache warming status and configuration",
          tags: ["Cache Management"],
          responses: {
            "200": {
              description: "Cache warming status retrieved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      isRunning: { type: "boolean" },
                      lastWarmed: { type: "number" },
                      currentBatch: { type: "number" },
                      totalBatches: { type: "number" },
                      successCount: { type: "number" },
                      failureCount: { type: "number" },
                      nextWarmingTime: { type: "number" },
                      config: {
                        type: "object",
                        properties: {
                          enabled: { type: "boolean" },
                          interval: { type: "number" },
                          batchSize: { type: "number" }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/webhooks": {
        get: {
          summary: "List Webhooks (Legacy)",
          description: "Legacy endpoint for listing webhooks - use /api/webhooks instead",
          tags: ["Webhook Management"],
          responses: {
            "200": {
              description: "Webhooks list retrieved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      webhooks: {
                        type: "array",
                        items: { type: "object" }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/webhooks/events": {
        get: {
          summary: "Get Webhook Events (Legacy)",
          description: "Legacy endpoint for webhook events - use /api/webhooks/events instead",
          tags: ["Webhook Management"],
          responses: {
            "200": {
              description: "Webhook events retrieved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      events: { type: "array" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/webhooks/deliveries": {
        get: {
          summary: "Get Webhook Deliveries (Legacy)",
          description: "Legacy endpoint for webhook deliveries - use /api/webhooks/deliveries instead",
          tags: ["Webhook Management"],
          responses: {
            "200": {
              description: "Webhook deliveries retrieved",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      deliveries: { type: "array" }
                    }
                  }
                }
              }
            }
          }
        }
      },
    },
    securitySchemes: {
      basicAuth: {
        type: "http",
        scheme: "basic",
      },
      apiKey: {
        type: "apiKey",
        in: "header",
        name: "X-Google-API-Key",
        description: "Google Maps API key for BYOK authentication",
      },
    },
    tags: [
      {
        name: "Federal Ridings",
        description: "Operations for federal riding lookups",
      },
      {
        name: "Quebec Ridings",
        description: "Operations for Quebec provincial riding lookups",
      },
      {
        name: "Ontario Ridings",
        description: "Operations for Ontario provincial riding lookups",
      },
      {
        name: "Batch Processing",
        description: "Batch processing operations",
      },
      {
        name: "Queue Operations",
        description: "Queue-based batch processing operations",
      },
      {
        name: "Database Operations",
        description: "Spatial database management and operations",
      },
      {
        name: "Boundaries",
        description: "Boundary data access and configuration",
      },
      {
        name: "Geocoding",
        description: "Geocoding service management and status",
      },
      {
        name: "Cache Management",
        description: "Cache warming and management operations",
      },
      {
        name: "Webhook Management",
        description: "Webhook configuration and monitoring",
      },
      {
        name: "System",
        description: "System health and monitoring endpoints",
      },
    ],
  };
}
