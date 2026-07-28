# ☁️ Production Deployment Guide (GCP Cloud Run + Upstash Redis)

This guide walks you step-by-step through setting up automated production deployment via **GitHub Actions**, **GCP Cloud Run**, and **Upstash Redis** (free tier).

---

## 📋 Prerequisites
1. A [Google Cloud Platform (GCP)](https://console.cloud.google.com/) account.
2. A free [Upstash Redis](https://upstash.com/) account.
3. Your code pushed to a GitHub repository.

---

## 🟢 Step 1: Create a Free Managed Redis Database (Upstash)

1. Sign in to [Upstash Console](https://console.upstash.com/).
2. Click **Create Database**.
3. Name your database (e.g., `rate-limiter-redis`), select **Global** or region closest to your server (e.g., `ap-south-1` Mumbai).
4. Click **Create**.
5. Under **Connect to your database**, copy the `UPSTASH_REDIS_REST_URL` or standard Redis connection string:
   ```text
   redis://default:YOUR_PASSWORD@YOUR_ENDPOINT.upstash.io:6379
   ```

---

## 🟢 Step 2: Set Up GCP Keyless Authentication (Workload Identity Federation)

We use **Workload Identity Federation (WIF)** instead of downloading service account JSON keys. GitHub exchanges short-lived OIDC tokens directly with GCP.

1. Open **Google Cloud Console** $\rightarrow$ Click the **Cloud Shell (`>_`)** icon at top right.
2. Set your environment variables (replace `YOUR_GITHUB_USERNAME` with your actual GitHub username):
   ```bash
   export PROJECT_ID=$(gcloud config get-value project)
   export SA_EMAIL="github-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
   export REPO="YOUR_GITHUB_USERNAME/distributed-api-rate-limiter"
   ```
3. Run the automated GCP setup script block:
   ```bash
   # 1. Create Docker Artifact Registry repository
   gcloud artifacts repositories create api-rate-limiter \
     --repository-format=docker \
     --location=asia-south1 \
     --description="Docker repository for API Rate Limiter Gateway"

   # 2. Create Deployment Service Account
   gcloud iam service-accounts create github-deployer \
     --display-name="GitHub Actions Deployer"

   # 3. Grant IAM roles (Artifact Registry, Cloud Run Admin, Service Account User)
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:${SA_EMAIL}" \
     --role="roles/artifactregistry.writer"
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:${SA_EMAIL}" \
     --role="roles/run.admin"
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:${SA_EMAIL}" \
     --role="roles/iam.serviceAccountUser"

   # 4. Create Workload Identity Pool & Provider for GitHub OIDC
   gcloud iam workload-identity-pools create "github-pool" \
     --location="global" \
     --display-name="GitHub Actions Pool"

   export POOL_ID=$(gcloud iam workload-identity-pools describe "github-pool" \
     --location="global" \
     --format="value(name)")

   gcloud iam workload-identity-pools providers create-oidc "github-provider" \
     --location="global" \
     --workload-identity-pool="github-pool" \
     --display-name="GitHub Provider" \
     --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
     --attribute-condition="assertion.repository == '${REPO}'" \
     --issuer-uri="https://token.actions.githubusercontent.com"

   gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
     --role="roles/iam.workloadIdentityUser" \
     --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.repository/${REPO}"

   # Print the 3 values needed for GitHub Secrets:
   echo "=========================================="
   echo "1. GCP_PROJECT_ID: $PROJECT_ID"
   echo "2. GCP_WIF_SA:     $SA_EMAIL"
   echo -n "3. GCP_WIF_PROVIDER: "
   gcloud iam workload-identity-pools providers describe "github-provider" \
     --location="global" \
     --workload-identity-pool="github-pool" \
     --format="value(name)"
   echo "=========================================="
   ```

---

## 🟢 Step 3: Configure GitHub Secrets

Go to your GitHub repository:
**Settings** $\rightarrow$ **Secrets and variables** $\rightarrow$ **Actions** $\rightarrow$ **New repository secret**.

Add the following 5 secrets:

| Secret Name | Value |
|---|---|
| `GCP_PROJECT_ID` | Output `1` from Step 2 |
| `GCP_WIF_SA` | Output `2` from Step 2 |
| `GCP_WIF_PROVIDER` | Output `3` from Step 2 |
| `REDIS_URL` | Upstash Redis connection string from Step 1 |
| `ADMIN_API_KEY` | Generate random secret (e.g. `openssl rand -hex 32`) |

---

## 🟢 Step 4: Trigger CI/CD Deployment

1. Commit and push your changes to `main`:
   ```bash
   git push origin main
   ```
2. Go to the **Actions** tab in GitHub.
3. Watch the workflow execute:
   - **CI Pipeline:** Lints, typechecks, runs all unit & integration tests, and verifies Docker container health.
   - **Deploy Pipeline:** Authenticates to GCP keylessly via WIF, builds & pushes Docker image to GCP Artifact Registry, deploys service to Cloud Run, and pings live `/api/health`.

---

## 🔍 Post-Deployment Verification

Once the deployment completes, GitHub Actions will output your live URL:
```text
https://api-rate-limiter-xxxxxx.asia-south1.run.app/dashboard
```
Open the link to interact with your live rate limiter on GCP!

