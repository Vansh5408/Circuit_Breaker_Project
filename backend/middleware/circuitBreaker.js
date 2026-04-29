// Circuit breaker
const breakerLogic = require('../utils/breakerLogic');

function circuitBreakerMiddleware(options = {}) {
  const {
    serviceName = 'default',
    excludePaths = ['/admin', '/health', '/metrics'],
    onOpen = null,
    onClose = null
  } = options;

  let lastState = 'CLOSED';

  return async function circuitBreaker(req, res, next) {
    const isExcluded = excludePaths.some(path => req.path.startsWith(path));
    if (isExcluded) {
      return next();
    }

    try {
      const result = await breakerLogic.allowRequest(serviceName);
      
      if (result.state !== lastState) {
        if (result.state === 'OPEN' && onOpen) {
          onOpen({ serviceName, reason: result.reason });
        } else if (result.state === 'CLOSED' && lastState !== 'CLOSED' && onClose) {
          onClose({ serviceName });
        }
        lastState = result.state;
      }

      if (!result.allowed) {
        res.set('X-Circuit-State', result.state);
        res.set('X-Circuit-Service', serviceName);
        
        if (result.retryAfter) {
          res.set('Retry-After', result.retryAfter);
        }
        
        return res.status(503).json({ 
          error: 'Service temporarily unavailable',
          message: result.reason || 'Circuit breaker is open',
          state: result.state,
          serviceName,
          retryAfter: result.retryAfter || null
        });
      }

      req.circuitBreaker = {
        serviceName,
        state: result.state
      };

      res.set('X-Circuit-State', result.state);
      res.set('X-Circuit-Service', serviceName);

      next();
    } catch (err) {
      console.error(`[CircuitBreaker:${serviceName}] Middleware error:`, err.message);
      req.circuitBreaker = { serviceName, state: 'UNKNOWN', error: err.message };
      next();
    }
  };
}

circuitBreakerMiddleware.forService = function(serviceName, options = {}) {
  return circuitBreakerMiddleware({ ...options, serviceName });
};

circuitBreakerMiddleware.wrap = function(serviceName, fn, options = {}) {
  return async function wrappedFunction(...args) {
    const result = await breakerLogic.allowRequest(serviceName);
    
    if (!result.allowed) {
      const error = new Error(`Circuit breaker open for ${serviceName}`);
      error.code = 'CIRCUIT_OPEN';
      error.state = result.state;
      error.retryAfter = result.retryAfter;
      throw error;
    }
    
    const startTime = Date.now();
    
    try {
      const response = await fn(...args);
      await breakerLogic.recordSuccess(serviceName);
      return response;
    } catch (error) {
      await breakerLogic.recordFailure({
        serviceName,
        message: error.message,
        errorType: error.code || 'UNKNOWN',
        responseTime: Date.now() - startTime
      });
      throw error;
    }
  };
};

module.exports = circuitBreakerMiddleware;
