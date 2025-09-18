import { WebhookConfig, WebhookEvent, WebhookDelivery } from './types';

// Webhook configuration
export const WEBHOOK_CONFIG = {
  ENABLED: true,
  MAX_RETRY_ATTEMPTS: 5,
  RETRY_DELAY: 5000, // 5 seconds
  TIMEOUT: 30000, // 30 seconds
  MAX_WEBHOOKS: 10,
  CLEANUP_INTERVAL: 24 * 60 * 60 * 1000, // 24 hours
  MAX_EVENT_AGE: 7 * 24 * 60 * 60 * 1000 // 7 days
};

// In-memory storage for webhook data
export const webhookConfigs = new Map<string, WebhookConfig>();
export const webhookEvents = new Map<string, WebhookEvent>();
export const webhookDeliveries = new Map<string, WebhookDelivery>();

// ID generation functions
export function generateWebhookId(): string {
  return `webhook_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function generateEventId(): string {
  return `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function generateDeliveryId(): string {
  return `delivery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Create webhook event
export async function createWebhookEvent(webhookId: string, eventType: string, batchId: string, payload: any): Promise<string> {
  const eventId = generateEventId();
  const event: WebhookEvent = {
    id: eventId,
    webhookId,
    eventType,
    batchId,
    status: 'pending',
    payload,
    createdAt: Date.now(),
    attempts: 0,
    maxAttempts: WEBHOOK_CONFIG.MAX_RETRY_ATTEMPTS,
    lastAttempt: undefined,
    nextRetry: undefined
  };
  
  webhookEvents.set(eventId, event);
  return eventId;
}

// Create webhook signature
export async function createWebhookSignature(secret: string, payload: string): Promise<string> {
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

// Deliver webhook
export async function deliverWebhook(webhookId: string, eventId: string): Promise<boolean> {
  const webhook = webhookConfigs.get(webhookId);
  const event = webhookEvents.get(eventId);
  
  if (!webhook || !event || !webhook.active) {
    return false;
  }
  
  const deliveryId = generateDeliveryId();
  const startTime = Date.now();
  const delivery: WebhookDelivery = {
    id: deliveryId,
    webhookId,
    eventId,
    status: 'success',
    responseCode: undefined,
    responseBody: undefined,
    attemptedAt: startTime,
    duration: 0,
    error: undefined
  };
  
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
      signal: AbortSignal.timeout(WEBHOOK_CONFIG.TIMEOUT)
    });
    
    const endTime = Date.now();
    delivery.duration = endTime - startTime;
    delivery.responseCode = response.status;
    delivery.responseBody = await response.text();
    
    if (response.ok) {
      delivery.status = 'success';
      event.status = 'delivered';
      event.attempts++;
      event.lastAttempt = endTime;
      webhookEvents.set(eventId, event);
      webhookDeliveries.set(deliveryId, delivery);
      return true;
    } else {
      delivery.status = 'failed';
      delivery.error = `HTTP ${response.status}: ${delivery.responseBody}`;
      webhookDeliveries.set(deliveryId, delivery);
      
      // Schedule retry if within limits
      if (event.attempts < event.maxAttempts) {
        event.status = 'pending';
        event.attempts++;
        event.nextRetry = Date.now() + WEBHOOK_CONFIG.RETRY_DELAY * Math.pow(2, event.attempts - 1);
        event.lastAttempt = endTime;
        webhookEvents.set(eventId, event);
      } else {
        event.status = 'failed';
        event.lastAttempt = endTime;
        webhookEvents.set(eventId, event);
      }
      
      return false;
    }
  } catch (error) {
    const endTime = Date.now();
    delivery.duration = endTime - startTime;
    delivery.status = 'failed';
    delivery.error = error instanceof Error ? error.message : 'Unknown error';
    webhookDeliveries.set(deliveryId, delivery);
    
    // Schedule retry if within limits
    if (event.attempts < event.maxAttempts) {
      event.status = 'pending';
      event.attempts++;
      event.nextRetry = Date.now() + WEBHOOK_CONFIG.RETRY_DELAY * Math.pow(2, event.attempts - 1);
      event.lastAttempt = endTime;
      webhookEvents.set(eventId, event);
    } else {
      event.status = 'failed';
      event.lastAttempt = endTime;
      webhookEvents.set(eventId, event);
    }
    
    return false;
  }
}

// Process webhook events
export async function processWebhookEvents(): Promise<void> {
  if (!WEBHOOK_CONFIG.ENABLED) {
    return;
  }
  
  const now = Date.now();
  const eventsToProcess: WebhookEvent[] = [];
  
  // Find events that need processing
  for (const event of webhookEvents.values()) {
    if (event.status === 'pending' || 
        (event.status === 'pending' && event.nextRetry && now >= event.nextRetry)) {
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

// Cleanup old webhook data
export async function cleanupWebhookData(): Promise<void> {
  const now = Date.now();
  const maxAge = WEBHOOK_CONFIG.MAX_EVENT_AGE;
  
  // Clean up old events
  for (const [eventId, event] of webhookEvents.entries()) {
    if (now - event.createdAt > maxAge) {
      webhookEvents.delete(eventId);
    }
  }
  
  // Clean up old deliveries
  for (const [deliveryId, delivery] of webhookDeliveries.entries()) {
    if (now - delivery.attemptedAt > maxAge) {
      webhookDeliveries.delete(deliveryId);
    }
  }
}

// Initialize webhook processing
export function initializeWebhookProcessing(): void {
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
export async function triggerBatchCompletionWebhook(batchId: string, batchStatus: any): Promise<void> {
  if (!WEBHOOK_CONFIG.ENABLED) {
    return;
  }
  
  const payload = {
    event: 'batch.completed',
    batchId,
    timestamp: Date.now(),
    status: batchStatus.status,
    results: batchStatus.results,
    errors: batchStatus.errors,
    processingTime: batchStatus.completedAt - batchStatus.createdAt
  };
  
  // Create events for all enabled webhooks
  for (const [webhookId, webhook] of webhookConfigs.entries()) {
    if (webhook.active && webhook.events.includes('batch.completed')) {
      try {
        await createWebhookEvent(webhookId, 'batch.completed', batchId, payload);
      } catch (error) {
        console.error(`Failed to create webhook event for ${webhookId}:`, error);
      }
    }
  }
}

// Webhook management functions
export function createWebhook(config: Omit<WebhookConfig, 'createdAt' | 'lastDelivery' | 'failureCount' | 'maxFailures'>): string {
  if (webhookConfigs.size >= WEBHOOK_CONFIG.MAX_WEBHOOKS) {
    throw new Error('Maximum number of webhooks reached');
  }
  
  const webhookId = generateWebhookId();
  const webhook: WebhookConfig = {
    ...config,
    createdAt: Date.now(),
    lastDelivery: undefined,
    failureCount: 0,
    maxFailures: 5
  };
  
  webhookConfigs.set(webhookId, webhook);
  return webhookId;
}

export function updateWebhook(webhookId: string, updates: Partial<WebhookConfig>): boolean {
  const webhook = webhookConfigs.get(webhookId);
  if (!webhook) {
    return false;
  }
  
  const updatedWebhook = { ...webhook, ...updates };
  webhookConfigs.set(webhookId, updatedWebhook);
  return true;
}

export function deleteWebhook(webhookId: string): boolean {
  return webhookConfigs.delete(webhookId);
}

export function getWebhook(webhookId: string): WebhookConfig | undefined {
  return webhookConfigs.get(webhookId);
}

export function getAllWebhooks(): Map<string, WebhookConfig> {
  return new Map(webhookConfigs);
}

export function getWebhookEvents(webhookId?: string): WebhookEvent[] {
  if (webhookId) {
    return Array.from(webhookEvents.values()).filter(event => event.webhookId === webhookId);
  }
  return Array.from(webhookEvents.values());
}

export function getWebhookDeliveries(webhookId?: string): WebhookDelivery[] {
  if (webhookId) {
    return Array.from(webhookDeliveries.values()).filter(delivery => delivery.webhookId === webhookId);
  }
  return Array.from(webhookDeliveries.values());
}
