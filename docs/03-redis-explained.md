# 03 — Redis Explained

Redis is the core of how our rate limiter works. This guide explains Redis from scratch.

---

## What is Redis?

Redis = **RE**mote **DI**ctionary **S**erver

It's a database — but very different from MySQL or PostgreSQL:

| Feature | MySQL (Traditional DB) | Redis |
|---|---|---|
| Storage | Disk | **RAM (memory)** |
| Data format | Tables + rows | Key-value pairs |
| Speed | ~5ms average | **< 1ms average** |
| Use case | Permanent data | Temporary/fast data |
| Data types | Rows, columns | Strings, Lists, Sets, Hashes, Sorted Sets |

**Why use Redis for rate limiting?**  
Rate limit counters need to be updated on *every single request* — potentially millions per second. Redis handles this easily because it lives entirely in RAM.

---

## Redis Data Types We Use

### 1. String (for Fixed Window Counter)

A simple key → value store where the value is a number.

```bash
# Set a key with value
SET user:count 0

# Atomically increment by 1 (returns new value)
INCR user:count          # → 1
INCR user:count          # → 2
INCR user:count          # → 3

# Set it to expire in 60 seconds
EXPIRE user:count 60

# Check remaining time to live
TTL user:count           # → 58 (seconds remaining)

# Get the value
GET user:count           # → "3"
```

**What "atomic" means:** Even if 1,000 requests arrive at the exact same millisecond, Redis processes INCR operations one at a time. The counter will always be exactly correct. No race conditions.

### 2. Sorted Set (for Sliding Window)

A set where every member has a **score** (number). Members are always sorted by score.

We use timestamps as scores and request UUIDs as members:

```bash
# Add entries: ZADD key score member
ZADD ratelimit:127.0.0.1 1700000001000 "req-uuid-1"
ZADD ratelimit:127.0.0.1 1700000002000 "req-uuid-2"
ZADD ratelimit:127.0.0.1 1700000061000 "req-uuid-3"

# Count all members
ZCARD ratelimit:127.0.0.1    # → 3

# Remove entries where score is between 0 and 60 seconds ago
ZREMRANGEBYSCORE ratelimit:127.0.0.1 0 1700000000000
# → removes req-uuid-1 and req-uuid-2 (too old)

ZCARD ratelimit:127.0.0.1    # → 1 (only req-uuid-3 remains)
```

---

## Redis Commands in Our Project

### Fixed Window Strategy

```bash
# On every request for IP "127.0.0.1":

INCR fw:127.0.0.1
# If this is the first request (returned 1):
EXPIRE fw:127.0.0.1 60

TTL fw:127.0.0.1   # How many seconds until the window resets
```

Watch this happen live! Open Redis Commander at `http://localhost:8081`
and spam the API endpoint. You'll see the `fw:127.0.0.1` key appear,
count up, then disappear after 60 seconds.

### Sliding Window Strategy

```bash
# Remove old entries
ZREMRANGEBYSCORE sw:127.0.0.1 0 {60-seconds-ago-in-ms}

# Count remaining (how many in current window)
ZCARD sw:127.0.0.1

# If under limit: add this request
ZADD sw:127.0.0.1 {current-timestamp-ms} {uuid}

# Prevent memory leaks
EXPIRE sw:127.0.0.1 61
```

---

## Connecting Node.js to Redis

We use the official `redis` npm package:

```typescript
import { createClient } from 'redis';

const client = createClient({ url: 'redis://localhost:6379' });

client.on('error', (err) => console.error('Redis error:', err));
await client.connect();

// Now use it
await client.incr('my-key');    // INCR my-key
await client.expire('my-key', 60);  // EXPIRE my-key 60
```

### Why Singleton Pattern?

We only call `createClient()` once (in `redisClient.ts`) and reuse that one connection everywhere. If we created a new connection on every request:
- Each connection uses ~1MB of memory
- 1,000 requests/second = 1,000 connections = 1GB RAM wasted
- Redis has a default max of 10,000 connections

---

## Running Redis Commands Directly

If you want to practice Redis commands by hand:

```bash
# Open the Redis CLI inside the Docker container
docker exec -it rate-limiter-redis redis-cli

# Try these commands:
PING                        # → PONG (connection works)
SET hello world             # → OK
GET hello                   # → "world"
INCR counter                # → 1
INCR counter                # → 2
EXPIRE counter 10           # → 1 (success)
TTL counter                 # → 9 (seconds remaining)
KEYS *                      # Show all keys (careful in production!)
FLUSHALL                    # Delete everything (useful for resetting tests)
```

---

## Redis in Production

Things to know for interviews:

**Persistence:** By default Redis is in-memory only. If it crashes, data is lost. For our rate limiter that's fine (counters reset = clean slate). For real data, Redis supports:
- **RDB** (snapshots every N seconds to disk)  
- **AOF** (append-only log of every write command)

**Clustering:** A single Redis node handles ~100,000 ops/second. For higher scale, Redis Cluster splits keys across multiple nodes automatically.

**Memory limit:** Redis uses `maxmemory` config to cap RAM usage. When full, it evicts keys based on a policy (e.g., evict the least recently used key). For rate limiting, LRU eviction is fine — losing an old IP's counter just means they get a fresh window.
