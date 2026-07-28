# Visual API Gateway & Distributed Rate Limiter Suite

A production-grade distributed API Gateway and real-time visual control platform built with **TypeScript, Node.js, Express, and Redis**. Features dynamic algorithm hot-swapping, multi-tenant tier limits, atomic Redis Lua scripting, and an interactive dark-mode developer control panel with live traffic simulation.

[![CI/CD Deploy to GCP Cloud Run](https://github.com/Devansh8954/distributed-api-rate-limiter/actions/workflows/deploy.yml/badge.svg)](https://github.com/Devansh8954/distributed-api-rate-limiter/actions)

---

## 🌐 Live Demo & Interactive Dashboard (Deployed on GCP Cloud Run)

**Control Center Dashboard →** `https://api-rate-limiter-266670750120.asia-south1.run.app/dashboard`
**Protected API Endpoint →** `https://api-rate-limiter-266670750120.asia-south1.run.app/api/v1/data`

* Open the dashboard to launch synthetic request bursts (e.g. 50 req/sec), watch live visual charts block requests in `429 Too Many Requests`, inspect Redis keys and TTLs in real-time, and switch rate-limiting algorithms on the fly!

---

## 🚀 Key Platform Features

- **Interactive Control Center & Traffic Simulator:** Real-time dark-mode developer dashboard with live canvas throughput graphs, custom burst generators, and real-time Server-Sent Events (SSE) telemetry.
- **4 Pluggable Rate-Limiting Algorithms (Strategy Pattern):**
  1. **Fixed Window Counter** — Fast $O(1)$ atomic counter.
  2. **Sliding Window Log** — Sub-second timestamp precision via Redis Sorted Sets (`ZSET`).
  3. **Token Bucket** — Dynamic token refill handling burst traffic smoothly.
  4. **Sliding Window Counter (Atomic Lua Script)** — Cloudflare/Stripe pattern executing inside Redis via Lua (`EVAL`) for sub-millisecond execution and minimal memory footprint.
- **Multi-Tenant Tiering:** Differentiate traffic policies by client tier headers (`Free`: 10 req/min, `Pro`: 60 req/min, `Enterprise`: 300 req/min).
- **Runtime Hot-Swapping:** Change algorithms or global thresholds dynamically via REST API or UI without server restarts.
- **Prometheus Telemetry & Observability:** `/metrics` endpoint exposing gateway telemetry.
- **Fail-Open Resilience:** Designed to fail open if Redis drops, preserving application uptime.
- **Containerized Deployment:** Multi-stage `Dockerfile` and `docker-compose.yml` configured for GCP / cloud production.

---

## System Architecture

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │                      INTERACTIVE DASHBOARD UI                         │
 │        Live Throughput Charts · Algorithm Switcher · Traffic Simulator  │
 └───────────────────────────────────┬────────────────────────────────────┘
                                     │ HTTP / SSE Stream
                                     ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                         EXPRESS GATEWAY API                            │
 │  /dashboard       → Static UI & Control Panel                          │
 │  /api/v1/*        → Rate-Limited Endpoints (Multi-Tenant & Tiered)    │
 │  /api/admin/*     → Config & Redis Key Inspector APIs                   │
 │  /api/admin/events→ Real-Time Telemetry Stream (Server-Sent Events)    │
 └───────────────────────────────────┬────────────────────────────────────┘
                                     │
           ┌─────────────────────────┴─────────────────────────┐
           ▼                                                   ▼
 ┌───────────────────────────────────┐               ┌───────────────────┐
 │       STRATEGY REGISTRY           │               │ TELEMETRY ENGINE  │
 │  • Fixed Window                   │               │ • SSE Broadcast   │
 │  • Sliding Window Log             │               │ • Prometheus      │
 │  • Token Bucket                   │               │ • Winston Logs    │
 │  • Sliding Window Counter (Lua)   │               └───────────────────┘
 └─────────────────┬─────────────────┘
                   │
                   ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                         REDIS DATA STORE                               │
 │   Atomic Lua Scripts · Key TTLs · Token Buckets · Tier Rule Hash      │
 └────────────────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Language** | TypeScript 5.x | Type safety, strategy interfaces, OOP patterns |
| **Framework** | Express.js 4.x | HTTP Gateway router & SSE streaming |
| **In-Memory Store** | Redis 7.x | Atomic counters, ZSET logs, token buckets, and Lua scripts |
| **Telemetry** | Prometheus & Winston | Metrics aggregation & structured JSON logging |
| **Testing** | Jest + Supertest | Unit & integration testing |
| **Containers** | Docker & Docker Compose | Containerization & service orchestration |

---

## Quick Start

**Prerequisites:** [Docker Desktop](https://www.docker.com/products/docker-desktop)

```bash
git clone https://github.com/Devansh8954/distributed-api-rate-limiter.git
cd distributed-api-rate-limiter
docker compose up --build
```

Access services locally:
- **Control Dashboard:** `http://localhost:3000/dashboard`
- **Protected Endpoint:** `http://localhost:3000/api/v1/data`
- **Prometheus Metrics:** `http://localhost:3000/metrics`
- **Redis Commander UI:** `http://localhost:8081`

---

## API Reference

| Endpoint | Method | Rate Limited? | Description |
|---|---|---|---|
| `/dashboard` | `GET` | ❌ No | Visual Control Center UI |
| `/api/v1/data` | `GET` | ✅ Yes | Rate-limited protected API |
| `/api/admin/config` | `GET / POST` | ❌ No | Get or update active strategy & limits |
| `/api/admin/redis-keys` | `GET` | ❌ No | Inspect live Redis rate-limit keys & TTLs |
| `/api/admin/simulate` | `POST` | ❌ No | Server-side traffic burst simulator |
| `/api/admin/events` | `GET` | ❌ No | Telemetry Server-Sent Events (SSE) stream |
| `/metrics` | `GET` | ❌ No | Prometheus metrics scrape endpoint |

---

## Testing

```bash
npm run test:unit        # Run unit tests (Redis mocked)
npm run test:integration # Run integration tests
npm run test:coverage    # Generate test coverage report
```

---

## Key Interview Talking Points

* **Why Redis Lua Scripts?** Sliding Window Counter implemented via atomic Redis Lua script ensures zero race conditions across multi-node Express deployments without network multi-roundtrip overhead.
* **Why Strategy Pattern?** Decouples middleware logic from algorithm execution. Switching from Fixed Window to Sliding Window Counter requires 0 middleware changes.
* **Multi-Tenant Gateway Design:** Supports tier-based rate limiting (`x-client-tier` header) allowing SLA guarantees for Free vs. Enterprise clients.
