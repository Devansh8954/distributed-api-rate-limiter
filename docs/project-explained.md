# Project Explained (For Beginners)

If you are new to backend engineering, here is a simple explanation of what this project actually is and why it exists.

## 1. What is an API Rate Limiter?
Imagine a popular restaurant. If 1,000 people try to enter the front door at the exact same second, the restaurant will collapse. A **Rate Limiter** is like a bouncer at the door. 

If a user tries to send too many requests to an API (like spamming a login button), the rate limiter steps in and says: *"You can only make 10 requests per minute. Try again later."*

## 2. Why do we need Redis?
The "bouncer" (our Node.js server) needs a notepad to keep track of how many times each person has visited.
- We can't use a regular database (like MySQL) because writing to a hard drive is too slow.
- We can't use the server's local memory because if we have 5 different servers running, they won't share the same notepad.

**Redis** is an extremely fast, shared notepad that lives entirely in RAM. All of our servers connect to Redis to ask: *"How many times has user IP 192.168.1.1 visited today?"*

## 3. What are the "Algorithms"?
There are different ways a bouncer can count visits. This project supports four:
1. **Fixed Window:** The simplest. You get 10 visits between 1:00 PM and 1:01 PM. At 1:01 PM, it resets to 0.
2. **Sliding Window:** More accurate. It looks at the exact last 60 seconds from *right now*.
3. **Token Bucket:** Imagine a bucket of 10 tokens. Every time you visit, you take a token. The bucket refills by 1 token every few seconds. This allows for quick "bursts" of traffic.
4. **Sliding Window Counter (Lua):** The most advanced approach (used by companies like Stripe). It is fast like Fixed Window, but accurate like Sliding Window, and uses a Lua Script to prevent glitches.

## 4. What is the Dashboard?
This project comes with a visual dashboard. You can open it in your browser and literally watch the traffic get blocked in real-time as you spam the "Simulate Traffic" button.
