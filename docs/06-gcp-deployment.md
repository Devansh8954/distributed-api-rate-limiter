# 06 — GCP Deployment Guide

Deploy your API Rate Limiter to Google Cloud Platform (GCP) step by step.

---

## Overview

We'll deploy to a **GCP Compute Engine** VM (a Linux server in the cloud). The VM will run our Docker Compose setup just like your local machine.

**Architecture after deployment:**
```
Internet → GCP VM (public IP) → Docker Compose → gateway:3000 → redis:6379
```

---

## Step 1: Create a GCP Account

1. Go to [cloud.google.com](https://cloud.google.com)
2. Click **"Get started for free"**
3. Sign in with your Google account
4. Enter billing info (you won't be charged — GCP gives $300 free credit for 90 days)
5. You'll land on the **GCP Console**

---

## Step 2: Create a New Project

1. Click the project dropdown at the top → **"New Project"**
2. Name it: `api-rate-limiter`
3. Click **Create**
4. Make sure you've selected this project in the dropdown

---

## Step 3: Create a VM Instance (Compute Engine)

1. In the left sidebar: **Compute Engine → VM instances**
2. Click **"Create Instance"**
3. Configure:

| Setting | Value | Why |
|---|---|---|
| Name | `rate-limiter-vm` | Any name |
| Region | `us-central1` | Free tier eligible |
| Machine type | `e2-micro` | Free tier (1 vCPU, 1GB RAM) |
| Boot disk | Ubuntu 22.04 LTS | Good Docker support |
| Boot disk size | 20 GB | Enough for Docker images |
| Firewall | ✅ Allow HTTP traffic | So we can reach port 80 |

4. Click **Create**

Wait 30 seconds. Your VM will appear with a public IP address.

---

## Step 4: Open Firewall Port 3000

By default, only ports 80 and 443 are open. We need port 3000.

1. Left sidebar: **VPC Network → Firewall**
2. Click **"Create Firewall Rule"**
3. Configure:
   - Name: `allow-rate-limiter`
   - Targets: All instances in network
   - Source IP ranges: `0.0.0.0/0`
   - Protocols and ports: TCP → `3000`
4. Click **Create**

---

## Step 5: SSH Into the VM

In the VM list, click the **SSH** button next to your VM. A browser terminal opens.

You're now inside your cloud server!

---

## Step 6: Install Docker on the VM

Run these commands in the SSH terminal:

```bash
# Update package list
sudo apt-get update

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add your user to the docker group (so you don't need sudo every time)
sudo usermod -aG docker $USER

# Reload group membership
newgrp docker

# Verify Docker is installed
docker --version
# Should output: Docker version 24.x.x

# Verify Docker Compose is available
docker compose version
# Should output: Docker Compose version v2.x.x
```

---

## Step 7: Clone Your GitHub Repo

```bash
# Clone your project
git clone https://github.com/YOUR_USERNAME/api-rate-limiter.git

# Navigate into the project
cd api-rate-limiter

# Verify the files are there
ls -la
```

---

## Step 8: Configure Environment Variables

```bash
# Copy the example env file
cp .env.example .env

# Edit it (nano is a simple terminal text editor)
nano .env
```

Change these values:
```env
NODE_ENV=production
REDIS_URL=redis://redis:6379   # Docker service name
RATE_LIMIT=10
WINDOW_SECONDS=60
RATE_LIMIT_STRATEGY=fixed-window
PORT=3000
```

Press `Ctrl+X`, then `Y`, then `Enter` to save.

---

## Step 9: Launch the Application

```bash
# Build and start in detached mode (runs in background)
docker compose up -d --build

# Verify all 3 containers are running
docker compose ps

# Watch the logs
docker compose logs -f
```

Expected output:
```
rate-limiter-redis     Up (healthy)
rate-limiter-gateway   Up (healthy)
rate-limiter-ui        Up
```

---

## Step 10: Test Your Live API

Find your VM's external IP in the GCP Console (it's listed in the VM instances page).

```bash
# From your LOCAL machine (not the VM), run:
curl http://YOUR_VM_EXTERNAL_IP:3000/api/health

# Expected:
{
  "status": "ok",
  "redis": "connected",
  "strategy": "fixed-window"
}
```

### Spam Test from Your Local Machine

**PowerShell:**
```powershell
1..15 | ForEach-Object {
    $r = Invoke-WebRequest "http://YOUR_VM_IP:3000/api/v1/data" -ErrorAction SilentlyContinue
    "Request $_: $($r.StatusCode)"
}
```

**Bash:**
```bash
for i in {1..15}; do
  echo -n "Request $i: "
  curl -s -o /dev/null -w "%{http_code}\n" http://YOUR_VM_IP:3000/api/v1/data
done
```

---

## Step 11: Keep It Running (Optional)

By default `docker compose up -d` already runs in the background. But if the VM reboots, it won't restart automatically. To fix:

```bash
# Enable Docker to start on boot
sudo systemctl enable docker

# The containers will restart because we set: restart: unless-stopped
# in docker-compose.yml
```

---

## Troubleshooting

**Containers not starting:**
```bash
docker compose logs gateway    # Check gateway logs
docker compose logs redis      # Check Redis logs
```

**Can't reach the API from outside:**
- Double check you created the firewall rule for port 3000
- Check your VM's external IP (not internal IP)
- Run `docker compose ps` to confirm containers are running and healthy

**Out of disk space:**
```bash
docker system prune -a    # Remove unused images and containers
```

---

## Cost Warning

The `e2-micro` VM is in the **GCP free tier** (always free, no expiry). But if you use larger VMs or other services, costs add up. Always:
- Delete VMs you're not using
- Set billing alerts in GCP Console → Billing → Budgets & Alerts

---

## What to Write in Your Resume / Portfolio

```
Deployed containerized Node.js microservice to GCP Compute Engine using
Docker Compose, with Redis as an in-memory datastore and automated health
checks for zero-downtime operation.
```

Include:
- The GCP Console screenshot showing your VM running
- A screenshot of the API returning 200 then 429 when rate limited
- The GitHub Actions CI/CD badge showing passing builds
