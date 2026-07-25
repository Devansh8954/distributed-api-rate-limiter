# 05 — Docker & Containers Explained

This guide teaches you Docker from scratch using this project as the example.

---

## What is Docker?

Docker solves the classic problem: **"It works on my machine."**

Without Docker:
- You install Node.js 18 on your laptop, but the server has Node.js 14 → bugs
- You have Redis installed differently → different behavior
- A new teammate spends 2 hours setting up dependencies

With Docker:
- Your app is packaged into a **container** with everything it needs
- The container runs identically on any machine, any OS
- New teammate runs one command and is productive immediately

### Analogy
A container is like a shipping container. The ship (server) doesn't care what's inside. The container is self-contained with all its contents. It runs the same whether it's on a cargo ship, a truck, or your desk.

---

## Key Concepts

| Concept | Explanation | Analogy |
|---|---|---|
| **Image** | A blueprint/template for a container | A cookie cutter |
| **Container** | A running instance of an image | A cookie (made from the cutter) |
| **Dockerfile** | Instructions to build an image | A recipe |
| **Docker Compose** | Tool to run multiple containers together | A band conductor |
| **Volume** | Persistent storage that survives container restarts | A USB drive |
| **Network** | Private network so containers can talk to each other | A local WiFi |

---

## Our Dockerfile Explained Line by Line

```dockerfile
# Stage 1: Install dependencies
FROM node:20-alpine AS deps
```
- `FROM` — start with the `node:20-alpine` base image (Node.js 20 on Alpine Linux)
- `node:20-alpine` is tiny (~170MB) vs `node:20` (~1GB)
- `AS deps` — name this stage "deps" so we can reference it later

```dockerfile
WORKDIR /app
```
- All subsequent commands run inside `/app` directory
- Like doing `cd /app` inside the container

```dockerfile
COPY package*.json ./
RUN npm ci --only=production
```
- Copy `package.json` and `package-lock.json` FIRST (not all source code)
- **Why?** Docker caches layers. If only source code changes, Docker skips
  the `npm ci` step and uses the cached `node_modules`. Much faster builds!
- `npm ci` = clean install, exact versions from lock file (for reproducibility)
- `--only=production` = don't install Jest, TypeScript, etc. (not needed to run)

```dockerfile
# Stage 2: Build TypeScript
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci                   # Need ALL deps (including TypeScript)
COPY src/ ./src/
RUN npm run build            # tsc compiles TypeScript → JavaScript in /dist
```
This is a separate stage because TypeScript compiler is only needed for building, not running.

```dockerfile
# Stage 3: Lean runtime image
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup --system appgroup \
    && adduser --system --ingroup appgroup appuser
```
- Create a non-root user `appuser`
- **Security:** By default Docker containers run as root. If exploited, an attacker gets root access to your container. Running as non-root limits the damage.

```dockerfile
COPY --from=deps    /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist
COPY                package.json      ./
```
- Copy ONLY what we need from the previous stages
- We don't copy `src/` (TypeScript source), `node_modules` that include dev tools, etc.
- Result: a minimal image with compiled JS + prod dependencies only

```dockerfile
USER appuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "dist/server.js"]
```
- `USER` — switch to non-root user
- `EXPOSE` — document that the container listens on port 3000 (doesn't actually publish it)
- `HEALTHCHECK` — Docker will ping `/api/health` every 30s. If it fails 3 times → container marked unhealthy
- `CMD` — command that runs when the container starts

---

## Multi-Stage Build Benefits

| | Single Stage | Multi-Stage |
|---|---|---|
| **Image size** | ~800MB (includes TypeScript, nodemon, etc.) | ~200MB (only runtime) |
| **Attack surface** | Large (dev tools could be exploited) | Small |
| **Build artifacts** | Polluted with dev files | Clean |

---

## Docker Compose Explained

`docker-compose.yml` orchestrates multiple containers as a single application.

```yaml
networks:
  gateway-net:
    driver: bridge
```
Creates a private network. Containers on this network can reach each other by **service name** (e.g., the gateway can reach Redis at hostname `redis`).

```yaml
services:
  redis:
    image: redis/redis-stack:latest
    ports:
      - "6379:6379"   # host:container port mapping
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 5
```
- `image` — use this pre-built Docker image (no Dockerfile needed)
- `ports` — publish the container's 6379 port to your machine's 6379
- `healthcheck` — Docker periodically runs `redis-cli ping`. If it fails, the container is "unhealthy"

```yaml
  gateway:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - REDIS_URL=redis://redis:6379   # "redis" is the SERVICE NAME, not "localhost"
    depends_on:
      redis:
        condition: service_healthy     # Wait until Redis passes health check
```
- `build` — build from our Dockerfile (vs. using a pre-built image)
- `REDIS_URL=redis://redis:6379` — inside Docker's network, "redis" resolves to the Redis container's IP
- `depends_on` with `service_healthy` — don't start the gateway until Redis is ready

---

## Common Docker Commands

```bash
# Build and start all services
docker compose up --build

# Start in background (detached mode)
docker compose up -d --build

# View logs from all services
docker compose logs -f

# View logs from one service
docker compose logs -f gateway

# Stop all services (containers keep their data)
docker compose stop

# Stop and remove containers + networks (data in volumes survives)
docker compose down

# Stop and remove EVERYTHING including volumes (data deleted)
docker compose down -v

# Run a command inside a running container
docker exec -it rate-limiter-gateway sh

# See running containers
docker ps

# See all images on your machine
docker images

# Remove unused images (free up disk space)
docker image prune
```

---

## Volumes

```yaml
volumes:
  redis-data:  # Named volume
```

Without volumes: When you run `docker compose down`, ALL data in Redis is deleted (containers are stateless by design).

With a named volume: Redis writes to `/data` inside the container, which Docker maps to `redis-data` volume on your machine's disk. `docker compose down` → data survives. `docker compose down -v` → data deleted.

---

## Dockerfile Best Practices (Used in This Project)

1. ✅ Use `alpine` base images (smaller)
2. ✅ Multi-stage builds (separate build from runtime)
3. ✅ Copy `package.json` before source code (layer caching)
4. ✅ Use `npm ci` not `npm install` (reproducible builds)
5. ✅ Run as non-root user
6. ✅ Add HEALTHCHECK
7. ✅ Use `.dockerignore` to exclude `node_modules/`, `.env`, etc.
