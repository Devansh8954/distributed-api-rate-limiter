# Production Steps (GCP Cloud Run)

This project is set up to deploy automatically when you push code to GitHub.

### Step 1: Set up Google Cloud
1. Go to Google Cloud Console.
2. Open the Cloud Shell (the `>_` terminal icon at the top right).
3. Copy and paste this exact block of code:
```bash
export PROJECT_ID=$(gcloud config get-value project)
export SA_EMAIL="github-deployer@${PROJECT_ID}.iam.gserviceaccount.com"
export REPO="YOUR_GITHUB_USERNAME/distributed-api-rate-limiter" # <-- CHANGE THIS

# 1. Create the Docker Repository in Artifact Registry
gcloud artifacts repositories create api-rate-limiter \
  --repository-format=docker \
  --location=asia-south1 \
  --description="Docker repository for API Rate Limiter"

# 2. Setup Security and Identity Pool
gcloud iam service-accounts create github-deployer --display-name="GitHub Actions Deployer"
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:${SA_EMAIL}" --role="roles/artifactregistry.writer"
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:${SA_EMAIL}" --role="roles/run.admin"
gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:${SA_EMAIL}" --role="roles/iam.serviceAccountUser"
gcloud iam workload-identity-pools create "github-pool" --location="global" --display-name="GitHub Actions Pool"
export POOL_ID=$(gcloud iam workload-identity-pools describe "github-pool" --location="global" --format="value(name)")
gcloud iam workload-identity-pools providers create-oidc "github-provider" --location="global" --workload-identity-pool="github-pool" --display-name="GitHub provider" --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" --attribute-condition="assertion.repository == '${REPO}'" --issuer-uri="https://token.actions.githubusercontent.com"
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" --role="roles/iam.workloadIdentityUser" --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.repository/${REPO}"

echo "1. GCP_PROJECT_ID: $PROJECT_ID"
echo "2. GCP_WIF_SA: $SA_EMAIL"
echo "3. GCP_WIF_PROVIDER:"
gcloud iam workload-identity-pools providers describe "github-provider" --location="global" --workload-identity-pool="github-pool" --format="value(name)"
```

### Step 2: Add Secrets to GitHub
Go to your GitHub Repository → **Settings** → **Secrets and variables** → **Actions**. Add these 5 secrets:
1. `GCP_PROJECT_ID` (from step 1)
2. `GCP_WIF_SA` (from step 1)
3. `GCP_WIF_PROVIDER` (from step 1)
4. `REDIS_URL` (Create a free Redis database at Upstash.com and paste the URL here)
5. `ADMIN_API_KEY` (Generate any random long password and paste it here)

### Step 3: Deploy
1. Push your code to GitHub (`git push origin main`).
2. Go to the "Actions" tab on GitHub.
3. Watch it run tests and deploy to Cloud Run automatically!
