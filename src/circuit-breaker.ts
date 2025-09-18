import { CircuitBreakerState } from './types';

export class CircuitBreaker {
  private states = new Map<string, CircuitBreakerState>();
  private failureThreshold: number;
  private recoveryTimeout: number;
  private successThreshold: number;

  constructor(failureThreshold = 5, recoveryTimeout = 60000, successThreshold = 3) {
    this.failureThreshold = failureThreshold;
    this.recoveryTimeout = recoveryTimeout;
    this.successThreshold = successThreshold;
  }

  async execute<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const state = this.getState(key);
    
    if (state.state === 'OPEN') {
      if (Date.now() - state.lastFailureTime > this.recoveryTimeout) {
        state.state = 'HALF_OPEN';
        state.successCount = 0;
      } else {
        throw new Error(`Circuit breaker is OPEN for ${key}`);
      }
    }

    try {
      const result = await operation();
      this.onSuccess(key);
      return result;
    } catch (error) {
      this.onFailure(key);
      throw error;
    }
  }

  private getState(key: string): CircuitBreakerState {
    if (!this.states.has(key)) {
      this.states.set(key, {
        state: 'CLOSED',
        failureCount: 0,
        lastFailureTime: 0,
        successCount: 0,
        nextAttemptTime: 0
      });
    }
    return this.states.get(key)!;
  }

  private onSuccess(key: string): void {
    const state = this.getState(key);
    state.failureCount = 0;
    
    if (state.state === 'HALF_OPEN') {
      state.successCount++;
      if (state.successCount >= this.successThreshold) {
        state.state = 'CLOSED';
      }
    }
  }

  private onFailure(key: string): void {
    const state = this.getState(key);
    state.failureCount++;
    state.lastFailureTime = Date.now();
    state.nextAttemptTime = Date.now() + this.recoveryTimeout;
    
    if (state.failureCount >= this.failureThreshold) {
      state.state = 'OPEN';
    }
  }

  getStateInfo(key: string): CircuitBreakerState | null {
    return this.states.get(key) || null;
  }

  // Get all circuit breaker states for monitoring
  getAllStates(): Map<string, CircuitBreakerState> {
    return new Map(this.states);
  }

  // Reset a specific circuit breaker
  reset(key: string): void {
    this.states.delete(key);
  }

  // Reset all circuit breakers
  resetAll(): void {
    this.states.clear();
  }
}

// Create circuit breaker instances
export const geocodingCircuitBreaker = new CircuitBreaker(3, 30000, 2); // 3 failures, 30s timeout, 2 successes to close
export const r2CircuitBreaker = new CircuitBreaker(5, 60000, 3); // 5 failures, 60s timeout, 3 successes to close
