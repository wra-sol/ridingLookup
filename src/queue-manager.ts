/// <reference types="@cloudflare/workers-types" />

export interface QueueJob {
  id: string;
  batchId: string;
  request: BatchLookupRequest;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'retrying';
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  nextRetryAt?: number;
  result?: BatchLookupResponse;
  error?: string;
  processingTime?: number;
}

export interface BatchJob {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'partially_completed';
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  results: BatchLookupResponse[];
  errors: string[];
}

export interface BatchLookupRequest {
  id: string;
  query: QueryParams;
  pathname: string;
}

export interface BatchLookupResponse {
  id: string;
  query: QueryParams;
  point?: { lon: number; lat: number };
  properties: Record<string, unknown> | null;
  error?: string;
  processingTime: number;
}

export interface QueryParams {
  address?: string;
  postal?: string;
  lat?: number;
  lon?: number;
  city?: string;
  state?: string;
  country?: string;
}

export interface QueueStats {
  totalJobs: number;
  pendingJobs: number;
  processingJobs: number;
  completedJobs: number;
  failedJobs: number;
  retryingJobs: number;
  deadLetterJobs: number;
  averageProcessingTime: number;
  successRate: number;
}

export class QueueManager {
  private state: DurableObjectState;
  private env: any;
  private jobs: Map<string, QueueJob> = new Map();
  private batches: Map<string, BatchJob> = new Map();
  private processingQueue: string[] = [];
  private retryQueue: string[] = [];
  private deadLetterQueue: string[] = [];
  private stats: QueueStats = {
    totalJobs: 0,
    pendingJobs: 0,
    processingJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    retryingJobs: 0,
    deadLetterJobs: 0,
    averageProcessingTime: 0,
    successRate: 0
  };

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case '/queue/submit':
          return await this.handleSubmitBatch(request);
        case '/queue/status':
          return await this.handleGetStatus(request);
        case '/queue/job':
          return await this.handleGetJob(request);
        case '/queue/batch':
          return await this.handleGetBatch(request);
        case '/queue/stats':
          return await this.handleGetStats();
        case '/queue/retry':
          return await this.handleRetryFailed(request);
        case '/queue/process':
          return await this.handleProcessJobs(request);
        case '/queue/health':
          return await this.handleHealthCheck();
        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (error) {
      console.error('Queue manager error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleSubmitBatch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const body = await request.json();
    const { requests } = body;

    if (!Array.isArray(requests) || requests.length === 0) {
      return new Response(JSON.stringify({ error: 'Invalid requests array' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const batchJob: BatchJob = {
      id: batchId,
      status: 'pending',
      totalJobs: requests.length,
      completedJobs: 0,
      failedJobs: 0,
      createdAt: Date.now(),
      results: [],
      errors: []
    };

    // Create individual jobs
    const jobIds: string[] = [];
    for (let i = 0; i < requests.length; i++) {
      const req = requests[i];
      const jobId = `${batchId}_job_${i}`;
      
      const job: QueueJob = {
        id: jobId,
        batchId,
        request: {
          id: req.id || `req_${i}`,
          query: req.query,
          pathname: req.pathname
        },
        status: 'pending',
        attempts: 0,
        maxAttempts: 5, // Configurable
        createdAt: Date.now()
      };

      this.jobs.set(jobId, job);
      this.processingQueue.push(jobId);
      jobIds.push(jobId);
    }

    this.batches.set(batchId, batchJob);
    this.updateStats();

    return new Response(JSON.stringify({
      batchId,
      totalJobs: requests.length,
      status: 'submitted',
      message: 'Batch submitted successfully'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleGetStatus(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const batchId = url.searchParams.get('batchId');
    const jobId = url.searchParams.get('jobId');

    if (batchId) {
      const batch = this.batches.get(batchId);
      if (!batch) {
        return new Response(JSON.stringify({ error: 'Batch not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify(batch), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (jobId) {
      const job = this.jobs.get(jobId);
      if (!job) {
        return new Response(JSON.stringify({ error: 'Job not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify(job), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Missing batchId or jobId parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleGetJob(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const jobId = url.searchParams.get('id');
    
    if (!jobId) {
      return new Response(JSON.stringify({ error: 'Missing job id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const job = this.jobs.get(jobId);
    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify(job), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleGetBatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const batchId = url.searchParams.get('id');
    
    if (!batchId) {
      return new Response(JSON.stringify({ error: 'Missing batch id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const batch = this.batches.get(batchId);
    if (!batch) {
      return new Response(JSON.stringify({ error: 'Batch not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify(batch), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleGetStats(): Promise<Response> {
    this.updateStats();
    return new Response(JSON.stringify(this.stats), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleRetryFailed(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const body = await request.json();
    const { jobIds } = body;

    if (!Array.isArray(jobIds)) {
      return new Response(JSON.stringify({ error: 'Invalid jobIds array' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let retriedCount = 0;
    for (const jobId of jobIds) {
      const job = this.jobs.get(jobId);
      if (job && (job.status === 'failed' || job.status === 'retrying')) {
        job.status = 'pending';
        job.attempts = 0;
        job.error = undefined;
        job.nextRetryAt = undefined;
        this.processingQueue.push(jobId);
        retriedCount++;
      }
    }

    this.updateStats();

    return new Response(JSON.stringify({
      message: `Retried ${retriedCount} jobs`,
      retriedCount
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleProcessJobs(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const body = await request.json();
    const { maxJobs = 10 } = body;

    const jobsToProcess = this.processingQueue.splice(0, maxJobs);
    const results = [];

    for (const jobId of jobsToProcess) {
      const job = this.jobs.get(jobId);
      if (!job) continue;

      try {
        job.status = 'processing';
        job.startedAt = Date.now();
        job.attempts++;

        // This would call the actual processing logic
        // For now, we'll simulate processing
        const result = await this.processJob(job);
        
        job.status = 'completed';
        job.completedAt = Date.now();
        job.result = result;
        job.processingTime = job.completedAt - job.startedAt!;

        // Update batch
        const batch = this.batches.get(job.batchId);
        if (batch) {
          batch.completedJobs++;
          batch.results.push(result);
          if (batch.completedJobs + batch.failedJobs >= batch.totalJobs) {
            batch.status = batch.failedJobs > 0 ? 'partially_completed' : 'completed';
            batch.completedAt = Date.now();
          }
        }

        results.push({ jobId, status: 'completed', result });
      } catch (error) {
        job.status = 'failed';
        job.error = error.message;
        job.completedAt = Date.now();

        // Check if we should retry
        if (job.attempts < job.maxAttempts) {
          job.status = 'retrying';
          job.nextRetryAt = Date.now() + this.calculateRetryDelay(job.attempts);
          this.retryQueue.push(jobId);
        } else {
          // Move to dead letter queue
          this.deadLetterQueue.push(jobId);
        }

        // Update batch
        const batch = this.batches.get(job.batchId);
        if (batch) {
          batch.failedJobs++;
          batch.errors.push(`${jobId}: ${error.message}`);
          if (batch.completedJobs + batch.failedJobs >= batch.totalJobs) {
            batch.status = batch.completedJobs > 0 ? 'partially_completed' : 'failed';
            batch.completedAt = Date.now();
          }
        }

        results.push({ jobId, status: 'failed', error: error.message });
      }
    }

    this.updateStats();

    return new Response(JSON.stringify({
      processedJobs: results.length,
      results
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleHealthCheck(): Promise<Response> {
    const health = {
      status: 'healthy',
      timestamp: Date.now(),
      stats: this.stats,
      queueLengths: {
        processing: this.processingQueue.length,
        retry: this.retryQueue.length,
        deadLetter: this.deadLetterQueue.length
      }
    };

    return new Response(JSON.stringify(health), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async processJob(job: QueueJob): Promise<BatchLookupResponse> {
    // This is a placeholder - in reality, this would call the actual lookup logic
    // For now, we'll simulate processing time and return a mock result
    await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 100));
    
    return {
      id: job.request.id,
      query: job.request.query,
      point: { lon: -75.6972, lat: 45.4215 },
      properties: { FED_NUM: "35047", FED_NAME: "Ottawa Centre" },
      processingTime: Date.now() - job.startedAt!
    };
  }

  private calculateRetryDelay(attempt: number): number {
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    return Math.min(1000 * Math.pow(2, attempt - 1), 30000);
  }

  private updateStats(): void {
    let totalJobs = 0;
    let pendingJobs = 0;
    let processingJobs = 0;
    let completedJobs = 0;
    let failedJobs = 0;
    let retryingJobs = 0;
    let deadLetterJobs = 0;
    let totalProcessingTime = 0;
    let completedCount = 0;

    for (const job of this.jobs.values()) {
      totalJobs++;
      totalProcessingTime += job.processingTime || 0;
      
      switch (job.status) {
        case 'pending':
          pendingJobs++;
          break;
        case 'processing':
          processingJobs++;
          break;
        case 'completed':
          completedJobs++;
          completedCount++;
          break;
        case 'failed':
          failedJobs++;
          break;
        case 'retrying':
          retryingJobs++;
          break;
      }
    }

    deadLetterJobs = this.deadLetterQueue.length;

    this.stats = {
      totalJobs,
      pendingJobs,
      processingJobs,
      completedJobs,
      failedJobs,
      retryingJobs,
      deadLetterJobs,
      averageProcessingTime: completedCount > 0 ? totalProcessingTime / completedCount : 0,
      successRate: totalJobs > 0 ? (completedJobs / totalJobs) * 100 : 0
    };
  }
}

export { QueueManager as QueueManagerDO };
