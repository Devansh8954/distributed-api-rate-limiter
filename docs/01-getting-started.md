# 01 — Getting Started

Welcome! This guide will get the project running on your machine in under 5 minutes.

---

## What You Need Installed

| Tool | Why | Install |
|---|---|---|
| **Node.js 20+** | Runs our TypeScript/JavaScript server | [nodejs.org](https://nodejs.org) |
| **Docker Desktop** | Runs Redis + our app in containers | [docker.com](https://www.docker.com/products/docker-desktop) |
| **Git** | Version control | Already installed |

> **Tip:** After installing Docker Desktop, make sure it's running before you continue. You should see the Docker whale icon in your system tray.

---

## Option A — Run Everything with Docker (Recommended)

This is the easiest way. One command spins up both the API Gateway and Redis.

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/api-rate-limiter.git
cd api-rate-limiter

# 2. Start everything
docker compose up --build

# That's it! Three services are now running:
#   http://localhost:3000        → API Gateway
#   http://localhost:8081        → Redis Commander (visual Redis UI)
#   http://localhost:8001        → RedisInsight (built-in Redis UI)
```

To stop: press `Ctrl+C` then run `docker compose down`

---

## Option B — Run Locally (Without Docker for the App)

Use this if you want to edit code and see changes instantly.

```bash
# 1. Start only Redis via Docker
docker run -d --name redis-local -p 6379:6379 redis:alpine

# 2. Install Node.js dependencies
npm install

# 3. Copy the environment file
cp .env.example .env

# 4. Start the dev server (auto-restarts on file changes)
npm run dev
```

---

## Testing the API

Once the server is running, open a new terminal and try these:

### Check if everything is healthy
```bash
curl http://localhost:3000/api/health
```
Expected response:
```json
{
  "status": "ok",
  "redis": "connected",
  "strategy": "fixed-window",
  "limit": 10,
  "windowSeconds": 60
}
```

### Hit the protected endpoint
```bash
curl http://localhost:3000/api/v1/data
```

### Watch the rate limiter block you (PowerShell)
```powershell
# Fire 15 requests — first 10 get 200, last 5 get 429
1..15 | ForEach-Object {
    $response = Invoke-WebRequest http://localhost:3000/api/v1/data -ErrorAction SilentlyContinue
    Write-Host "Request $_`: Status $($response.StatusCode)"
}
```

### Watch the rate limiter block you (bash/Mac/Linux)
```bash
for i in {1..15}; do
  echo -n "Request $i: "
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/v1/data
done
```

Expected output:
```
Request 1: 200
Request 2: 200
...
Request 10: 200
Request 11: 429
Request 12: 429
...
```

---

## Switch the Rate Limiting Algorithm

Edit the `.env` file (or environment in `docker-compose.yml`):

```env
# Change this line:
RATE_LIMIT_STRATEGY=fixed-window

# To this:
RATE_LIMIT_STRATEGY=sliding-window
```

Restart the server and the algorithm switches with no code changes!

---

## Run the Test Suite

```bash
npm test                 # All tests
npm run test:unit        # Unit tests only (fast, no Redis needed)
npm run test:integration # Integration tests only
npm run test:coverage    # Tests + coverage report
```

---

## View Prometheus Metrics

```bash
curl http://localhost:3000/metrics
```

This outputs raw Prometheus metrics. In production, you'd point a Prometheus server here and visualize in Grafana.

---

## What's Next?

- Read `02-system-architecture.md` to understand how all the pieces fit together
- Read `03-redis-explained.md` to understand what Redis is and why we use it
- Read `04-rate-limiting-algorithms.md` to understand the two algorithms in depth
