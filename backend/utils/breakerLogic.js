const CircuitBreaker = require('../models/CircuitBreaker');
const Failure = require('../models/Failure');


const halfOpenState = new Map();

function getHalfOpenState(serviceName = 'default') {
  if (!halfOpenState.has(serviceName)) {
    halfOpenState.set(serviceName, {
      requestCount: 0,
      successCount: 0,
      failureCount: 0
    });
  }
  return halfOpenState.get(serviceName);
}

function resetHalfOpenState(serviceName = 'default') {
  halfOpenState.set(serviceName, {
    requestCount: 0,
    successCount: 0,
    failureCount: 0
  });
}

async function getBreaker(serviceName = 'default') {
  const cb = await CircuitBreaker.getInstance(serviceName);
  return cb;
}

async function checkAndResetWindow(cb) {
  if (cb.isWindowExpired()) {
    console.log(`[CircuitBreaker:${cb.serviceName}] Measurement window expired, resetting counters`);
    cb.resetWindow();
    await cb.save();
  }
}

async function recordFailure(options = {}) {
  const serviceName = options.serviceName || 'default';
  const cb = await getBreaker(serviceName);
  
  await checkAndResetWindow(cb);
  
  cb.failureCount += 1;
  cb.failedRequests += 1;
  cb.totalRequests += 1;
  cb.lastFailureTime = new Date();
  cb.version += 1;
  
  try {
    await Failure.logFailure({
      serviceName,
      message: options.message || 'Downstream failure recorded',
      errorType: options.errorType || 'UNKNOWN',
      errorCode: options.errorCode,
      endpoint: options.endpoint,
      responseTime: options.responseTime,
      circuitState: cb.state
    });
  } catch (e) {
    console.error(`[CircuitBreaker:${serviceName}] Failed to log failure:`, e.message);
  }
  
  if (cb.state === 'HALF_OPEN') {
    const hoState = getHalfOpenState(serviceName);
    hoState.failureCount += 1;
    
    console.log(`[CircuitBreaker:${serviceName}] HALF_OPEN failure detected, returning to OPEN`);
    cb.state = 'OPEN';
    cb.openedAt = new Date();
    cb.lastTripReason = 'HALF_OPEN test request failed';
    resetHalfOpenState(serviceName);
    await cb.save();
    return cb;
  }
  
  const failureRate = cb.getFailureRate();
  const shouldTrip = 
    cb.failureCount >= cb.threshold && 
    failureRate >= cb.failureRateThreshold;
  
  if (shouldTrip && cb.state === 'CLOSED') {
    cb.state = 'OPEN';
    cb.openedAt = new Date();
    cb.totalTrips += 1;
    cb.lastTripReason = `Failure threshold exceeded: ${cb.failureCount} failures, ${failureRate.toFixed(2)}% failure rate`;
    
    console.log(`[CircuitBreaker:${serviceName}] CIRCUIT OPENED - ${cb.lastTripReason}`);
  }
  
  await cb.save();
  return cb;
}

async function recordSuccess(serviceName = 'default') {
  const cb = await getBreaker(serviceName);
  
  await checkAndResetWindow(cb);
  
  cb.totalRequests += 1;
  cb.lastSuccessTime = new Date();
  
  if (cb.state === 'HALF_OPEN') {
    const hoState = getHalfOpenState(serviceName);
    hoState.successCount += 1;
    cb.successCount = hoState.successCount;
    
    console.log(`[CircuitBreaker:${serviceName}] HALF_OPEN success ${hoState.successCount}/${cb.successThreshold}`);
    
    if (hoState.successCount >= cb.successThreshold) {
      cb.state = 'CLOSED';
      cb.failureCount = 0;
      cb.failedRequests = 0;
      cb.successCount = 0;
      cb.openedAt = null;
      cb.resetWindow();
      resetHalfOpenState(serviceName);
      
      console.log(`[CircuitBreaker:${serviceName}] CIRCUIT CLOSED - recovered successfully`);
    }
  } else if (cb.state === 'CLOSED') {
  }
  
  await cb.save();
  return cb;
}

async function allowRequest(serviceName = 'default') {
  const cb = await getBreaker(serviceName);
  
  if (cb.state === 'CLOSED') {
    return { allowed: true, state: 'CLOSED' };
  }
  
  if (cb.state === 'OPEN') {
    const openedAt = cb.openedAt ? cb.openedAt.getTime() : (cb.lastFailureTime ? cb.lastFailureTime.getTime() : 0);
    const elapsed = Date.now() - openedAt;
    
    if (elapsed >= cb.timeout) {
      cb.state = 'HALF_OPEN';
      cb.successCount = 0;
      resetHalfOpenState(serviceName);
      await cb.save();
      
      console.log(`[CircuitBreaker:${serviceName}] Timeout elapsed, transitioning to HALF_OPEN`);
      
      const hoState = getHalfOpenState(serviceName);
      hoState.requestCount = 1;
      return { allowed: true, state: 'HALF_OPEN' };
    }
    
    const remaining = Math.ceil((cb.timeout - elapsed) / 1000);
    return { 
      allowed: false, 
      state: 'OPEN',
      reason: `Circuit is OPEN. Retry in ${remaining}s`,
      retryAfter: remaining
    };
  }
  
  if (cb.state === 'HALF_OPEN') {
    const hoState = getHalfOpenState(serviceName);
    
    if (hoState.requestCount < cb.halfOpenMaxRequests) {
      hoState.requestCount += 1;
      console.log(`[CircuitBreaker:${serviceName}] HALF_OPEN request ${hoState.requestCount}/${cb.halfOpenMaxRequests} allowed`);
      return { allowed: true, state: 'HALF_OPEN' };
    }
    
    return { 
      allowed: false, 
      state: 'HALF_OPEN',
      reason: 'HALF_OPEN request limit reached, waiting for test results'
    };
  }
  
  return { allowed: true, state: cb.state };
}

async function performHealthCheck(serviceName = 'default', healthCheckFn) {
  const cb = await getBreaker(serviceName);
  
  try {
    const startTime = Date.now();
    await healthCheckFn();
    const responseTime = Date.now() - startTime;
    
    console.log(`[CircuitBreaker:${serviceName}] Health check PASSED (${responseTime}ms)`);
    
    if (cb.state === 'HALF_OPEN') {
      await recordSuccess(serviceName);
    }
    
    return { 
      healthy: true, 
      responseTime,
      state: cb.state
    };
  } catch (error) {
    console.log(`[CircuitBreaker:${serviceName}] Health check FAILED: ${error.message}`);
    
    if (cb.state === 'HALF_OPEN') {
      await recordFailure({ 
        serviceName, 
        message: `Health check failed: ${error.message}`,
        errorType: 'HEALTH_CHECK'
      });
    }
    
    return { 
      healthy: false, 
      error: error.message,
      state: cb.state
    };
  }
}

async function getStatus(serviceName = 'default', failureLimit = 50) {
  const cb = await getBreaker(serviceName);
  const failures = await Failure.getRecent(serviceName, failureLimit);
  const failureStats = await Failure.getStats(serviceName, cb.windowSize);
  const hoState = getHalfOpenState(serviceName);
  
  return { 
    breaker: cb.toStatusObject(),
    halfOpenState: cb.state === 'HALF_OPEN' ? {
      requestCount: hoState.requestCount,
      successCount: hoState.successCount,
      failureCount: hoState.failureCount,
      maxRequests: cb.halfOpenMaxRequests
    } : null,
    failures,
    failureStats,
    serverTime: new Date().toISOString()
  };
}

async function resetBreaker(serviceName = 'default') {
  const cb = await getBreaker(serviceName);
  
  const previousState = cb.state;
  
  cb.state = 'CLOSED';
  cb.failureCount = 0;
  cb.failedRequests = 0;
  cb.successCount = 0;
  cb.lastFailureTime = null;
  cb.lastSuccessTime = null;
  cb.openedAt = null;
  cb.totalTrips = 0;
  cb.lastTripReason = null;
  cb.resetWindow();
  cb.version += 1;
  
  resetHalfOpenState(serviceName);
  
  await cb.save();
  
  try {
    await Failure.deleteMany({ serviceName });
    console.log(`[CircuitBreaker:${serviceName}] Failure history cleared`);
  } catch (e) {
    console.error(`[CircuitBreaker:${serviceName}] Failed to clear failure history:`, e.message);
  }
  
  console.log(`[CircuitBreaker:${serviceName}] MANUAL RESET - ${previousState} -> CLOSED`);
  
  return cb;
}

async function updateThreshold(serviceName = 'default', threshold) {
  if (typeof serviceName === 'number') {
    threshold = serviceName;
    serviceName = 'default';
  }
  
  const cb = await getBreaker(serviceName);
  cb.threshold = threshold;
  cb.version += 1;
  await cb.save();
  
  console.log(`[CircuitBreaker:${serviceName}] Threshold updated to ${threshold}`);
  
  return cb;
}

async function updateFailureRateThreshold(serviceName = 'default', rate) {
  const cb = await getBreaker(serviceName);
  cb.failureRateThreshold = Math.min(100, Math.max(0, rate));
  cb.version += 1;
  await cb.save();
  
  console.log(`[CircuitBreaker:${serviceName}] Failure rate threshold updated to ${rate}%`);
  
  return cb;
}

async function updateTimeout(serviceName = 'default', timeout) {
  const cb = await getBreaker(serviceName);
  cb.timeout = timeout;
  cb.version += 1;
  await cb.save();
  
  console.log(`[CircuitBreaker:${serviceName}] Timeout updated to ${timeout}ms`);
  
  return cb;
}

async function updateConfig(serviceName = 'default', config = {}) {
  const cb = await getBreaker(serviceName);
  
  const allowedFields = [
    'threshold', 'failureRateThreshold', 'timeout', 
    'windowSize', 'halfOpenMaxRequests', 'successThreshold'
  ];
  
  for (const field of allowedFields) {
    if (config[field] !== undefined) {
      cb[field] = config[field];
    }
  }
  
  cb.version += 1;
  await cb.save();
  
  console.log(`[CircuitBreaker:${serviceName}] Configuration updated:`, config);
  
  return cb;
}

module.exports = { 
  getBreaker, 
  recordFailure, 
  recordSuccess, 
  allowRequest, 
  resetBreaker, 
  updateThreshold,
  updateFailureRateThreshold,
  updateTimeout,
  updateConfig,
  getStatus,
  performHealthCheck
};
