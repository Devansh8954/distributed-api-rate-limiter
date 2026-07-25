# 04 — Rate Limiting Algorithms

The two algorithms this project implements, explained with diagrams.

---

## Why Rate Limiting Exists

Without rate limiting:
- A hacker can send 1,000,000 requests/second → your server crashes
- A buggy client can accidentally hammer your API → everyone else suffers
- Scrapers can steal all your data for free

Rate limiting says: **"You can only make N requests per time window. After that, wait."**

Real companies that rate limit:
- **Stripe:** 100 requests/second per API key
- **GitHub:** 5,000 requests/hour for authenticated users
- **Twitter:** 500 requests/15 minutes per endpoint
- **OpenAI:** Rate limits vary by model and tier

---

## Algorithm 1: Fixed Window Counter

### How It Works

Divide time into fixed, non-overlapping windows. Each IP gets a counter per window.

```
Time ──────────────────────────────────────────────────────────►

│◄── Window 1 (0-60s) ──►│◄── Window 2 (60-120s) ──►│
│                         │                           │
│  req1 req2 ... req10   │  req1 req2 ... req10      │
│  [  allowed zone  ]     │  [  counter resets  ]     │
│          req11 → 429   │                            │
```

### Redis Operations

```
Request arrives from IP "1.2.3.4":

1. INCR fw:1.2.3.4      → count = 7  (atomic, no race conditions)
2. if count == 1:
     EXPIRE fw:1.2.3.4 60  (only on first request — locks window start)
3. TTL fw:1.2.3.4       → 43  (seconds until window resets)

Decision:
  count (7) <= limit (10) → ALLOW ✅
  count (11) > limit (10) → BLOCK ❌
```

### The Boundary Burst Problem

This is the main weakness of Fixed Window:

```
Window 1 ends at t=60s
Window 2 starts at t=60s

                    t=59s         t=61s
                      │               │
Allowed: ─────────────┤ 10 requests   ├─ 10 requests ─────────
                      │               │
                      └── 2x burst! ──┘

A clever client fires 10 at t=59 + 10 at t=61 = 20 requests in 2 seconds.
Your limit is 10 per minute but they got 20 in 2 seconds.
```

### Code
See `src/algorithms/FixedWindowStrategy.ts`

### Complexity
- Time: **O(1)** per request (INCR + optional EXPIRE + TTL = 3 operations)
- Space: **O(1)** per IP (one Redis key with one integer value)

---

## Algorithm 2: Sliding Window Log

### How It Works

Instead of fixed buckets, we keep a log of every request's timestamp.
The "window" slides with each request — always looking back exactly N seconds.

```
Time ──────────────────────────────────────────────────────────►

Request at t=61s:
   Window = [t=1s ... t=61s]  (60 second lookback)

   Sorted Set for "1.2.3.4":
   Score │ Member
   ──────┼──────────────────────
   0001  │ uuid-a   ← PRUNED (older than t=1s)
   0059  │ uuid-b   ← PRUNED (older than t=1s)
   0015  │ uuid-c   ← PRUNED
   0030  │ uuid-d   ← VALID (within window)
   0045  │ uuid-e   ← VALID
   0061  │ uuid-f   ← NEW (this request)

   Count = 3 (uuid-d, uuid-e, uuid-f)
   3 < 10 limit → ALLOW ✅
```

### Redis Operations

```
1. ZREMRANGEBYSCORE sw:1.2.3.4  0  {now - 60000ms}  → prune old entries
2. ZCARD sw:1.2.3.4                                  → count = 7
3. EXPIRE sw:1.2.3.4  61                             → prevent memory leaks

if count < limit:
4. ZADD sw:1.2.3.4  {now_ms}  {uuid}                → log this request
   → ALLOW ✅

if count >= limit:
   → BLOCK ❌ (don't log it — don't consume a slot)
```

Why UUID as the member? Sorted Sets require unique members. If two requests arrive in the same millisecond (same score), without UUID they'd overwrite each other.

### No Boundary Burst

```
Request at t=59s: window = [t=-1 ... t=59]  → checks last 60s
Request at t=61s: window = [t=1  ... t=61]  → still checking last 60s

No "reset" ever happens — the window always looks back exactly 60 seconds.
A client can never exploit a boundary.
```

### Code
See `src/algorithms/SlidingWindowStrategy.ts`

### Complexity
- Time: **O(log N)** per request (Sorted Set operations are O(log N))
- Space: **O(N)** per IP (stores one entry per request in the window)

---

## Side-by-Side Comparison

| Factor | Fixed Window | Sliding Window |
|---|---|---|
| **Redis data structure** | String (integer) | Sorted Set |
| **Time complexity** | O(1) | O(log N) |
| **Space complexity** | O(1) per IP | O(N) per IP |
| **Accuracy** | ⚠️ Boundary burst possible | ✅ Perfectly accurate |
| **Memory usage** | Very low | Higher (stores log) |
| **Implementation** | Simple | Moderate |
| **Best for** | High-throughput general APIs | Auth, payments, sensitive endpoints |

---

## Other Algorithms (For Interview Knowledge)

These exist but are NOT implemented in this project:

### Token Bucket
The "classic" algorithm. Imagine a bucket that holds N tokens. Tokens are added at a constant rate. Each request consumes one token. If the bucket is empty, the request is rejected.

- Allows short bursts (empty the bucket all at once)
- Smooth traffic over time
- Used by: AWS API Gateway, Stripe

### Leaky Bucket
Requests go into a queue. They're processed at a fixed rate regardless of how fast they arrive (like a bucket with a hole at the bottom). Smooths traffic — no bursts allowed.

- Guarantees consistent output rate
- Extra queue latency
- Used by: traffic shaping in networking

### Sliding Window Counter
A hybrid between Fixed Window and Sliding Window Log. Approximates sliding window by weighting the previous window's count. O(1) space + more accurate than Fixed Window. Used by: Cloudflare.

---

## Which Should You Use?

For this project, switch via environment variable:
```env
RATE_LIMIT_STRATEGY=fixed-window   # For most endpoints
RATE_LIMIT_STRATEGY=sliding-window  # For login, payments, etc.
```

In a real production system, you might use Fixed Window for general API calls and Sliding Window for sensitive endpoints like `/api/auth/login`.
