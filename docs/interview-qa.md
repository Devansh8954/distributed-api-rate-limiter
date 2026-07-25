# Interview Q&A — API Rate Limiter

Prepare these answers for technical interviews at FAANG and product companies.
These questions come up in phone screens, behavioral rounds, and system design interviews.

---

## Section 1: Project Basics (Phone Screen Questions)

### Q1: Can you walk me through your rate limiter project?

**Your answer:**
> "I built a distributed API Gateway in TypeScript that protects backend services from DDoS attacks and API abuse. The core of it is a rate-limiting middleware that intercepts every request, queries Redis to check how many times that IP has called the API in the last 60 seconds, and either lets the request through or returns a 429 Too Many Requests.
>
> What I'm proud of is that I implemented two different algorithms — Fixed Window Counter and Sliding Window Log — and used the Strategy design pattern to make them swappable via an environment variable. I also added a Prometheus metrics endpoint and structured logging so the service is observable in production. It's all containerized with Docker Compose and has a CI/CD pipeline with GitHub Actions."

---

### Q2: Why did you use Redis instead of just storing counts in memory?

**Your answer:**
> "Great question. If I stored counters in the Node.js process memory, that works fine for a single server. But the moment you scale horizontally — say, three instances behind a load balancer — each instance has its own independent counter. A client could make 10 requests to server 1, 10 to server 2, and 10 to server 3, completely bypassing the rate limit.
>
> Redis is a separate, shared datastore that all server instances connect to. The counter lives in one place. So even with 100 server instances, the rate limit is enforced globally. That's what makes it 'distributed'."

---

### Q3: What is the Token Bucket algorithm?

**Your answer:**
> "Token Bucket is a rate limiting concept where you imagine a bucket that holds N tokens. Tokens are added at a constant rate — say, 1 token per second for a limit of 60 per minute. Each request consumes one token. If the bucket is empty, the request is rejected.
>
> The key property is that it allows short bursts: if no one has used the API for 30 seconds, the bucket fills up to capacity and the client can fire 60 requests immediately. This is useful for bursty traffic patterns.
>
> In my project, I implemented two simpler variants — Fixed Window Counter and Sliding Window Log — because they map more cleanly to Redis operations. But the concept is related."

---

### Q4: Explain the difference between your two algorithms.

**Your answer:**
> "Fixed Window divides time into non-overlapping 60-second buckets. Each IP gets a Redis string key with a counter that resets when the window expires. It's O(1) in time and space — super fast. The downside is the 'boundary burst' problem: a client can fire 20 requests at a window boundary — 10 at second 59 and 10 at second 61 — and technically not violate the per-minute limit.
>
> Sliding Window Log fixes this by storing a timestamp for every request in a Redis Sorted Set. The 'window' always looks back exactly 60 seconds from the current moment. On each request, we prune expired entries, count what's left, and decide. There's no burst possible because the window slides continuously. The trade-off is O(log N) time and O(N) space per IP — more accurate but more resource-intensive.
>
> I chose which to use based on the endpoint. For general API calls, Fixed Window is fine. For sensitive endpoints like auth or payments, you'd want Sliding Window."

---

## Section 2: System Design Questions

### Q5: How would you scale this to handle 1 million requests per second?

**Your answer:**
> "A few layers:
>
> First, Redis. A single Redis instance handles about 100,000 ops/second. At 1M rps, you'd use Redis Cluster, which automatically shards keys across multiple nodes. The sharding key would be the IP address, so all requests from one IP go to the same shard — important for consistency.
>
> Second, the Node.js gateway. Node is single-threaded but uses the event loop effectively. You'd run one process per CPU core using Node's cluster module or Kubernetes horizontal pod autoscaling. With a load balancer distributing traffic, each node handles a fraction of the total.
>
> Third, you might add a local cache in front of Redis. If an IP is already rate-limited, you can cache that decision in memory for a few seconds and skip the Redis call entirely. This reduces Redis load for spam IPs.
>
> Fourth, for true DDoS scale, you'd move rate limiting to the edge — CloudFlare, AWS WAF, or Nginx, which operate at L4/L7 before traffic even hits your application servers."

---

### Q6: What happens if Redis goes down?

**Your answer:**
> "I designed this with a 'fail-open' approach. If the Redis call throws an error, my middleware catches the exception and calls `next()` — the request is allowed through. I log an error so the on-call engineer gets alerted.
>
> The alternative is 'fail-closed' — if Redis is down, block all requests. That's safer against abuse but means your API is completely down whenever Redis has an issue.
>
> The trade-off depends on your product. For a payment API, fail-closed makes sense — a few minutes of downtime is better than unlimited API abuse. For a news feed API, fail-open is better — the cost of abuse for a few minutes is low and user availability matters more.
>
> In production, you'd also use Redis Sentinel or Redis Cluster for high availability so downtime is rare."

---

### Q7: How do you handle rate limiting across multiple server instances?

**Your answer:**
> "This is exactly why I used Redis instead of in-memory storage. Since all instances connect to the same Redis, the counter is global. When request 1 hits server A and request 2 hits server B, both instances INCR the same Redis key `fw:1.2.3.4`. The Redis operation is atomic — there are no race conditions even under concurrent load. So the counter is always accurate regardless of how many Node.js instances you have."

---

### Q8: How would you add per-user rate limiting instead of per-IP?

**Your answer:**
> "Right now, the Redis key is the client's IP address. To support per-user limiting, you'd change the key to the user's API key or user ID, which you'd extract from the request — either from an `Authorization` header (JWT) or an `X-API-Key` header.
>
> The middleware would become: `const key = req.headers['x-api-key'] || req.ip`. If an API key is present, use it; fall back to IP for unauthenticated requests.
>
> You could also have tiered limits: free users get 10 req/min, paid users get 100 req/min. This would require a database lookup (Redis or SQL) to get the user's tier, then pass the appropriate limit to the rate limiter. This is exactly how Stripe and OpenAI do it."

---

## Section 3: Code Design Questions

### Q9: Why did you use the Strategy design pattern?

**Your answer:**
> "I had two algorithms that solve the same problem — rate limiting — but with different implementations. Without the Strategy pattern, I'd have to write a big if/else in the middleware:
> ```
> if (strategy === 'fixed-window') {
>   // fixed window logic here
> } else if (strategy === 'sliding-window') {
>   // sliding window logic here
> }
> ```
> That violates the Open/Closed Principle — every time I add a new algorithm, I modify the middleware code.
>
> With Strategy, I defined an interface `IRateLimiterStrategy` with one method: `consume(key)`. Each algorithm implements this interface. The middleware only interacts with the interface. Adding a new algorithm is just: create a new class, implement the interface, wire it up in server.ts. Zero changes to the middleware."

---

### Q10: What is a "fail-open" vs "fail-closed" design? Which did you choose and why?

**Your answer:**
> "Fail-open means: if a dependency fails, the system continues operating (allows requests). Fail-closed means: if a dependency fails, the system blocks everything.
>
> In my middleware's catch block, I call `next()` which lets the request through — that's fail-open. I chose this because our primary job is to serve API responses. The rate limiter is a protection layer, not the core feature. A few minutes of unprotected traffic during a Redis outage is acceptable. The alternative — fail-closed — would mean our entire API goes down every time Redis hiccups. That's worse for users.
>
> If this were a login endpoint where abuse is catastrophic, I'd switch to fail-closed."

---

### Q11: What are the race conditions you thought about?

**Your answer:**
> "The main concern is two requests arriving simultaneously and both reading the counter before either increments it — they'd both see count=9 and both be allowed, even if the true count should be 11.
>
> Redis's INCR command is atomic, meaning Redis executes it in a single, isolated operation. No other command can run between the 'read current value' and 'write incremented value' steps. So there's no race condition with INCR.
>
> For the Sliding Window, I use a Redis pipeline to batch ZREMRANGEBYSCORE + ZCARD + EXPIRE in one round-trip. There's a small window between the ZCARD and the ZADD where another request could sneak in, but this is an acceptable approximation. For strict consistency, you'd use a Lua script to make the entire operation atomic."

---

## Section 4: Behavioral Questions

### Q12: What was the hardest part of building this project?

**Your answer (adapt to your experience):**
> "The trickiest part was understanding the subtle bug with EXPIRE in the Fixed Window algorithm. My first instinct was to set the EXPIRE on every request. But that would reset the 60-second timer on every request — so a client making one request per second would never have their counter expire, effectively removing the rate limit.
>
> The fix is to only set EXPIRE when the counter is 1 — i.e., on the very first request of a window. That locks the window start time. I only realized this by thinking carefully about the state transitions and writing unit tests that caught the bug."

---

### Q13: How did you test this project?

**Your answer:**
> "I wrote three levels of tests. Unit tests mock the Redis client and test each algorithm class in isolation — they verify edge cases like the exact boundary (10th request allowed, 11th blocked), the EXPIRE-only-on-first-request behavior, and the key naming convention. These run in milliseconds.
>
> Integration tests spin up a real Express app with an in-memory mock Redis (not a separate process) and send HTTP requests using supertest. These test the full request → middleware → route flow and verify the response headers are correct.
>
> For manual testing, I use Docker Compose which brings up the real Redis, then I run a bash loop that fires 15 requests and checks the status codes. I also open Redis Commander to watch the keys being created and expiring in real time — that visual feedback was very helpful for debugging."

---

### Q14: What would you improve if you had more time?

**Strong answer:**
> "A few things. First, Lua scripting in Redis — the Sliding Window has a small non-atomic gap between ZCARD and ZADD. A Lua script runs atomically in Redis, eliminating that window.
>
> Second, per-endpoint rate limits. Right now all `/api/v1/*` routes share the same limit. A real system would have different limits for `/api/v1/data` vs `/api/v1/auth/login` — login should be much stricter.
>
> Third, a Redis Sentinel or Cluster setup for high availability. Right now if Redis goes down, we fail-open. With Sentinel, Redis would auto-failover to a replica in seconds.
>
> Fourth, distributed tracing with OpenTelemetry — adding trace IDs to log lines so you can follow a single request across services in tools like Jaeger or Datadog."

---

## Section 5: Quick-Fire Technical Questions

| Question | Answer |
|---|---|
| What HTTP status code does rate limiting use? | **429 Too Many Requests** (RFC 6585) |
| What header tells clients when to retry? | **Retry-After** (seconds until reset) |
| What's the time complexity of Fixed Window? | **O(1)** — just INCR + EXPIRE + TTL |
| What's the time complexity of Sliding Window? | **O(log N)** — sorted set operations |
| Why use `npm ci` instead of `npm install`? | `ci` does a clean install from lock file — reproducible, no accidental upgrades |
| What does Docker's HEALTHCHECK do? | Periodically runs a command; marks container unhealthy if it fails |
| What is a multi-stage Docker build? | Separate stages for building vs running — final image only has runtime code |
| Why run Docker containers as non-root? | Limits damage if the container is compromised |
| What is a Redis Sorted Set? | A set where every member has a numeric score; members always sorted by score |
| What does `INCR` do atomically? | Reads, increments, and writes in one operation — no race conditions |
| What is Prometheus? | A monitoring system that scrapes metrics endpoints every N seconds |
| What is a Singleton pattern? | A class that creates only one instance and reuses it everywhere |
| What is graceful shutdown? | On SIGTERM, finish in-flight requests before closing connections |
| Why `trust proxy 1` in Express? | Makes `req.ip` return the client's real IP, not the load balancer's IP |
| What's a 503 response? | Service Unavailable — used when a dependency (like Redis) is down |
