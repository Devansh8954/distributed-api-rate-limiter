# API Rate Limiter — Cloud Gateway

A production-grade distributed API Gateway that protects backend services from DDoS attacks and API abuse using Redis-backed rate limiting.

[![CI Pipeline](https://github.com/Devansh8954/distributed-api-rate-limiter/actions/workflows/ci.yml/badge.svg)](https://github.com/Devansh8954/distributed-api-rate-limiter/actions)

---

## 🌐 Live Demo (Deployed on GCP)

**Try it now →** `http://136.115.81.182:3000/api/v1/data`

Hit that URL more than 10 times and watch it automatically block you with `429 Too Many Requests`.
That's rate limiting — the same system Stripe, GitHub, and Google use to protect their APIs.

<details>
<summary>More endpoints</summary>

| Endpoint | Description |
|---|---|
| `/api/health` | Health check — confirms Redis is connected |
| `/metrics` | Prometheus metrics (for monitoring systems) |
| `http://136.115.81.182:8081` | Redis Commander — visualize live rate-limit counters |

</details>

---

## What It Does

Every request to `/api/v1/*` is intercepted by a rate-limiting middleware that:
1. Extracts the client's IP address
2. Queries Redis: *"How many requests has this IP made in the last 60 seconds?"*
3. **If under limit** → allows the request, increments the counter
4. **If over limit** → returns `429 Too Many Requests`

```
Client → Express Gateway → Rate Limiter Middleware → Redis
                                    ↓
                         allowed? → Route Handler → 200 OK
                         blocked? → 429 Too Many Requests
```

---

## Features

- **Two rate-limiting algorithms** — Fixed Window Counter (O(1)) and Sliding Window Log (O(log N)), switchable via environment variable
- **Strategy design pattern** — algorithms are pluggable without changing middleware code
- **Prometheus metrics** — `/metrics` endpoint for observability
- **Structured logging** — JSON logs via Winston, colorized in development
- **Graceful shutdown** — handles SIGTERM/SIGINT without dropping requests
- **Fail-open design** — if Redis goes down, requests are allowed through (configurable)
- **Health check endpoint** — `/api/health` pings Redis and reports status
- **Full test suite** — unit tests (Redis mocked) + integration tests (supertest)
- **GitHub Actions CI/CD** — lint → test → docker build on every push

---

## Tech Stack

| Technology | Role |
|---|---|
| **TypeScript** | Language — type safety, better developer experience |
| **Express.js** | HTTP framework |
| **Redis** | In-memory counter store (Fixed Window) / Sorted Set store (Sliding Window) |
| **Winston** | Structured logging |
| **Prometheus (prom-client)** | Metrics & observability |
| **Jest + supertest** | Unit & integration testing |
| **Docker + Docker Compose** | Containerization & orchestration |
| **GitHub Actions** | CI/CD pipeline |

---

## Quick Start

**Prerequisites:** [Docker Desktop](https://www.docker.com/products/docker-desktop)

```bash
git clone https://github.com/Devansh8954/distributed-api-rate-limiter.git
cd distributed-api-rate-limiter
docker compose up --build
```

That's it. Three services start:
- `http://localhost:3000` — API Gateway
- `http://localhost:8081` — Redis Commander (visual Redis UI)
- `http://localhost:8001` — RedisInsight (Redis UI built into redis-stack)

---

## API Reference

| Endpoint | Rate Limited? | Description |
|---|---|---|
| `GET /api/v1/data` | ✅ Yes | Protected data endpoint |
| `GET /api/health` | ❌ No | Health check (pings Redis) |
| `GET /metrics` | ❌ No | Prometheus metrics |

### Response Headers (every request)

```
X-RateLimit-Limit:     10          Max requests per window
X-RateLimit-Remaining: 7           Requests left in current window
X-RateLimit-Reset:     43          Seconds until window resets
X-RateLimit-Strategy:  fixed-window  Algorithm in use
```

### On 429 responses, additionally:
```
Retry-After: 43
```

### 200 OK Response
```json
{
  "message": "Success! Here is your data.",
  "timestamp": "2026-07-25T17:00:00.000Z",
  "server": "api-rate-limiter-gateway",
  "version": "v1"
}
```

### 429 Too Many Requests Response
```json
{
  "error": "Too Many Requests",
  "message": "You have exceeded the rate limit. Please slow down.",
  "retryAfter": 43
}
```

---

## Rate Limiting Algorithms

### Fixed Window Counter (default)
- Divides time into fixed 60-second windows
- Redis `INCR` + `EXPIRE` — **O(1)** time and space
- ⚠️ Has a boundary burst problem at window edges
- Best for: general-purpose API endpoints

### Sliding Window Log
- Stores a timestamped log of every request in a Redis Sorted Set
- No boundary burst — perfectly accurate
- **O(log N)** time, **O(N)** space per IP
- Best for: auth endpoints, payment APIs

Switch via environment variable (no code change needed):
```env
RATE_LIMIT_STRATEGY=fixed-window   # default
RATE_LIMIT_STRATEGY=sliding-window
```

---

## Configuration

Copy `.env.example` to `.env` and customize:

```env
PORT=3000
NODE_ENV=development
REDIS_URL=redis://localhost:6379
RATE_LIMIT=10
WINDOW_SECONDS=60
RATE_LIMIT_STRATEGY=fixed-window
```

---

## Development

```bash
npm install          # Install dependencies
cp .env.example .env # Set up environment
npm run dev          # Start with hot-reload (requires Redis running)
npm test             # Run all tests
npm run test:coverage # Tests + coverage report
npm run lint         # Lint TypeScript files
```

Run Redis locally for development:
```bash
docker run -d --name redis-dev -p 6379:6379 redis:alpine
```

---

## Testing

```bash
npm run test:unit        # Unit tests (no Redis needed — mocked)
npm run test:integration # Integration tests
npm run test:coverage    # Coverage report → ./coverage/
```

### Manual Rate Limit Test

**PowerShell:**
```powershell
1..15 | ForEach-Object {
    $r = Invoke-WebRequest http://localhost:3000/api/v1/data -ErrorAction SilentlyContinue
    "Request $_: $($r.StatusCode)"
}
```

**Bash:**
```bash
for i in {1..15}; do
  echo -n "Request $i: "
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/v1/data
done
```

Expected: `200 200 200 200 200 200 200 200 200 200 429 429 429 429 429`

---

## Project Structure

```
├── src/
│   ├── algorithms/          # Rate limiting algorithms
│   │   ├── IRateLimiterStrategy.ts  # Strategy interface
│   │   ├── FixedWindowStrategy.ts   # Fixed Window Counter
│   │   └── SlidingWindowStrategy.ts # Sliding Window Log
│   ├── middleware/
│   │   └── rateLimiter.ts   # Express middleware
│   ├── routes/
│   │   ├── api.ts           # /api/v1/data, /api/health
│   │   └── metrics.ts       # /metrics (Prometheus)
│   ├── services/
│   │   └── redisClient.ts   # Singleton Redis connection
│   ├── utils/
│   │   └── logger.ts        # Winston logger
│   ├── config.ts            # Environment config
│   └── server.ts            # App entry point
├── tests/
│   ├── unit/                # Isolated algorithm tests
│   └── integration/         # Full request flow tests
├── Dockerfile               # Multi-stage build
└── docker-compose.yml       # Gateway + Redis + Redis UI
```

---

---

## GCP Deployment

See `docs/production-deployment.md` for the full step-by-step guide.

**Live instance running on:** GCP Compute Engine `us-central1-a` (e2-micro, always-free tier)

```bash
# On your GCP VM after cloning the repo:
docker compose up -d --build

# Test from your local machine:
curl http://136.115.81.182:3000/api/health
```

---

## Design Decisions

**Why Redis over in-memory storage?** In-memory counters only work on a single server. Redis is a shared external store that all server instances connect to, making rate limiting work correctly across horizontally scaled deployments.

**Why fail-open on Redis errors?** Availability > protection for general APIs. If Redis goes down, we log the error and allow requests through rather than taking down the entire API.

**Why the Strategy pattern?** Allows swapping rate-limiting algorithms via environment variable with zero changes to middleware, routes, or any other business logic. New algorithm = new class implementing `IRateLimiterStrategy`.

**Why multi-stage Docker build?** Separates build tooling (TypeScript compiler, dev dependencies) from the runtime image. Result is a ~200MB runtime image instead of ~800MB.
