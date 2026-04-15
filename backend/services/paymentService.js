const axios = require('axios');
const breakerLogic = require('../utils/breakerLogic');


const SERVICE_NAME = 'payment-service';

const config = {
  externalServiceUrl: process.env.PAYMENT_SERVICE_URL || null,
  
  failRate: parseFloat(process.env.FAIL_RATE) || 0.3,
  minLatency: parseInt(process.env.MIN_LATENCY) || 50,
  maxLatency: parseInt(process.env.MAX_LATENCY) || 200,
  timeoutRate: parseFloat(process.env.TIMEOUT_RATE) || 0.1,
  timeout: parseInt(process.env.PAYMENT_TIMEOUT) || 5000
};

function simulateLatency() {
  const latency = config.minLatency + Math.random() * (config.maxLatency - config.minLatency);
  return new Promise(resolve => setTimeout(resolve, latency));
}

function getSimulatedError() {
  const rand = Math.random();
  
  if (rand < config.timeoutRate) {
    return {
      type: 'TIMEOUT',
      code: 'ETIMEDOUT',
      message: 'Payment service request timed out'
    };
  }
  
  if (rand < config.timeoutRate + 0.3) {
    return {
      type: 'CONNECTION',
      code: 'ECONNREFUSED',
      message: 'Payment service connection refused'
    };
  }
  
  if (rand < config.timeoutRate + 0.5) {
    return {
      type: 'HTTP_ERROR',
      code: '503',
      message: 'Payment service unavailable'
    };
  }
  
  return {
    type: 'HTTP_ERROR',
    code: '500',
    message: 'Payment service internal error'
  };
}

async function processPayment(payload) {
  const startTime = Date.now();
  
  try {
    let result;
    
    if (config.externalServiceUrl) {
      result = await makeExternalCall(payload);
    } else {
      result = await simulatePayment(payload);
    }
    
    await breakerLogic.recordSuccess(SERVICE_NAME);
    
    return {
      ok: true,
      transactionId: result.transactionId,
      message: 'Payment processed successfully',
      amount: payload.amount || 1,
      processingTime: Date.now() - startTime
    };
    
  } catch (err) {
    const responseTime = Date.now() - startTime;
    
    await breakerLogic.recordFailure({
      serviceName: SERVICE_NAME,
      message: err.message,
      errorType: err.type || 'UNKNOWN',
      errorCode: err.code || err.statusCode || 'N/A',
      endpoint: '/payment',
      responseTime
    });
    
    const error = new Error(err.message);
    error.type = err.type || 'UNKNOWN';
    error.code = err.code;
    error.responseTime = responseTime;
    throw error;
  }
}

async function simulatePayment(payload) {
  await simulateLatency();
  
  const shouldFail = Math.random() < config.failRate;
  
  if (shouldFail) {
    const error = getSimulatedError();
    const err = new Error(error.message);
    err.type = error.type;
    err.code = error.code;
    throw err;
  }
  
  return {
    transactionId: `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    status: 'completed'
  };
}

async function makeExternalCall(payload) {
  try {
    const response = await axios.post(config.externalServiceUrl, payload, {
      timeout: config.timeout,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': `req_${Date.now()}`
      }
    });
    
    return response.data;
    
  } catch (error) {
    const err = new Error(error.message);
    
    if (error.code === 'ECONNABORTED') {
      err.type = 'TIMEOUT';
      err.code = 'ETIMEDOUT';
    } else if (error.code === 'ECONNREFUSED') {
      err.type = 'CONNECTION';
      err.code = error.code;
    } else if (error.response) {
      err.type = 'HTTP_ERROR';
      err.code = error.response.status.toString();
      err.message = error.response.data?.message || `HTTP ${error.response.status}`;
    } else {
      err.type = 'NETWORK';
      err.code = error.code || 'UNKNOWN';
    }
    
    throw err;
  }
}

async function healthCheck() {
  if (config.externalServiceUrl) {
    const healthUrl = config.externalServiceUrl.replace(/\/payment.*$/, '/health');
    const response = await axios.get(healthUrl, { timeout: 3000 });
    return response.status === 200;
  }
  
  return config.failRate < 1.0;
}

function getConfig() {
  return {
    serviceName: SERVICE_NAME,
    externalServiceUrl: config.externalServiceUrl ? '[configured]' : null,
    simulationMode: !config.externalServiceUrl,
    failRate: config.failRate,
    minLatency: config.minLatency,
    maxLatency: config.maxLatency,
    timeoutRate: config.timeoutRate,
    timeout: config.timeout
  };
}

function setConfig(newConfig) {
  if (newConfig.failRate !== undefined) {
    config.failRate = Math.max(0, Math.min(1, newConfig.failRate));
  }
  if (newConfig.minLatency !== undefined) {
    config.minLatency = Math.max(0, newConfig.minLatency);
  }
  if (newConfig.maxLatency !== undefined) {
    config.maxLatency = Math.max(config.minLatency, newConfig.maxLatency);
  }
  if (newConfig.timeoutRate !== undefined) {
    config.timeoutRate = Math.max(0, Math.min(1, newConfig.timeoutRate));
  }
  return getConfig();
}

module.exports = { 
  processPayment, 
  healthCheck, 
  getConfig, 
  setConfig,
  SERVICE_NAME 
};
