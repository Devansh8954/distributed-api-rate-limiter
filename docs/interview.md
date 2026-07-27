# Interview Guide

Here are simple answers to common interview questions about this project.

### Q1: What does this project do?
**Answer:** "It is an API Rate Limiter. It protects a backend server from getting crushed by too much traffic. If a single user sends 100 requests in a second, my project blocks them and says 'Too Many Requests', but lets normal users pass through."

### Q2: Why did you use Redis?
**Answer:** "Because I needed to count requests incredibly fast. Standard databases like PostgreSQL are too slow for this. Redis keeps all the counters in RAM (memory), meaning it can check and update a user's request count in less than 1 millisecond."

### Q3: How do you handle race conditions? (Advanced)
**Answer:** "If two requests hit the server at the exact same millisecond, they might both read the same counter value from Redis and both get allowed through, breaking the limit. I fixed this by writing a **Lua Script**. Redis executes Lua scripts 'atomically'—meaning it locks everything else out until the script finishes computing the limit, preventing any race conditions."

### Q4: How is this deployed?
**Answer:** "It is fully automated using GitHub Actions. When I push code to the `main` branch, it runs all my Jest tests. If they pass, it builds a Docker image, pushes it to Google Cloud, and deploys it to Cloud Run."

### Q5: What happens if Redis crashes?
**Answer:** "I built a 'Fail-Open' mechanism. If the Express server loses connection to Redis, it automatically catches the error and lets the API traffic flow through. It's better for the website to stay up un-limited than to completely crash."
