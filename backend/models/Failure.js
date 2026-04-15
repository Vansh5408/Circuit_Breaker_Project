const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const FailureSchema = new Schema({
  serviceName: { 
    type: String, 
    default: 'default',
    index: true
  },
  
  message: { type: String, required: true },
  errorCode: { type: String, default: null },
  errorType: { type: String, default: 'UNKNOWN' },
  
  endpoint: { type: String, default: null },
  method: { type: String, default: null },
  
  timestamp: { type: Date, default: Date.now, index: true },
  responseTime: { type: Number, default: null },
  
  circuitState: { 
    type: String, 
    enum: ['CLOSED', 'OPEN', 'HALF_OPEN'], 
    default: 'CLOSED' 
  },
  
  metadata: { type: Schema.Types.Mixed, default: {} },
  
  expiresAt: { 
    type: Date, 
    default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    index: { expireAfterSeconds: 0 }
  }
}, { 
  timestamps: false,
  collection: 'failures'
});

FailureSchema.index({ serviceName: 1, timestamp: -1 });
FailureSchema.index({ errorType: 1, timestamp: -1 });
FailureSchema.index({ serviceName: 1, errorType: 1 });

FailureSchema.statics.logFailure = async function(data) {
  const failure = new this({
    serviceName: data.serviceName || 'default',
    message: data.message || 'Unknown error',
    errorCode: data.errorCode,
    errorType: data.errorType || 'UNKNOWN',
    endpoint: data.endpoint,
    method: data.method,
    responseTime: data.responseTime,
    circuitState: data.circuitState || 'CLOSED',
    metadata: data.metadata || {}
  });
  return failure.save();
};

FailureSchema.statics.getStats = async function(serviceName = 'default', windowMs = 3600000) {
  const since = new Date(Date.now() - windowMs);
  
  const stats = await this.aggregate([
    { 
      $match: { 
        serviceName, 
        timestamp: { $gte: since } 
      } 
    },
    {
      $group: {
        _id: '$errorType',
        count: { $sum: 1 },
        avgResponseTime: { $avg: '$responseTime' },
        lastOccurrence: { $max: '$timestamp' }
      }
    },
    { $sort: { count: -1 } }
  ]);
  
  const total = stats.reduce((sum, s) => sum + s.count, 0);
  
  return {
    serviceName,
    windowMs,
    totalFailures: total,
    byType: stats
  };
};

FailureSchema.statics.getRecent = async function(serviceName = 'default', limit = 50) {
  return this.find({ serviceName })
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();
};

module.exports = mongoose.model('Failure', FailureSchema);
