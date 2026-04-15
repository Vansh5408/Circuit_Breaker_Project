const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const CircuitSchema = new Schema({
  serviceName: { 
    type: String, 
    default: 'default',
    index: true
  },
  
  state: { 
    type: String, 
    enum: ['CLOSED', 'OPEN', 'HALF_OPEN'], 
    default: 'CLOSED',
    index: true
  },
  
  failureCount: { type: Number, default: 0 },
  totalRequests: { type: Number, default: 0 },
  failedRequests: { type: Number, default: 0 },
  successCount: { type: Number, default: 0 },
  
  lastFailureTime: { type: Date, default: null },
  lastSuccessTime: { type: Date, default: null },
  windowStartTime: { type: Date, default: Date.now },
  openedAt: { type: Date, default: null },
  
  threshold: { type: Number, default: 5 },
  failureRateThreshold: { type: Number, default: 50 },
  timeout: { type: Number, default: 30000 },
  windowSize: { type: Number, default: 60000 },
  halfOpenMaxRequests: { type: Number, default: 3 },
  successThreshold: { type: Number, default: 3 },
  
  totalTrips: { type: Number, default: 0 },
  lastTripReason: { type: String, default: null },
  
  version: { type: Number, default: 0 }
}, { 
  timestamps: true,
  collection: 'circuit_breakers'
});

CircuitSchema.index({ serviceName: 1, state: 1 });
CircuitSchema.index({ state: 1, openedAt: 1 });

CircuitSchema.statics.getInstance = async function (serviceName = 'default') {
  let doc = await this.findOneAndUpdate(
    { serviceName },
    { $setOnInsert: { serviceName } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc;
};

CircuitSchema.methods.getFailureRate = function() {
  if (this.totalRequests === 0) return 0;
  return (this.failedRequests / this.totalRequests) * 100;
};

CircuitSchema.methods.isWindowExpired = function() {
  const now = Date.now();
  const windowStart = this.windowStartTime ? this.windowStartTime.getTime() : 0;
  return (now - windowStart) >= this.windowSize;
};

CircuitSchema.methods.resetWindow = function() {
  this.totalRequests = 0;
  this.failedRequests = 0;
  this.windowStartTime = new Date();
};

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
