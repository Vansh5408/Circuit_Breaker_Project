
const assert = require('assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const CircuitBreaker = require('../models/CircuitBreaker');
const Failure = require('../models/Failure');
const breakerLogic = require('../utils/breakerLogic');

let mongoServer;


async function setupTestDB() {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
  console.log('Connected to in-memory MongoDB for testing');
}

async function teardownTestDB() {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
  console.log('Disconnected from test database');
}

async function clearCollections() {
  await CircuitBreaker.deleteMany({});
  await Failure.deleteMany({});
}


async function testCircuitBreakerModel() {
  console.log('\n--- Unit Tests: CircuitBreaker Model ---\n');
  
  console.log('Test 1: getInstance creates new breaker');
  await clearCollections();
  const cb1 = await CircuitBreaker.getInstance('test-service');
  assert.strictEqual(cb1.serviceName, 'test-service');
  assert.strictEqual(cb1.state, 'CLOSED');
  assert.strictEqual(cb1.failureCount, 0);
  console.log('  ✓ New breaker created with default values');
  
  console.log('Test 2: getInstance returns existing breaker');
  const cb2 = await CircuitBreaker.getInstance('test-service');
  assert.strictEqual(cb1._id.toString(), cb2._id.toString());
  console.log('  ✓ Same breaker instance returned');
  
  console.log('Test 3: getFailureRate calculation');
  const cb3 = await CircuitBreaker.getInstance('rate-test');
  cb3.totalRequests = 100;
  cb3.failedRequests = 30;
  await cb3.save();
  assert.strictEqual(cb3.getFailureRate(), 30);
  console.log('  ✓ Failure rate calculated correctly (30%)');
  
  console.log('Test 4: isWindowExpired check');
  const cb4 = await CircuitBreaker.getInstance('window-test');
  cb4.windowSize = 1000;
  cb4.windowStartTime = new Date(Date.now() - 2000);
  assert.ok(cb4.isWindowExpired());
  console.log('  ✓ Window expiration detected correctly');
  
  console.log('Test 5: toStatusObject formatting');
  const status = cb4.toStatusObject();
  assert.ok(status.serviceName);
  assert.ok(status.state);
  assert.ok(status.failureRate);
  console.log('  ✓ Status object formatted correctly');
}


async function testBreakerLogic() {
  console.log('\n--- Unit Tests: Breaker Logic ---\n');
  
  const SERVICE = 'logic-test';
  
  console.log('Test 1: allowRequest in CLOSED state');
  await clearCollections();
  const result1 = await breakerLogic.allowRequest(SERVICE);
  assert.strictEqual(result1.allowed, true);
  assert.strictEqual(result1.state, 'CLOSED');
  console.log('  ✓ Requests allowed in CLOSED state');
  
  console.log('Test 2: recordFailure increments counters');
  await breakerLogic.recordFailure({ serviceName: SERVICE, message: 'Test error' });
  const cb2 = await breakerLogic.getBreaker(SERVICE);
  assert.strictEqual(cb2.failureCount, 1);
  assert.strictEqual(cb2.failedRequests, 1);
  console.log('  ✓ Failure counters incremented');
  
  console.log('Test 3: Circuit opens after threshold');
  const cb3 = await breakerLogic.getBreaker(SERVICE);
  cb3.threshold = 3;
  cb3.failureRateThreshold = 10;
  await cb3.save();
  
  await breakerLogic.recordFailure({ serviceName: SERVICE, message: 'Error 1' });
  await breakerLogic.recordFailure({ serviceName: SERVICE, message: 'Error 2' });
  await breakerLogic.recordFailure({ serviceName: SERVICE, message: 'Error 3' });
  
  const cb3After = await breakerLogic.getBreaker(SERVICE);
  assert.strictEqual(cb3After.state, 'OPEN');
  console.log('  ✓ Circuit opened after reaching threshold');
  
  console.log('Test 4: allowRequest blocked in OPEN state');
  const result4 = await breakerLogic.allowRequest(SERVICE);
  assert.strictEqual(result4.allowed, false);
  assert.strictEqual(result4.state, 'OPEN');
  console.log('  ✓ Requests blocked in OPEN state');
  
  console.log('Test 5: resetBreaker returns to CLOSED');
  await breakerLogic.resetBreaker(SERVICE);
  const cb5 = await breakerLogic.getBreaker(SERVICE);
  assert.strictEqual(cb5.state, 'CLOSED');
  assert.strictEqual(cb5.failureCount, 0);
  console.log('  ✓ Breaker reset to CLOSED state');
  
  console.log('Test 6: updateThreshold changes value');
  await breakerLogic.updateThreshold(SERVICE, 10);
  const cb6 = await breakerLogic.getBreaker(SERVICE);
  assert.strictEqual(cb6.threshold, 10);
  console.log('  ✓ Threshold updated successfully');
}


async function testHalfOpenState() {
  console.log('\n--- Integration Tests: HALF_OPEN State ---\n');
  
  const SERVICE = 'halfopen-test';
  await clearCollections();
  
  console.log('Setup: Creating open circuit');
  const cb = await CircuitBreaker.getInstance(SERVICE);
  cb.state = 'OPEN';
  cb.threshold = 3;
  cb.timeout = 100;
  cb.halfOpenMaxRequests = 2;
  cb.successThreshold = 2;
  cb.openedAt = new Date(Date.now() - 200);
  await cb.save();
  
  console.log('Test 1: Transition to HALF_OPEN after timeout');
  const result1 = await breakerLogic.allowRequest(SERVICE);
  assert.strictEqual(result1.allowed, true);
  assert.strictEqual(result1.state, 'HALF_OPEN');
  console.log('  ✓ Transitioned to HALF_OPEN after timeout');
  
  console.log('Test 2: Limited requests in HALF_OPEN');
  const result2 = await breakerLogic.allowRequest(SERVICE);
  assert.strictEqual(result2.allowed, true);
  
  const result3 = await breakerLogic.allowRequest(SERVICE);
  assert.strictEqual(result3.allowed, false);
  console.log('  ✓ Request limit enforced in HALF_OPEN');
  
  await breakerLogic.resetBreaker(SERVICE);
}

async function testHalfOpenRecovery() {
  console.log('\n--- Integration Tests: HALF_OPEN Recovery ---\n');
  
  const SERVICE = 'recovery-test';
  await clearCollections();
  
  console.log('Setup: Creating HALF_OPEN circuit');
  const cb = await CircuitBreaker.getInstance(SERVICE);
  cb.state = 'HALF_OPEN';
  cb.successThreshold = 2;
  await cb.save();
  
  console.log('Test: Consecutive successes close circuit');
  await breakerLogic.recordSuccess(SERVICE);
  await breakerLogic.recordSuccess(SERVICE);
  
  const cbAfter = await breakerLogic.getBreaker(SERVICE);
  assert.strictEqual(cbAfter.state, 'CLOSED');
  console.log('  ✓ Circuit closed after successful recovery');
}

async function testHalfOpenFailure() {
  console.log('\n--- Integration Tests: HALF_OPEN Failure ---\n');
  
  const SERVICE = 'halfopen-fail-test';
  await clearCollections();
  
  console.log('Setup: Creating HALF_OPEN circuit');
  const cb = await CircuitBreaker.getInstance(SERVICE);
  cb.state = 'HALF_OPEN';
  await cb.save();
  
  console.log('Test: Single failure returns to OPEN');
  await breakerLogic.recordFailure({ serviceName: SERVICE, message: 'Test failure' });
  
  const cbAfter = await breakerLogic.getBreaker(SERVICE);
  assert.strictEqual(cbAfter.state, 'OPEN');
  console.log('  ✓ Circuit returned to OPEN after HALF_OPEN failure');
}


async function testFailureRate() {
  console.log('\n--- Integration Tests: Failure Rate Logic ---\n');
  
  const SERVICE = 'rate-logic-test';
  await clearCollections();
  
  console.log('Test: High failure rate trips circuit');
  const cb = await CircuitBreaker.getInstance(SERVICE);
  cb.threshold = 5;
  cb.failureRateThreshold = 50;
  await cb.save();
  
  for (let i = 0; i < 4; i++) {
    await breakerLogic.recordSuccess(SERVICE);
  }
  for (let i = 0; i < 6; i++) {
    await breakerLogic.recordFailure({ serviceName: SERVICE, message: `Failure ${i}` });
  }
  
  const cbAfter = await breakerLogic.getBreaker(SERVICE);
  assert.strictEqual(cbAfter.state, 'OPEN');
  console.log('  ✓ Circuit opened due to high failure rate');
  
  const rate = cbAfter.getFailureRate();
  assert.ok(rate >= 50, `Failure rate should be >= 50%, got ${rate}%`);
  console.log(`  ✓ Failure rate calculated correctly: ${rate.toFixed(2)}%`);
}


async function testFailureHistory() {
  console.log('\n--- Integration Tests: Failure History ---\n');
  
  const SERVICE = 'history-test';
  await clearCollections();
  
  console.log('Test 1: logFailure creates record');
  await Failure.logFailure({
    serviceName: SERVICE,
    message: 'Test error',
    errorType: 'HTTP_ERROR',
    errorCode: '503',
    responseTime: 150
  });
  
  const failures = await Failure.find({ serviceName: SERVICE });
  assert.strictEqual(failures.length, 1);
  assert.strictEqual(failures[0].errorType, 'HTTP_ERROR');
  console.log('  ✓ Failure record created');
  
  console.log('Test 2: getRecent returns ordered failures');
  await Failure.logFailure({ serviceName: SERVICE, message: 'Error 2' });
  await Failure.logFailure({ serviceName: SERVICE, message: 'Error 3' });
  
  const recent = await Failure.getRecent(SERVICE, 2);
  assert.strictEqual(recent.length, 2);
  console.log('  ✓ Recent failures retrieved');
  
  console.log('Test 3: getStats aggregation');
  const stats = await Failure.getStats(SERVICE, 86400000);
  assert.ok(stats.totalFailures >= 3);
  console.log(`  ✓ Stats aggregated: ${stats.totalFailures} failures`);
}


async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       Circuit Breaker Test Suite                           ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  
  try {
    await setupTestDB();
    
    await testCircuitBreakerModel();
    await testBreakerLogic();
    await testHalfOpenState();
    await testHalfOpenRecovery();
    await testHalfOpenFailure();
    await testFailureRate();
    await testFailureHistory();
    
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║       ✅ All Tests Passed!                                 ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
  } catch (error) {
    console.error('\n❌ Test Failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await teardownTestDB();
  }
}

if (require.main === module) {
  runAllTests();
}

module.exports = { runAllTests };
