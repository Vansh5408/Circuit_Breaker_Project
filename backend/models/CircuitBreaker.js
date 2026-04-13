const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * CircuitBreaker Schema - Stores the current state of the circuit breaker
 * 
 * States:
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Circuit is tripped, requests are rejected immediately
 * - HALF_OPEN: Testing phase, limited requests allowed to test recovery
 * 
 * Why persist to MongoDB?
 * 1. Survives server restarts - state is recovered automatically
 * 2. Enables multi-instance deployments - all servers share same state
 * 3. Provides audit trail for debugging and analytics
 * 4. Allows external tools to query/modify breaker state
 */
const CircuitSchema = new Schema({
  serviceName: { 
    type: String, 
    default: 'default',
    index: true  // Index for fast lookups by service
  },
  
  // Current state of the circuit breaker
  state: { 
    type: String, 
    enum: ['CLOSED', 'OPEN', 'HALF_OPEN'], 
    default: 'CLOSED',
    index: true  // Index for querying breakers by state
  },
  
  // Failure tracking
  failureCount: { type: Number, default: 0 },
  totalRequests: { type: Number, default: 0 },      // Total requests in current window
  failedRequests: { type: Number, default: 0 },     // Failed requests in current window
  successCount: { type: Number, default: 0 },       // Consecutive successes in HALF_OPEN
  
  // Timing
  lastFailureTime: { type: Date, default: null },
  lastSuccessTime: { type: Date, default: null },
  windowStartTime: { type: Date, default: Date.now }, // Start of current measurement window
  openedAt: { type: Date, default: null },           // When circuit was opened
  
  // Configuration
  threshold: { type: Number, default: 5 },           // Failure count threshold
  failureRateThreshold: { type: Number, default: 50 }, // Failure rate % threshold
  timeout: { type: Number, default: 30000 },         // Time to wait before HALF_OPEN (ms)
  windowSize: { type: Number, default: 60000 },      // Time window for rate calculation (ms)
  halfOpenMaxRequests: { type: Number, default: 3 }, // Max test requests in HALF_OPEN
  successThreshold: { type: Number, default: 3 },    // Successes needed to close circuit
  
  // Metrics for dashboard/analytics
  totalTrips: { type: Number, default: 0 },          // How many times circuit has opened
  lastTripReason: { type: String, default: null },   // Why circuit was last opened
  
  // Version for optimistic concurrency control
  version: { type: Number, default: 0 }
}, { 
  timestamps: true,  // Adds createdAt, updatedAt automatically
  collection: 'circuit_breakers'  // Explicit collection name
});

// Compound index for multi-service deployments
CircuitSchema.index({ serviceName: 1, state: 1 });
// Index for finding stale open circuits
CircuitSchema.index({ state: 1, openedAt: 1 });

/**
 * Get or create a circuit breaker instance for a service
 * Uses upsert for thread-safe creation
 */
CircuitSchema.statics.getInstance = async function (serviceName = 'default') {
  let doc = await this.findOneAndUpdate(
    { serviceName },
    { $setOnInsert: { serviceName } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc;
};

/**
 * Calculate current failure rate as a percentage
 */
CircuitSchema.methods.getFailureRate = function() {
  if (this.totalRequests === 0) return 0;
  return (this.failedRequests / this.totalRequests) * 100;
};

/**
 * Check if the measurement window has expired and needs reset
 */
CircuitSchema.methods.isWindowExpired = function() {
  const now = Date.now();
  const windowStart = this.windowStartTime ? this.windowStartTime.getTime() : 0;
  return (now - windowStart) >= this.windowSize;
};

/**
 * Reset the measurement window counters
 */
CircuitSchema.methods.resetWindow = function() {
  this.totalRequests = 0;
  this.failedRequests = 0;
  this.windowStartTime = new Date();
};

/**
 * Get a summary object for API responses
 */
CircuitSchema.methods.toStatusObject = function() {
  return {
    serviceName: this.serviceName,
    state: this.state,
    failureCount: this.failureCount,
    failureRate: this.getFailureRate().toFixed(2) + '%',
    totalRequests: this.totalRequests,
    failedRequests: this.failedRequests,
    successCount: this.successCount,
    threshold: this.threshold,
    failureRateThreshold: this.failureRateThreshold + '%',
    timeout: this.timeout,
    windowSize: this.windowSize,
    lastFailureTime: this.lastFailureTime,
    lastSuccessTime: this.lastSuccessTime,
    openedAt: this.openedAt,
    totalTrips: this.totalTrips,
    lastTripReason: this.lastTripReason,
    updatedAt: this.updatedAt
  };
};

module.exports = mongoose.model('CircuitBreaker', CircuitSchema);
