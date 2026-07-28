# 📚 Comprehensive Project Guide: Distributed API Rate Limiter

Welcome! This guide breaks down everything you need to know about this project in plain, easy-to-understand language. Whether you are new to backend systems or preparing for technical interviews, this document explains **what** this project does, **why** it was built this way, and **how** each component works.

---

## 📑 Table of Contents
1. [What is an API Rate Limiter?](#1-what-is-an-api-rate-limiter)
2. [Why Do We Need Redis? (In-Memory Data Store)](#2-why-do-we-need-redis-in-memory-data-store)
3. [The 4 Rate-Limiting Algorithms Explained](#3-the-4-rate-limiting-algorithms-explained)
4. [Architecture & System Flow](#4-architecture--system-flow)
5. [Key Design Patterns Used](#5-key-design-patterns-used)
6. [Multi-Tenant Tiering (Free vs Pro vs Enterprise)](#6-multi-tenant-tiering-free-vs-pro-vs-enterprise)
7. [Real-Time Observability & Monitoring](#7-real-time-observability--monitoring)
8. [Fail-Open Resilience Strategy](#8-fail-open-resilience-strategy)

---

## 1. What is an API Rate Limiter?

### The Bouncer Analogy 🚪
Imagine a popular nightclub with a strict capacity. If 1,000 people attempt to rush through the front door at the exact same second, the club will become overcrowded and collapse. 

A **Rate Limiter** is like the bouncer standing at the front door. Its job is to control the incoming flow of HTTP requests:
- If a legitimate user visits the website occasionally $\rightarrow$ **Allowed (HTTP 200 OK)**
- If a bot or attacker spams 100 requests in 1 second $\rightarrow$ **Blocked (HTTP 429 Too Many Requests)**

### Real-World Use Cases
- **Preventing Denial-of-Service (DoS) Attacks:** Stopping malicious scripts from overwhelming your servers.
- **Cost Control:** Limiting requests to expensive third-party APIs (e.g., OpenAI, Stripe, Twilio).
- **Enforcing API Tier Limits:** Charging customers based on usage (e.g., Free Tier gets 10 requests/min, Pro gets 60 requests/min).

---

## 2. Why Do We Need Redis? (In-Memory Data Store)

To decide whether an incoming request should be allowed or blocked, the rate limiter must keep track of request counts for every user (keyed by IP address or API key).

### Why not use a SQL database (MySQL / PostgreSQL)?
Writing to disk on every single incoming HTTP request creates huge latency bottlenecks. A SQL query takes 5–50 milliseconds. A rate limiter must process checks in **under 1 millisecond**.

### Why not use Node.js server memory (`Map` or `object`)?
If your backend runs on a single server, in-memory counters work fine. But in modern cloud architectures, you run **multiple server instances** behind a load balancer:

```
                  ┌──────────────┐
                  │ Load Balancer│
                  └──────┬───────┘
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
     ┌─────────┐    ┌─────────┐    ┌─────────┐
     │ Server 1│    │ Server 2│    │ Server 3│
     └────┬────┘    └────┬────┘    └────┬────┘
          │              │              │
          └──────────────┼──────────────┘
                         ▼
             ┌──────────────────────┐
             │ Redis (Shared Memory)│
             └──────────────────────┘
```

If Server 1 maintains its own memory, a user could send 10 requests to Server 1, 10 to Server 2, and 10 to Server 3—bypassing a 10 req/min limit!

**Redis** solves this because it is:
1. **In-Memory:** Stores everything in RAM, responding in sub-milliseconds ($<1\text{ms}$).
2. **Centralized & Shared:** All backend server instances connect to the same Redis instance.
3. **Atomic Operations:** Guarantees thread-safe increments (`INCR`, `EVAL`, `ZADD`) without race conditions.

---

## 3. The 4 Rate-Limiting Algorithms Explained

This project implements four different rate-limiting algorithms, each tailored for different use cases.

### 1️⃣ Fixed Window Counter (`FixedWindowStrategy.ts`)
- **How it works:** Time is divided into fixed buckets (e.g., 12:00:00 to 12:01:00). A counter increments in Redis (`INCR`). When the count exceeds the limit, requests are blocked. At the turn of the minute, the window resets to 0.
- **Pros:** Ultra-fast $O(1)$ operations, extremely low memory usage.
- **Cons (The Boundary Burst Glitch):** A user could send 10 requests at 12:00:59 and 10 requests at 12:01:01. That is **20 requests in 2 seconds**, while staying within limits for both individual windows!

### 2️⃣ Sliding Window Log (`SlidingWindowStrategy.ts`)
- **How it works:** Every request timestamp is recorded in a Redis Sorted Set (`ZSET`). On every request, entries older than $(t - \text{windowSeconds})$ are pruned, and the remaining elements are counted (`ZCARD`).
- **Pros:** 100% accurate sliding window. Zero boundary burst glitch.
- **Cons:** High memory overhead (stores every timestamp string in Redis). $O(\log N)$ performance.

### 3️⃣ Token Bucket (`TokenBucketStrategy.ts`)
- **How it works:** Imagine a bucket filled with tokens up to a max capacity. Tokens are added back continuously at a fixed refill rate (e.g., 1 token every 6 seconds). Each request removes 1 token. If the bucket is empty, requests are blocked.
- **Pros:** Handles **bursty traffic** gracefully (allows short spikes up to full bucket capacity, then throttles to continuous refill rate).
- **Cons:** Requires tracking last update timestamp + current token count state.

### 4️⃣ Sliding Window Counter via Lua Script (`SlidingWindowCounterLuaStrategy.ts`)
- **How it works:** The Cloudflare/Stripe enterprise approach! Combines the low memory of Fixed Window with the accuracy of Sliding Window. It calculates a weighted average between the current window and previous window:
$$\text{Estimated Count} = (\text{PrevWindowCount} \times \text{Weight}) + \text{CurrentWindowCount}$$
- **Pros:** Sub-millisecond performance, $O(1)$ memory usage, atomic execution in Redis via Lua.

---

## 4. Architecture & System Flow

```
 Client Request (HTTP GET /api/v1/data)
                 │
                 ▼
  ┌──────────────────────────────┐
  │ Helmet / Express Security     │
  └──────────────┬───────────────┘
                 │
                 ▼
  ┌──────────────────────────────┐
  │ Rate Limiter Middleware      │
  │ 1. Extract IP & Tier Header  │
  │ 2. Get Active Strategy       │
  │ 3. Execute Strategy.consume()│
  └──────────────┬───────────────┘
                 │
         ┌───────┴───────┐
         │               │
  [Allowed: true]  [Allowed: false]
         │               │
         ▼               ▼
  ┌─────────────┐ ┌───────────────────────────┐
  │ Return 200  │ │ Return 429 Too Many Req  │
  │ OK + Data   │ │ + Retry-After Header      │
  └─────────────┘ └───────────────────────────┘
```

---

## 5. Key Design Patterns Used

### 🟢 Strategy Pattern
The rate limiter uses the **Strategy Pattern** (`IRateLimiterStrategy.ts`). All four algorithms implement the same interface:
```typescript
export interface IRateLimiterStrategy {
  consume(key: string, customLimit?: number, customWindowSeconds?: number): Promise<RateLimiterResult>;
}
```
This decouples the middleware from the algorithm implementation. Switching from Fixed Window to Sliding Window Counter requires zero changes to the Express middleware logic!

### 🟢 Singleton Pattern
Services like `TelemetryService` and `RedisClient` use the **Singleton Pattern**, ensuring only one instance is instantiated across the lifecycle of the application to share connections and state safely.

---

## 6. Multi-Tenant Tiering (Free vs Pro vs Enterprise)

The system automatically checks incoming headers (`x-client-tier` or `x-api-key`) and assigns tier-specific limits:

| Tier | Header Value | Rate Limit | Window |
|---|---|---|---|
| **Free** | `free` / unauthenticated | 10 req | 60 sec |
| **Pro** | `pro` | 60 req | 60 sec |
| **Enterprise** | `enterprise` | 300 req | 60 sec |

---

## 7. Real-Time Observability & Monitoring

1. **Live Developer Control Dashboard (`/dashboard`):** Static dark-mode UI with live throughput canvas graph and synthetic traffic generator.
2. **Server-Sent Events (SSE) Telemetry (`/api/admin/events`):** Streams live request metrics to open browser tabs without polling overhead.
3. **Prometheus Metrics (`/metrics`):** Exposes Prometheus counters and gauges for enterprise Grafana dashboard integration.

---

## 8. Fail-Open Resilience Strategy

If Redis goes down or encounters network timeouts, the rate limiter catches the error and **fails open**:
- Logs the error securely.
- Allows the request through to downstream services.

**Why?** In production, it is far better for a site to temporarily remain open without rate limiting than to break entirely and return 500 errors to all legitimate users.

