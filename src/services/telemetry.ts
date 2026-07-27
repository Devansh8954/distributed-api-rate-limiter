import { Response } from 'express';

export interface TelemetryEvent {
  id: string;
  timestamp: string;
  ip: string;
  tier: string;
  endpoint: string;
  method: string;
  allowed: boolean;
  statusCode: number;
  strategy: string;
  remaining: number;
  limit: number;
  resetInSeconds: number;
}

export class TelemetryService {
  private static instance: TelemetryService;
  private clients: Set<Response> = new Set();
  private history: TelemetryEvent[] = [];
  private readonly maxHistory = 100;

  private constructor() {}

  public static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService();
    }
    return TelemetryService.instance;
  }

  public addClient(res: Response): void {
    this.clients.add(res);
    // Send initial history
    res.write(`data: ${JSON.stringify({ type: 'history', events: this.history })}\n\n`);
  }

  public removeClient(res: Response): void {
    this.clients.delete(res);
  }

  public broadcast(event: TelemetryEvent): void {
    this.history.unshift(event);
    if (this.history.length > this.maxHistory) {
      this.history.pop();
    }

    const payload = `data: ${JSON.stringify({ type: 'event', event })}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  public getHistory(): TelemetryEvent[] {
    return this.history;
  }
}
