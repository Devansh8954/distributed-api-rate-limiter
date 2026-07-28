# 🎯 SDE / Backend Engineering Interview Prep Guide

This document contains key interview questions, system design trade-offs, and FAANG-caliber architectural answers specifically tailored for this project.

---

## 📌 Top Interview Questions & Standard Answers

### Q1: Can you walk me through the high-level architecture of your Rate Limiter?
**Answer:** 
> "I built a distributed API Gateway rate-limiting service using Node.js, Express, TypeScript, and Redis. The gateway uses Express middleware to intercept incoming requests before they reach target endpoints. It uses the Strategy Pattern to dynamically evaluate rate limits using one of four pluggable algorithms (Fixed Window, Sliding Window Log, Token Bucket, or Sliding Window Counter via Redis Lua scripting). State is centralized in Redis so that multiple stateless Express app nodes behind a load balancer share the same rate-limit counter state. The system also includes real-time telemetry streaming via Server-Sent Events (SSE) and Prometheus metric exports."

---

### Q2: Why did you use Redis instead of a relational database or in-memory Map?
**Answer:**
> "There are two main reasons: latency and state sharing across distributed nodes.
> 
> 1. **Latency:** Rate-limiting checks run on *every single request*. Relational databases (like PostgreSQL) hit disk I/O, resulting in 5–50ms latency overhead per check. Redis operates entirely in RAM, returning checks in sub-milliseconds ($<1\text{ms}$).
> 2. **Distributed Consistency:** If we used in-memory JavaScript objects (`Map`), each instance of a horizontally scaled Node.js service would maintain its own isolated counters. A client could send requests across 5 nodes and get $5\times$ their allowed quota. Centralizing state in Redis ensures all nodes check against a single source of truth."

---

### Q3: What is the TOCTOU race condition in rate limiters, and how did you solve it?
**Answer:**
> "TOCTOU stands for Time-Of-Check to Time-Of-Use. In a multi-node backend environment, two concurrent requests from the same IP hitting different server nodes at the exact same millisecond might both read the same count (e.g., count = 9 out of 10 allowed). Both nodes check that count $< 10$, allow both requests, and increment Redis. This lets 11 requests through for a limit of 10.
>
> I solved this by implementing our Token Bucket and Sliding Window Counter algorithms as **atomic Redis Lua scripts (`EVAL`)**. Redis runs Lua scripts sequentially inside its single-threaded event loop. Read, compute, refill, decrement, and write operations all execute atomically in a single network round-trip without any possibility of interleaving concurrent requests."

---

### Q4: Explain the trade-offs between the 4 rate-limiting algorithms you implemented.
**Answer:**
> 
> | Algorithm | Time Complexity | Memory Complexity | Best For | Trade-off / Limitation |
> |---|---|---|---|---|
> | **Fixed Window Counter** | $O(1)$ | $O(1)$ | High-throughput public endpoints | Boundary burst edge case (2x spike across window boundary) |
> | **Sliding Window Log** | $O(\log N)$ | $O(N)$ (stores timestamps) | High-security endpoints (e.g. `/login`) | Higher Redis RAM usage; stores full request timestamp logs |
> | **Token Bucket** | $O(1)$ | $O(1)$ | APIs with bursty traffic profiles (e.g. AWS, Stripe) | Requires storing last update timestamp and token count |
> | **Sliding Window Counter (Lua)** | $O(1)$ | $O(1)$ | Enterprise gateways (Cloudflare/Stripe) | Weighted estimate; $<0.05\%$ approximation variance |

---

### Q5: How does your rate limiter handle Redis failures or downtime? (Resilience)
**Answer:**
> "I designed the rate-limiter middleware to **Fail Open**. If Redis becomes unreachable or throws a network timeout error, the try/catch block logs the failure via Winston structured logging and calls `next()` to let the HTTP request proceed.
> 
> In production system design, failing open is standard practice for rate limiters. Blocking all user traffic (failing closed) during a cache outage turns a temporary rate-limiter glitch into a total outage for all customers."

---

### Q6: How do you support multi-tenant client tiers (Free vs. Enterprise)?
**Answer:**
> "The middleware inspects request headers (`x-client-tier` or `x-api-key`) and passes the identifier to `DynamicConfigService.getTierConfig()`. This resolves the client's rate-limit policy (e.g., Free: 10 req/min, Pro: 60 req/min, Enterprise: 300 req/min). 
> 
> Redis keys are namespaced with the tier and IP (e.g., `swc:pro-tier:192.168.1.1`), ensuring separate budgets per client tier."

---

### Q7: How does your CI/CD deployment work on GCP Cloud Run?
**Answer:**
> "Deployment is fully automated using GitHub Actions.
> 
> 1. **CI Stage:** On every commit/PR, the CI workflow runs ESLint static analysis, TypeScript strict type checking, and Jest test coverage suite. It then builds a production Docker image and runs a container smoke test with a temporary Redis service container.
> 2. **CD Stage:** Once CI passes on `main`, GitHub Actions authenticates keylessly with GCP using **Workload Identity Federation (OIDC)**—no service account JSON keys stored in GitHub secrets. It builds and pushes the image to GCP Artifact Registry, deploys to Cloud Run with zero downtime, and performs an automated post-deployment health check ping."

