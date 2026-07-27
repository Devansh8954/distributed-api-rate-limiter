# How to Run Locally

Want to test the project on your own computer? It's incredibly easy using Docker.

### Prerequisites
You only need to install one thing:
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

### Steps to Run
1. Open your terminal.
2. Navigate to this project folder.
3. Run this command:
```bash
docker compose up --build
```
*(Wait about 30 seconds for it to start up)*

### What just happened?
Docker just spun up two mini-computers inside your machine:
1. One running **Redis** (the database).
2. One running the **Node.js Express Server** (our code).

### Where to go
Open your web browser and go to:
- **Dashboard:** `http://localhost:3000/dashboard`
- **Health Check:** `http://localhost:3000/api/health`
