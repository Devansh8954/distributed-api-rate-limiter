# 💻 Running the Distributed API Rate Limiter Locally

This guide explains how to set up, run, and test the project on your local machine using either **Docker Compose** (recommended) or **npm + local Redis**.

---

## 🛠️ Prerequisites

Make sure you have installed:
- [Node.js (v20+)](https://nodejs.org/)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

---

## 🚀 Option 1: Quickest Setup with Docker Compose (Recommended)

Docker spins up both the **Node.js Express Gateway** and the **Redis** server in isolated containers automatically.

### Steps:
1. Open your terminal in the project directory:
   ```bash
   cd distributed-api-rate-limiter
   ```
2. Start the services with Docker Compose:
   ```bash
   docker compose up --build
   ```
3. Open your browser and navigate to:
   - 📊 **Developer Dashboard:** `http://localhost:3000/dashboard`
   - ⚡ **Protected API Endpoint:** `http://localhost:3000/api/v1/data`
   - 💓 **Health Check:** `http://localhost:3000/api/health`
   - 📈 **Prometheus Metrics:** `http://localhost:3000/metrics`
   - 🗄️ **Redis Commander GUI:** `http://localhost:8081`

To stop the services, press `Ctrl + C` or run:
```bash
docker compose down
```

---

## 🔧 Option 2: Running with Local Node.js + Redis

If you prefer running the TypeScript code directly with `nodemon` for fast local development and hot-reloading:

### 1. Start Redis
Make sure Redis is running locally on port `6379`:
```bash
# Via Docker
docker run -d --name local-redis -p 6379:6379 redis:7-alpine

# Or via WSL / Homebrew
redis-server
```

### 2. Copy Environment Variables
Create a local `.env` file from the example template:
```bash
cp .env.example .env
```

### 3. Install Dependencies & Start Dev Server
```bash
npm install
npm run dev
```

The gateway will start in watch mode on `http://localhost:3000`. Any code edits will trigger automatic server reloads!

---

## 🧪 Running Tests & Linting

```bash
# Run ESLint static check
npm run lint

# Run TypeScript type check
npx tsc --noEmit

# Run unit tests (Redis mocked)
npm run test:unit

# Run integration tests
npm run test:integration

# Run full test suite with coverage report
npm run test:coverage
```

---

## 🎮 How to Test Rate Limiting Manually

### Using curl / HTTP clients:

1. **Test Free Tier (Limit: 10 req/min):**
   ```bash
   curl -i http://localhost:3000/api/v1/data
   ```
   Inspect the headers returned:
   ```http
   HTTP/1.1 200 OK
   X-RateLimit-Limit: 10
   X-RateLimit-Remaining: 9
   X-RateLimit-Reset: 60
   X-RateLimit-Strategy: fixed-window
   X-RateLimit-Tier: Free Tier
   ```

2. **Test Pro Tier (Limit: 60 req/min):**
   ```bash
   curl -i -H "x-client-tier: pro" http://localhost:3000/api/v1/data
   ```

3. **Test Hot-Swapping Algorithm at Runtime:**
   ```bash
   # Switch active strategy to Sliding Window Counter (Lua)
   curl -X POST http://localhost:3000/api/admin/config \
     -H "Content-Type: application/json" \
     -d '{"strategy": "sliding-window-counter"}'
   ```
   Now send a request to `/api/v1/data`—notice the `X-RateLimit-Strategy: sliding-window-counter` header!

