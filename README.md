# Circuit Breaker Project

A production-grade implementation of the **Circuit Breaker** design pattern using **Node.js**, **Express**, and **MongoDB**. The project includes a REST API backend, a simulated payment service, and a real-time web dashboard for monitoring and control.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Circuit Breaker States](#circuit-breaker-states)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
  - [Backend](#backend)
  - [Frontend](#frontend)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Dashboard](#dashboard)
- [Testing](#testing)
- [Prometheus Metrics](#prometheus-metrics)
- [Signal Handlers](#signal-handlers)

---

## Overview

The Circuit Breaker pattern prevents cascading failures in distributed systems by temporarily stopping requests to a failing downstream service. This project demonstrates the pattern applied to a payment processing service with:

- Persistent state stored in MongoDB
- Configurable failure thresholds, timeouts, and recovery windows
- A live dashboard for real-time monitoring, configuration, and simulation
- Prometheus-compatible `/metrics` endpoint

---

## Architecture

```
┌─────────────────┐        ┌────────────────────────┐
│  Frontend (SPA) │ ──────▶│  Express Backend (:3000)│
└─────────────────┘        │                        │
                           │  circuitBreakerMiddleware│
                           │         │              │
                           │         ▼              │
                           │  paymentService        │
                           │  (simulated / external) │
                           │         │              │
                           │         ▼              │
                           │     MongoDB            │
                           │  (circuit_breakers)    │
                           └────────────────────────┘
```

Every inbound request passes through the `circuitBreakerMiddleware` before reaching the payment handler. The middleware checks the current state persisted in MongoDB and either forwards the request or immediately returns `503 Service Unavailable`.

---

## Circuit Breaker States

| State | Description |
|---|---|
| **CLOSED** | Normal operation. All requests pass through. Failures are counted. |
| **OPEN** | Service is failing. All requests are rejected with `503`. After a configurable timeout the breaker transitions to HALF_OPEN. |
| **HALF_OPEN** | Recovery probe. A limited number of test requests are allowed. Enough successes close the circuit; any failure re-opens it. |

**Trip conditions** (both must be true):
- `failureCount >= threshold` (default **5**)
- `failureRate >= failureRateThreshold` (default **50 %**)

---

## Project Structure

```
Circuit_Breaker_Project/
├── backend/
│   ├── app.js                  # Express application entry point
│   ├── .env.example            # Environment variable template
│   ├── config/
│   │   └── db.js               # MongoDB connection
│   ├── middleware/
│   │   └── circuitBreaker.js   # Express middleware + wrap helper
│   ├── models/
│   │   ├── CircuitBreaker.js   # Mongoose schema & state logic
│   │   └── Failure.js          # Failure log schema
│   ├── services/
│   │   └── paymentService.js   # Simulated / external payment service
│   ├── utils/
│   │   └── breakerLogic.js     # Core state machine logic
│   └── tests/
│       ├── circuitBreaker.test.js
│       └── loadTest.js
└── frontend/
    ├── index.html              # Dashboard SPA
    ├── main.js                 # Dashboard logic
    └── styles.css
```

---

## Prerequisites

- Node.js ≥ 18
- MongoDB ≥ 5 (local instance or Atlas connection string)

---

## Getting Started

### Backend

```bash
cd backend

# Install dependencies
npm install

# Copy and edit environment variables
cp .env.example .env

# Start in development mode (auto-reload via nodemon)
npm run dev

# Or start in production mode
npm start
```

The server starts on **port 3000** by default (configurable via `PORT`).

### Frontend

```bash
cd frontend

# Serve the static dashboard (no build step required)
npm start        # http://localhost:8080
# or
npm run dev
```

Open `http://localhost:8080` in your browser. The dashboard connects to the backend at `http://localhost:3000` by default.

---

## Configuration

Copy `backend/.env.example` to `backend/.env` and adjust as needed:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port for the backend |
| `MONGO_URI` | `mongodb://localhost:27017/circuit_breaker` | MongoDB connection string |
| `FAIL_RATE` | `0.3` | Simulated payment failure rate (0–1) |
| `MIN_LATENCY` | `50` | Minimum simulated latency (ms) |
| `MAX_LATENCY` | `200` | Maximum simulated latency (ms) |
| `TIMEOUT_RATE` | `0.1` | Fraction of failures that are timeouts |
| `PAYMENT_TIMEOUT` | `5000` | Timeout for real external payment calls (ms) |
| `PAYMENT_SERVICE_URL` | *(unset)* | Real downstream URL; leave unset to use simulation |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins |

**Circuit breaker defaults** (adjustable at runtime via the Admin API or dashboard):

| Parameter | Default | Description |
|---|---|---|
| `threshold` | `5` | Minimum failure count to trip |
| `failureRateThreshold` | `50` | Minimum failure rate (%) to trip |
| `timeout` | `30000 ms` | Time in OPEN state before trying HALF_OPEN |
| `windowSize` | `60000 ms` | Rolling measurement window |
| `halfOpenMaxRequests` | `3` | Max probe requests in HALF_OPEN |
| `successThreshold` | `3` | Successes required to close from HALF_OPEN |

---

## API Reference

### Payment

| Method | Path | Description |
|---|---|---|
| `POST` | `/payment` | Process a payment (protected by circuit breaker) |

**Request body:**
```json
{ "amount": 100, "currency": "USD" }
```

**Success response (200):**
```json
{
  "ok": true,
  "transactionId": "txn_1234567890_abc123",
  "message": "Payment processed successfully",
  "amount": 100,
  "processingTime": 134
}
```

**Circuit open response (503):**
```json
{
  "error": "Service temporarily unavailable",
  "message": "Circuit is OPEN. Retry in 28s",
  "state": "OPEN",
  "serviceName": "payment-service",
  "retryAfter": 28
}
```

---

### Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Basic liveness check |
| `GET` | `/health/detailed` | Liveness + MongoDB + circuit breaker state |
| `GET` | `/health/downstream` | Downstream payment service health |

---

### Admin

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/status` | Full circuit breaker status + recent failures |
| `POST` | `/admin/reset` | Reset circuit to CLOSED and clear failure history |
| `POST` | `/admin/threshold` | Update the failure count threshold |
| `POST` | `/admin/config` | Update one or more config values |
| `POST` | `/admin/health-check` | Manually trigger a downstream health check |
| `GET` | `/admin/simulation` | Get current simulation settings |
| `POST` | `/admin/simulation` | Update simulation settings (failRate, latency, etc.) |

**Example — update config:**
```bash
curl -X POST http://localhost:3000/admin/config \
  -H 'Content-Type: application/json' \
  -d '{"threshold": 10, "timeout": 60000, "failureRateThreshold": 60}'
```

**Example — reset circuit:**
```bash
curl -X POST http://localhost:3000/admin/reset
# or: npm run reset  (from the backend directory)
```

---

### Metrics

| Method | Path | Description |
|---|---|---|
| `GET` | `/metrics` | Prometheus-format metrics |

---

## Dashboard

The frontend dashboard (`http://localhost:8080`) provides:

- **State indicator** — colour-coded CLOSED / OPEN / HALF_OPEN badge
- **Metrics grid** — live failure count, failure rate, total requests, failed requests
- **HALF_OPEN panel** — probe request progress during recovery
- **Controls** — manual refresh, circuit reset, downstream health check, auto-refresh toggle
- **Configuration panel** — update threshold, rate threshold, and timeout in real time
- **Simulation panel** — adjust the payment service fail rate on the fly
- **Test payments** — send a single payment or run a configurable flood test
- **Recent failures** — timestamped failure log with error types and response times
- **Activity log** — rolling in-page log of all dashboard events

---

## Testing

```bash
cd backend

# Unit / integration tests (uses mongodb-memory-server)
npm test

# Load test (default: moderate RPS for 30 s)
npm run test:load

# Heavy load test (100 RPS for 60 s)
npm run test:load:heavy
```

---

## Prometheus Metrics

The `/metrics` endpoint exposes the following gauges and counters:

| Metric | Type | Description |
|---|---|---|
| `circuit_breaker_state` | gauge | Current state: 0=CLOSED, 1=OPEN, 2=HALF_OPEN |
| `circuit_breaker_failure_count` | gauge | Failures in the current measurement window |
| `circuit_breaker_request_total` | gauge | Requests in the current measurement window |
| `circuit_breaker_trips_total` | counter | Total number of times the circuit has opened |

---

## Signal Handlers

The backend responds to Unix signals for operational control:

| Signal | Action |
|---|---|
| `SIGUSR1` | Reset circuit breaker to CLOSED |
| `SIGUSR2` | Log current circuit breaker status to stdout |
| `SIGTERM` / `SIGINT` | Graceful shutdown (closes MongoDB connection) |

```bash
# Example: reset via signal
kill -SIGUSR1 <pid>

# Or use the npm shortcut
npm run reset
```
