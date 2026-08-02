import { Response } from 'express';

export interface TelemetryEvent {
  id: string; timestamp: string; ip: string; tier: string;
  endpoint: string; method: string; allowed: boolean; statusCode: number;
  strategy: string; remaining: number; limit: number; resetInSeconds: number;
}

/**
 * TelemetryService — real-time SSE streaming to the dashboard.
 * Singleton: all middleware broadcasts to the same pool of connected clients.
 *
 * How SSE works:
 *  - Dashboard opens GET /api/admin/events (kept alive)
 *  - Server writes "data: {...}\n\n" on each request
 *  - Browser EventSource fires onmessage → charts update live
 * History: last 100 events are sent immediately to each new dashboard tab.
 */
export class TelemetryService {
  private static instance: TelemetryService;
  private clients   = new Set<Response>();
  private history: TelemetryEvent[] = [];
  private readonly maxHistory = 100;

  private constructor() {}

  public static getInstance(): TelemetryService {
    return (TelemetryService.instance ??= new TelemetryService());
  }

  /** Register new SSE client; immediately replay history so charts aren't empty. */
  public addClient(res: Response): void {
    this.clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'history', events: this.history })}\n\n`);
  }

  /** Remove client when the browser tab closes (prevents memory leak). */
  public removeClient(res: Response): void { this.clients.delete(res); }

  /** Push event to every connected tab; also stores in the rolling history buffer. */
  public broadcast(event: TelemetryEvent): void {
    this.history.unshift(event);
    if (this.history.length > this.maxHistory) this.history.pop();

    const payload = `data: ${JSON.stringify({ type: 'event', event })}\n\n`;
    for (const client of this.clients) {
      try { client.write(payload); }
      catch { this.clients.delete(client); } // clean up silently-disconnected tabs
    }
  }

  public getHistory(): TelemetryEvent[] { return this.history; }
}
