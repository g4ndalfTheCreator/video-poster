import { EventEmitter } from 'node:events';
import type { Sql } from '@vs/core';

/**
 * Shares one LISTEN connection per channel across all SSE clients of this process.
 */
export class PgNotifications {
  private emitter = new EventEmitter();
  private listening = new Map<string, Promise<{ unlisten: () => Promise<void> }>>();
  constructor(private sql: Sql) {
    this.emitter.setMaxListeners(1000);
  }

  subscribe(channel: string, fn: (payload: unknown) => void): () => void {
    if (!this.listening.has(channel)) {
      this.listening.set(
        channel,
        this.sql.listen(channel, (raw) => {
          let payload: unknown = raw;
          try {
            payload = JSON.parse(raw);
          } catch {
            /* keep raw */
          }
          this.emitter.emit(channel, payload);
        }),
      );
    }
    this.emitter.on(channel, fn);
    return () => this.emitter.off(channel, fn);
  }

  async close(): Promise<void> {
    for (const p of this.listening.values()) await (await p).unlisten().catch(() => undefined);
    this.listening.clear();
  }
}
