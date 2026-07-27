import { Response } from 'express';

/**
 * Shape of a single telemetry event — emitted for every request passing through the gateway.
 * Each field is sent to the dashboard in real-time via SSE.
 */
export interface TelemetryEvent {
  id:             string;  // Unique request ID (UUID)
  timestamp:      string;  // Human-readable time (HH:MM:SS)
  ip:             string;  // Client IP address
  tier:           string;  // Client tier (e.g. "Free Tier")
  endpoint:       string;  // Request path (e.g. "/api/v1/data")
  method:         string;  // HTTP method
  allowed:        boolean; // true = 200 OK, false = 429 Too Many Requests
  statusCode:     number;  // 200 or 429
  strategy:       string;  // Active algorithm name
  remaining:      number;  // Requests remaining in current window
  limit:          number;  // Total limit for this tier/window
  resetInSeconds: number;  // Seconds until the window resets
}

/**
 * TelemetryService — Real-time event streaming to the dashboard.
 *
 * Uses the Singleton pattern (one instance shared across the entire app)
 * because all parts of the codebase need to broadcast to the same pool of SSE clients.
 *
 * ─── How SSE works ──────────────────────────────────────────────────────────
 * Server-Sent Events (SSE) is a native browser API that keeps an HTTP connection
 * open and lets the server push data to the browser at any time — no WebSocket needed.
 *
 * Dashboard opens:   GET /api/admin/events
 * Server responds:   Content-Type: text/event-stream (connection stays open)
 * On each request:   this.broadcast(event) → writes "data: {...}\n\n" to each client
 * Browser receives:  EventSource fires onmessage → chart updates in real time
 *
 * ─── Request History ────────────────────────────────────────────────────────
 * The last 100 events are stored in memory. When a new dashboard client connects,
 * it immediately receives the full history so the charts aren't empty.
 */
export class TelemetryService {
  private static instance: TelemetryService;

  // Active SSE client response objects — one per open browser tab
  private clients: Set<Response> = new Set();

  // In-memory ring buffer of recent events (newest first)
  private history: TelemetryEvent[] = [];
  private readonly maxHistory = 100;

  // Private constructor enforces Singleton — use TelemetryService.getInstance()
  private constructor() {}

  public static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService();
    }
    return TelemetryService.instance;
  }

  /**
   * Registers a new SSE client (browser tab opening the dashboard).
   * Immediately sends the last 100 events so the dashboard isn't empty on load.
   */
  public addClient(res: Response): void {
    this.clients.add(res);
    // Send full history to the newly connected client
    res.write(`data: ${JSON.stringify({ type: 'history', events: this.history })}\n\n`);
  }

  /**
   * Removes a client when the browser tab closes or the connection drops.
   * Without this, the Set would grow forever (memory leak).
   */
  public removeClient(res: Response): void {
    this.clients.delete(res);
  }

  /**
   * Broadcasts a new telemetry event to every connected dashboard client.
   * Called by the rate limiter middleware on every request (allowed and blocked).
   */
  public broadcast(event: TelemetryEvent): void {
    // Prepend to history (newest first) and trim to maxHistory
    this.history.unshift(event);
    if (this.history.length > this.maxHistory) {
      this.history.pop();
    }

    const payload = `data: ${JSON.stringify({ type: 'event', event })}\n\n`;

    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        // If write fails (client disconnected without clean close), remove it
        this.clients.delete(client);
      }
    }
  }

  /** Returns the stored event history (used by the admin endpoint). */
  public getHistory(): TelemetryEvent[] {
    return this.history;
  }
}
