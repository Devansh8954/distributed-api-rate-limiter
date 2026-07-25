# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Install production dependencies only
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# Copy package files first — Docker layer caching means npm ci only
# re-runs when package.json or package-lock.json actually change
COPY package*.json ./
RUN npm ci --only=production

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Compile TypeScript → JavaScript
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci                  # Need devDependencies for tsc

COPY src/ ./src/
RUN npm run build           # Outputs compiled JS to ./dist

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: Lean runtime image (only what we need to run)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# Security: run as a non-root user — if the container is compromised,
# the attacker can't write to / or modify system files
RUN addgroup --system appgroup \
    && adduser --system --ingroup appgroup appuser

# Copy only the compiled output and prod dependencies from previous stages
COPY --from=deps     /app/node_modules ./node_modules
COPY --from=builder  /app/dist         ./dist
COPY                 package.json      ./

USER appuser

EXPOSE 3000

# Docker will restart the container if this health check fails 3 times
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "dist/server.js"]
