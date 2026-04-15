
require('dotenv').config();
const express = require('express');
const connectDB = require('./config/db');
const breakerLogic = require('./utils/breakerLogic');
const circuitBreakerMiddleware = require('./middleware/circuitBreaker');
const paymentService = require('./services/paymentService');

connectDB();

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const allowedOrigins = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',') 
    : ['*'];
  
  const origin = req.headers.origin;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Expose-Headers', 'X-Circuit-State, X-Circuit-Service, Retry-After');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});


app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/health/detailed', async (req, res) => {
  try {
    const status = await breakerLogic.getStatus();
    const mongooseState = require('mongoose').connection.readyState;
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      dependencies: {
        mongodb: {
          connected: mongooseState === 1,
          state: ['disconnected', 'connected', 'connecting', 'disconnecting'][mongooseState]
        },
        circuitBreaker: {
          state: status.breaker.state,
          failureRate: status.breaker.failureRate
        }
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

app.get('/health/downstream', async (req, res) => {
  try {
    const healthy = await paymentService.healthCheck();
    res.json({ 
      healthy,
      service: 'payment-service',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({ 
      healthy: false,
      service: 'payment-service',
      error: error.message
    });
  }
});

app.use(circuitBreakerMiddleware({
  serviceName: paymentService.SERVICE_NAME,
  excludePaths: ['/admin', '/health', '/metrics'],
  onOpen: ({ serviceName, reason }) => {
    console.log(`[ALERT] Circuit breaker OPENED for ${serviceName}: ${reason}`);
  },
  onClose: ({ serviceName }) => {
    console.log(`[INFO] Circuit breaker CLOSED for ${serviceName} - service recovered`);
  }
}));


app.post('/payment', async (req, res) => {
  try {
    const result = await paymentService.processPayment(req.body);
    res.json(result);
  } catch (err) {
    res.status(502).json({ 
      error: err.message,
      type: err.type || 'UNKNOWN',
      code: err.code,
      responseTime: err.responseTime
    });
  }
});


app.get('/admin/status', async (req, res) => {
  try {
    const serviceName = req.query.service || paymentService.SERVICE_NAME;
    const limit = parseInt(req.query.limit) || 50;
    const status = await breakerLogic.getStatus(serviceName, limit);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch status', details: error.message });
  }
});

app.post('/admin/threshold', async (req, res) => {
  try {
    const { threshold, service = paymentService.SERVICE_NAME } = req.body;
    
    if (typeof threshold !== 'number' || threshold < 1) {
      return res.status(400).json({ error: 'threshold must be a positive number' });
    }
    
    const cb = await breakerLogic.updateThreshold(service, threshold);
    res.json({ 
      ok: true, 
      message: `Threshold updated to ${threshold}`,
      breaker: cb.toStatusObject()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update threshold', details: error.message });
  }
});

app.post('/admin/config', async (req, res) => {
  try {
    const { service = paymentService.SERVICE_NAME, ...config } = req.body;
    const cb = await breakerLogic.updateConfig(service, config);
    res.json({ 
      ok: true, 
      message: 'Configuration updated',
      breaker: cb.toStatusObject()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update config', details: error.message });
  }
});

app.post('/admin/reset', async (req, res) => {
  try {
    const serviceName = req.body.service || paymentService.SERVICE_NAME;
    await breakerLogic.resetBreaker(serviceName);
    res.json({ 
      ok: true, 
      message: `Circuit breaker for "${serviceName}" reset to CLOSED`
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reset breaker', details: error.message });
  }
});

app.post('/admin/health-check', async (req, res) => {
  try {
    const serviceName = req.body.service || paymentService.SERVICE_NAME;
    const result = await breakerLogic.performHealthCheck(
      serviceName, 
      paymentService.healthCheck
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Health check failed', details: error.message });
  }
});

app.get('/admin/simulation', (req, res) => {
  res.json(paymentService.getConfig());
});

app.post('/admin/simulation', (req, res) => {
  const config = paymentService.setConfig(req.body);
  res.json({ ok: true, config });
});

app.get('/metrics', async (req, res) => {
  try {
    const status = await breakerLogic.getStatus();
    
    const metrics = [
      `# HELP circuit_breaker_state Current state of the circuit breaker (0=CLOSED, 1=OPEN, 2=HALF_OPEN)`,
      `# TYPE circuit_breaker_state gauge`,
      `circuit_breaker_state{service="${status.breaker.serviceName}"} ${['CLOSED', 'OPEN', 'HALF_OPEN'].indexOf(status.breaker.state)}`,
      ``,
      `# HELP circuit_breaker_failure_count Total failures in current window`,
      `# TYPE circuit_breaker_failure_count gauge`,
      `circuit_breaker_failure_count{service="${status.breaker.serviceName}"} ${status.breaker.failedRequests}`,
      ``,
      `# HELP circuit_breaker_request_total Total requests in current window`,
      `# TYPE circuit_breaker_request_total gauge`,
      `circuit_breaker_request_total{service="${status.breaker.serviceName}"} ${status.breaker.totalRequests}`,
      ``,
      `# HELP circuit_breaker_trips_total Total number of times circuit has opened`,
      `# TYPE circuit_breaker_trips_total counter`,
      `circuit_breaker_trips_total{service="${status.breaker.serviceName}"} ${status.breaker.totalTrips}`,
    ].join('\n');
    
    res.set('Content-Type', 'text/plain');
    res.send(metrics);
  } catch (error) {
    res.status(500).send(`# Error: ${error.message}`);
  }
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});


process.on('SIGUSR1', async () => {
  console.log('[SIGNAL] SIGUSR1 received — resetting circuit breaker');
  try {
    await breakerLogic.resetBreaker();
    console.log('[SIGNAL] Circuit breaker reset successful');
  } catch (e) {
    console.error('[SIGNAL] Failed to reset circuit breaker:', e.message);
  }
});

process.on('SIGUSR2', async () => {
  console.log('[SIGNAL] SIGUSR2 received — logging circuit breaker status');
  try {
    const status = await breakerLogic.getStatus();
    console.log('[SIGNAL] Current status:', JSON.stringify(status.breaker, null, 2));
  } catch (e) {
    console.error('[SIGNAL] Failed to get status:', e.message);
  }
});

async function gracefulShutdown(signal) {
  console.log(`[SIGNAL] ${signal} received — starting graceful shutdown`);
  
  try {
    const mongoose = require('mongoose');
    await mongoose.connection.close();
    console.log('[SHUTDOWN] MongoDB connection closed');
  } catch (e) {
    console.error('[SHUTDOWN] Error closing MongoDB:', e.message);
  }
  
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║          Circuit Breaker Service Started                     ║
╠══════════════════════════════════════════════════════════════╣
║  Port:       ${PORT.toString().padEnd(47)}║
║  Env:        ${(process.env.NODE_ENV || 'development').padEnd(47)}║
║  PID:        ${process.pid.toString().padEnd(47)}║
╠══════════════════════════════════════════════════════════════╣
║  Endpoints:                                                  ║
║  • POST /payment           - Process payment                 ║
║  • GET  /health            - Health check                    ║
║  • GET  /admin/status      - Circuit breaker status          ║
║  • POST /admin/reset       - Reset circuit breaker           ║
║  • POST /admin/threshold   - Update failure threshold        ║
║  • POST /admin/config      - Update configuration            ║
║  • GET  /metrics           - Prometheus metrics              ║
╠══════════════════════════════════════════════════════════════╣
║  Signal Handlers:                                            ║
║  • SIGUSR1 - Reset circuit breaker                           ║
║  • SIGUSR2 - Log current status                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
