
const http = require('http');

const config = {
  url: process.env.TARGET_URL || 'http://localhost:3000/payment',
  requestsPerSecond: parseInt(process.env.RPS) || 50,
  durationSeconds: parseInt(process.env.DURATION) || 30,
  concurrency: parseInt(process.env.CONCURRENCY) || 10
};

process.argv.slice(2).forEach((arg, i, args) => {
  if (arg === '--url') config.url = args[i + 1];
  if (arg === '--rps') config.requestsPerSecond = parseInt(args[i + 1]);
  if (arg === '--duration') config.durationSeconds = parseInt(args[i + 1]);
  if (arg === '--concurrency') config.concurrency = parseInt(args[i + 1]);
});

const metrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  circuitOpenResponses: 0,
  latencies: [],
  statusCodes: {},
  startTime: null,
  endTime: null
};

function makeRequest() {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const url = new URL(config.url);
    
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const latency = Date.now() - startTime;
        metrics.totalRequests++;
        metrics.latencies.push(latency);
        
        const code = res.statusCode.toString();
        metrics.statusCodes[code] = (metrics.statusCodes[code] || 0) + 1;
        
        if (res.statusCode === 200) {
          metrics.successfulRequests++;
        } else if (res.statusCode === 503) {
          metrics.circuitOpenResponses++;
          metrics.failedRequests++;
        } else {
          metrics.failedRequests++;
        }
        
        resolve({ statusCode: res.statusCode, latency, data });
      });
    });
    
    req.on('error', (err) => {
      const latency = Date.now() - startTime;
      metrics.totalRequests++;
      metrics.failedRequests++;
      metrics.latencies.push(latency);
      metrics.statusCodes['error'] = (metrics.statusCodes['error'] || 0) + 1;
      resolve({ statusCode: 0, latency, error: err.message });
    });
    
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ statusCode: 0, latency: 5000, error: 'timeout' });
    });
    
    req.write(JSON.stringify({ amount: 1 }));
    req.end();
  });
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function printProgress() {
  const elapsed = (Date.now() - metrics.startTime) / 1000;
  const rps = metrics.totalRequests / elapsed;
  const successRate = metrics.totalRequests > 0 
    ? (metrics.successfulRequests / metrics.totalRequests * 100).toFixed(1) 
    : 0;
  const circuitOpenRate = metrics.totalRequests > 0
    ? (metrics.circuitOpenResponses / metrics.totalRequests * 100).toFixed(1)
    : 0;
  
  process.stdout.write(`\r[${elapsed.toFixed(0)}s] ` +
    `Requests: ${metrics.totalRequests} | ` +
    `RPS: ${rps.toFixed(1)} | ` +
    `Success: ${successRate}% | ` +
    `Circuit Open: ${circuitOpenRate}%`);
}

function printReport() {
  const duration = (metrics.endTime - metrics.startTime) / 1000;
  const avgLatency = metrics.latencies.length > 0
    ? metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length
    : 0;
  
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    Load Test Results                         ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Duration:              ${duration.toFixed(2).padStart(10)} seconds              ║`);
  console.log(`║  Total Requests:        ${metrics.totalRequests.toString().padStart(10)}                     ║`);
  console.log(`║  Requests/Second:       ${(metrics.totalRequests / duration).toFixed(2).padStart(10)}                     ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Successful:            ${metrics.successfulRequests.toString().padStart(10)} (${(metrics.successfulRequests / metrics.totalRequests * 100).toFixed(1)}%)              ║`);
  console.log(`║  Failed:                ${metrics.failedRequests.toString().padStart(10)} (${(metrics.failedRequests / metrics.totalRequests * 100).toFixed(1)}%)              ║`);
  console.log(`║  Circuit Open (503):    ${metrics.circuitOpenResponses.toString().padStart(10)} (${(metrics.circuitOpenResponses / metrics.totalRequests * 100).toFixed(1)}%)              ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Avg Latency:           ${avgLatency.toFixed(2).padStart(10)} ms                   ║`);
  console.log(`║  P50 Latency:           ${percentile(metrics.latencies, 50).toFixed(2).padStart(10)} ms                   ║`);
  console.log(`║  P95 Latency:           ${percentile(metrics.latencies, 95).toFixed(2).padStart(10)} ms                   ║`);
  console.log(`║  P99 Latency:           ${percentile(metrics.latencies, 99).toFixed(2).padStart(10)} ms                   ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Status Code Distribution:                                   ║');
  
  for (const [code, count] of Object.entries(metrics.statusCodes).sort()) {
    const pct = (count / metrics.totalRequests * 100).toFixed(1);
    console.log(`║    ${code.padEnd(6)} : ${count.toString().padStart(8)} (${pct.padStart(5)}%)                       ║`);
  }
  
  console.log('╚══════════════════════════════════════════════════════════════╝');
}

async function runLoadTest() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║             Circuit Breaker Load Test                        ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Target URL:      ${config.url.padEnd(40)} ║`);
  console.log(`║  Requests/sec:    ${config.requestsPerSecond.toString().padEnd(40)} ║`);
  console.log(`║  Duration:        ${(config.durationSeconds + ' seconds').padEnd(40)} ║`);
  console.log(`║  Concurrency:     ${config.concurrency.toString().padEnd(40)} ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('\nStarting load test...\n');
  
  metrics.startTime = Date.now();
  const endTime = metrics.startTime + config.durationSeconds * 1000;
  
  const progressInterval = setInterval(printProgress, 1000);
  
  const batchSize = config.concurrency;
  const batchDelay = (batchSize / config.requestsPerSecond) * 1000;
  
  while (Date.now() < endTime) {
    const batch = [];
    for (let i = 0; i < batchSize; i++) {
      batch.push(makeRequest());
    }
    
    await Promise.all(batch);
    
    await new Promise(resolve => setTimeout(resolve, batchDelay));
  }
  
  metrics.endTime = Date.now();
  clearInterval(progressInterval);
  
  printReport();
}

runLoadTest().catch(console.error);
