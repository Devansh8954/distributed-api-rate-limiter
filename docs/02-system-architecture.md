# 02 — System Architecture

Understanding how all the pieces fit together.

---

## The Big Picture

```
┌─────────────────────────────────────────────────────────────┐
│                      Your Computer                          │
│                                                             │
│  ┌──────────┐    HTTP     ┌──────────────────────────────┐ │
│  │  Client  │────────────►│   Express.js API Gateway     │ │
│  │(Postman/ │◄────────────│   Port 3000                  │ │
│  │ Browser) │  Response   │                              │ │
│  └──────────┘             │  ┌────────────────────────┐  │ │
│                           │  │  Rate Limiter          │  │ │
│                           │  │  Middleware            │  │ │
│                           │  │                        │  │ │
│                           │  │  "Has this IP made     │  │ │
│                           │  │   too many requests?"  │  │ │
│                           │  └──────────┬─────────────┘  │ │
│                           │             │ INCR/ZADD       │ │
│                           └─────────────┼────────────────┘ │
│                                         │                   │
│                           ┌─────────────▼────────────────┐ │
│                           │         Redis                 │ │
│                           │         Port 6379             │ │
│                           │                               │ │
│                           │  Key: fw:127.0.0.1 → 7       │ │
│                           │  TTL: 43 seconds remaining    │ │
│                           └───────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Request Lifecycle (Step by Step)

Here's exactly what happens when a client sends a `GET /api/v1/data` request:

### Step 1 — Request Arrives at Express
```
Client → Express Router → Rate Limiter Middleware
```
Express receives the HTTP request and routes it through middleware before any route handler runs.

### Step 2 — Rate Limiter Middleware Fires
```typescript
const clientIp = req.ip;  // e.g. "127.0.0.1"
const result = await strategy.consume(clientIp);
```
The middleware extracts the client's IP address and calls the rate limiter strategy.

### Step 3 — Redis Query
Depending on which algorithm is active, Redis is queried:

**Fixed Window:**
```
INCR fw:127.0.0.1     → returns 8 (8th request this window)
TTL  fw:127.0.0.1     → returns 43 (43 seconds left)
```

**Sliding Window:**
```
ZREMRANGEBYSCORE sw:127.0.0.1 0 {60 seconds ago}  → prune old
ZCARD sw:127.0.0.1                                  → count = 7
ZADD sw:127.0.0.1 {now} {uuid}                     → log this request
```

### Step 4 — Decision
```
count <= limit → allowed = true  → set headers → next()  → 200 OK
count >  limit → allowed = false → set headers → return  → 429
```

### Step 5 — Response Headers
Whether allowed or blocked, these headers are always set:
```
X-RateLimit-Limit:     10
X-RateLimit-Remaining: 2
X-RateLimit-Reset:     43
X-RateLimit-Strategy:  fixed-window
```
On 429 responses, additionally:
```
Retry-After: 43
```

---

## Folder Structure Explained

```
api-rate-limiter/
│
├── src/                        ← All application source code
│   │
│   ├── algorithms/             ← Rate limiting algorithms live here
│   │   ├── IRateLimiterStrategy.ts   ← The "contract" (interface)
│   │   ├── FixedWindowStrategy.ts    ← Algorithm 1
│   │   └── SlidingWindowStrategy.ts  ← Algorithm 2
│   │
│   ├── middleware/             ← Express middleware
│   │   └── rateLimiter.ts     ← Wires the algorithm to Express
│   │
│   ├── routes/                 ← HTTP route handlers
│   │   ├── api.ts             ← /api/v1/data and /api/health
│   │   └── metrics.ts         ← /metrics (Prometheus)
│   │
│   ├── services/               ← External service connections
│   │   └── redisClient.ts     ← Redis connection (singleton)
│   │
│   ├── utils/                  ← Helper utilities
│   │   └── logger.ts          ← Structured logging (Winston)
│   │
│   ├── config.ts              ← All environment config in one place
│   └── server.ts              ← App entry point (starts Express)
│
├── tests/
│   ├── unit/                  ← Test individual classes in isolation
│   │   ├── fixedWindow.test.ts
│   │   └── slidingWindow.test.ts
│   └── integration/           ← Test full request → response flow
│       └── rateLimiter.integration.test.ts
│
├── docs/                      ← You are here! Learning materials
│
├── Dockerfile                 ← Instructions to containerize the app
├── docker-compose.yml         ← Orchestrate app + Redis + UI
└── .github/workflows/ci.yml  ← Automated CI/CD pipeline
```

---

## Design Patterns Used

### 1. Strategy Pattern (Most Important!)

**Problem:** We have two different rate-limiting algorithms. How do we switch between them without changing the middleware code?

**Solution:** Define an interface (`IRateLimiterStrategy`) that both algorithms implement. The middleware only talks to the interface — it doesn't know which algorithm is running.

```
IRateLimiterStrategy (interface)
    ├── FixedWindowStrategy   implements IRateLimiterStrategy
    └── SlidingWindowStrategy implements IRateLimiterStrategy

rateLimiter.ts (middleware) → only uses IRateLimiterStrategy
```

To switch algorithms, you only change `server.ts` (or an env var). Zero middleware changes.

### 2. Singleton Pattern

**Problem:** We don't want to open a new Redis connection on every request (expensive!).

**Solution:** `redisClient.ts` creates one connection and reuses it across the entire app.

### 3. Factory Pattern

`createRateLimiterMiddleware()` and `createApiRouter()` are factory functions — they create and return configured objects (middleware and routers) rather than constructing them directly.

---

## Why Not Just Use `express-rate-limit`?

`express-rate-limit` is a great library and is what you'd use in a real startup. But:
- Building it from scratch shows you *understand* how it works
- You can explain every line in an interview
- You can tune the exact Redis commands being used
- FAANG interviews will ask you to design this from first principles

Think of this project as "I could have used the library but I built it myself to learn the internals."
