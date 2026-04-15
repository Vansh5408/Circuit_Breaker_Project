
const API = (() => {
  const base = 'http://localhost:3000';

  async function request(endpoint, options = {}) {
    try {
      const response = await fetch(base + endpoint, {
        ...options,
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        }
      });
      
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      
      if (!response.ok) {
        const error = new Error(data.error || data.message || `HTTP ${response.status}`);
        error.status = response.status;
        error.data = data;
        throw error;
      }
      
      return data;
    } catch (error) {
      if (error.status) {
        throw error;
      }
      throw new Error(`API Error: ${error.message}`);
    }
  }

  return {
    status: () => request('/admin/status?service=payment-service'),
    reset: (service = 'payment-service') => request('/admin/reset', { 
      method: 'POST', 
      body: JSON.stringify({ service }) 
    }),
    setThreshold: (threshold) => request('/admin/threshold', {
      method: 'POST',
      body: JSON.stringify({ threshold: Number(threshold), service: 'payment-service' })
    }),
    setConfig: (config) => request('/admin/config', {
      method: 'POST',
      body: JSON.stringify({ ...config, service: 'payment-service' })
    }),
    healthCheck: () => request('/admin/health-check', { 
      method: 'POST',
      body: JSON.stringify({ service: 'payment-service' })
    }),
    getSimulation: () => request('/admin/simulation'),
    setSimulation: (config) => request('/admin/simulation', {
      method: 'POST',
      body: JSON.stringify(config)
    }),
    pay: () => request('/payment', {
      method: 'POST',
      body: JSON.stringify({ amount: Math.random() * 100 })
    })
  };
})();

const $ = (id) => document.getElementById(id);
const $$ = (selector) => document.querySelectorAll(selector);

const maxLogEntries = 100;

function log(message, type = 'info') {
  const logs = $('logs');
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  
  const time = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="log-time">[${time}]</span> ${escapeHtml(message)}`;
  
  logs.prepend(entry);
  
  while (logs.children.length > maxLogEntries) {
    logs.removeChild(logs.lastChild);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

let autoRefreshInterval = null;
let lastState = null;
let isEditingConfig = false;

function updateUI(data) {
  const breaker = data.breaker;
  const state = breaker.state;
  
  const indicator = $('state-indicator');
  indicator.className = `state-indicator state-${state.toLowerCase()}`;
  $('state-value').textContent = state;
  $('state-reason').textContent = breaker.lastTripReason || '';
  
  if (lastState && lastState !== state) {
    log(`State changed: ${lastState} → ${state}`, state === 'OPEN' ? 'error' : 'success');
    
    if (state === 'OPEN') {
      document.title = '🔴 OPEN - Circuit Breaker';
    } else if (state === 'CLOSED') {
      document.title = '🟢 CLOSED - Circuit Breaker';
    } else {
      document.title = '🟡 HALF_OPEN - Circuit Breaker';
    }
  }
  lastState = state;
  
  $('server-time').textContent = new Date(data.serverTime).toLocaleTimeString();
  $('last-updated').textContent = new Date().toLocaleTimeString();
  $('total-trips').textContent = breaker.totalTrips || 0;
  
  $('failure-count').textContent = breaker.failureCount || 0;
  $('threshold').textContent = breaker.threshold || 5;
  $('failure-rate').textContent = breaker.failureRate || '0%';
  $('rate-threshold').textContent = breaker.failureRateThreshold || '50%';
  $('total-requests').textContent = breaker.totalRequests || 0;
  $('failed-requests').textContent = breaker.failedRequests || 0;
  
  const hoSection = $('halfopen-section');
  if (state === 'HALF_OPEN' && data.halfOpenState) {
    hoSection.classList.remove('hidden');
    const ho = data.halfOpenState;
    $('ho-requests').textContent = `${ho.requestCount} / ${ho.maxRequests}`;
    $('ho-successes').textContent = `${ho.successCount} / ${breaker.successThreshold || 3}`;
    $('ho-failures').textContent = ho.failureCount || 0;
  } else {
    hoSection.classList.add('hidden');
  }
  
  if (!isEditingConfig) {
    $('thresholdInput').value = breaker.threshold || 5;
    $('rateThresholdInput').value = parseInt(breaker.failureRateThreshold) || 50;
    $('timeoutInput').value = breaker.timeout || 30000;
  }
  
  updateFailuresList(data.failures || []);
  
  if (data.failureStats) {
    $('failure-stats').textContent = `(${data.failureStats.totalFailures} in last hour)`;
  }
}

function updateFailuresList(failures) {
  const list = $('failures-list');
  
  if (failures.length === 0) {
    list.innerHTML = '<p class="empty-message">No recent failures</p>';
    return;
  }
  
  list.innerHTML = failures.slice(0, 20).map(f => `
    <div class="failure-item">
      <span class="failure-time">${new Date(f.timestamp).toLocaleString()}</span>
      <div class="failure-message">${escapeHtml(f.message)}</div>
      <div class="failure-meta">
        ${f.errorType ? `Type: ${f.errorType}` : ''} 
        ${f.errorCode ? `| Code: ${f.errorCode}` : ''} 
        ${f.responseTime ? `| ${f.responseTime}ms` : ''}
      </div>
    </div>
  `).join('');
}

async function refreshStatus() {
  try {
    const data = await API.status();
    updateUI(data);
  } catch (error) {
    log(`Status refresh failed: ${error.message}`, 'error');
  }
}

function startAutoRefresh() {
  if (autoRefreshInterval) return;
  autoRefreshInterval = setInterval(refreshStatus, 2000);
  log('Auto-refresh enabled (2s interval)', 'info');
}

function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
    log('Auto-refresh disabled', 'info');
  }
}


$('refresh').addEventListener('click', async () => {
  log('Refreshing status...', 'info');
  await refreshStatus();
});

$('reset').addEventListener('click', async () => {
  try {
    await API.reset();
    log('Circuit breaker reset to CLOSED', 'success');
    await refreshStatus();
  } catch (error) {
    log(`Reset failed: ${error.message}`, 'error');
  }
});

$('health-check').addEventListener('click', async () => {
  try {
    const result = await API.healthCheck();
    log(`Health check: ${result.healthy ? 'PASSED' : 'FAILED'}`, result.healthy ? 'success' : 'error');
    await refreshStatus();
  } catch (error) {
    log(`Health check failed: ${error.message}`, 'error');
  }
});

$('auto-refresh').addEventListener('change', (e) => {
  if (e.target.checked) {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
});

$('setThreshold').addEventListener('click', async () => {
  const value = parseInt($('thresholdInput').value);
  if (isNaN(value) || value < 1) {
    log('Invalid threshold value', 'error');
    return;
  }
  try {
    await API.setThreshold(value);
    log(`Threshold set to ${value}`, 'success');
    await refreshStatus();
  } catch (error) {
    log(`Failed to set threshold: ${error.message}`, 'error');
  }
});

$('setRateThreshold').addEventListener('click', async () => {
  const value = parseInt($('rateThresholdInput').value);
  if (isNaN(value) || value < 1 || value > 100) {
    log('Rate threshold must be between 1-100', 'error');
    return;
  }
  try {
    await API.setConfig({ failureRateThreshold: value });
    log(`Rate threshold set to ${value}%`, 'success');
    await refreshStatus();
  } catch (error) {
    log(`Failed to set rate threshold: ${error.message}`, 'error');
  }
});

$('setTimeout').addEventListener('click', async () => {
  const value = parseInt($('timeoutInput').value);
  if (isNaN(value) || value < 1000) {
    log('Timeout must be at least 1000ms', 'error');
    return;
  }
  try {
    await API.setConfig({ timeout: value });
    log(`Timeout set to ${value}ms`, 'success');
    await refreshStatus();
  } catch (error) {
    log(`Failed to set timeout: ${error.message}`, 'error');
  }
});

$('setSimulation').addEventListener('click', async () => {
  const failRate = parseFloat($('failRateInput').value);
  if (isNaN(failRate) || failRate < 0 || failRate > 1) {
    log('Fail rate must be between 0 and 1', 'error');
    return;
  }
  try {
    const result = await API.setSimulation({ failRate });
    log(`Simulation fail rate set to ${(failRate * 100).toFixed(0)}%`, 'success');
  } catch (error) {
    log(`Failed to update simulation: ${error.message}`, 'error');
  }
});

$('singlePay').addEventListener('click', async () => {
  try {
    const result = await API.pay();
    if (result.ok) {
      log(`Payment success: ${result.transactionId || 'completed'}`, 'success');
    } else if (result.error) {
      log(`Payment failed: ${result.error}`, 'error');
    } else {
      log(`Payment response: ${JSON.stringify(result)}`, 'info');
    }
    await refreshStatus();
  } catch (error) {
    log(`Payment error: ${error.message}`, 'error');
    await refreshStatus();
  }
});

let flooding = false;
let floodHandles = [];

$('floodStart').addEventListener('click', () => {
  flooding = !flooding;
  $('floodStart').textContent = flooding ? 'Stop Flood' : 'Start Flood Test';
  $('floodStart').classList.toggle('btn-danger', !flooding);
  $('floodStart').classList.toggle('btn-warning', flooding);
  
  if (flooding) {
    startFlood();
  } else {
    stopFlood();
  }
});

function startFlood() {
  const concurrency = parseInt($('concurrency').value) || 5;
  const rate = parseInt($('rate').value) || 200;
  
  log(`Starting flood: ${concurrency} concurrent, ${rate}ms interval`, 'info');
  
  for (let i = 0; i < concurrency; i++) {
    const handle = setInterval(async () => {
      try {
        const result = await API.pay();
        if (result.ok) {
          log('Flood payment: success', 'success');
        } else {
          log(`Flood payment: ${result.error || result.message || 'failed'}`, 'error');
        }
      } catch (error) {
        log(`Flood error: ${error.message}`, 'error');
      }
    }, rate);
    floodHandles.push(handle);
  }
}

function stopFlood() {
  floodHandles.forEach(h => clearInterval(h));
  floodHandles = [];
  log('Flood stopped', 'info');
  refreshStatus();
}

async function loadSimulationSettings() {
  try {
    const config = await API.getSimulation();
    $('failRateInput').value = config.failRate || 0.3;
  } catch (error) {
  }
}

document.addEventListener('DOMContentLoaded', () => {
  log('Dashboard initialized', 'info');
  
  ['thresholdInput', 'rateThresholdInput', 'timeoutInput', 'failRateInput'].forEach(id => {
    $(id).addEventListener('focus', () => { isEditingConfig = true; });
    $(id).addEventListener('blur', () => { isEditingConfig = false; });
  });
  
  refreshStatus();
  
  loadSimulationSettings();
  
  if ($('auto-refresh').checked) {
    startAutoRefresh();
  }
});

window.addEventListener('beforeunload', () => {
  stopAutoRefresh();
  stopFlood();
});
