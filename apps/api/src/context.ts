import type { FastifyBaseLogger } from 'fastify';
import type { Config, Database, QueueName } from '@vs/core';

export interface JobSender {
  send(queue: QueueName, data: object, opts?: { singletonKey?: string; startAfter?: number }): Promise<void>;
}

export interface AppContext {
  config: Config;
  database: Database;
  jobs: JobSender;
  log: FastifyBaseLogger;
}

/** In-memory job sender for tests. */
export function memoryJobs(): JobSender & { sent: { queue: QueueName; data: object }[] } {
  const sent: { queue: QueueName; data: object }[] = [];
  return {
    sent,
    async send(queue, data) {
      sent.push({ queue, data });
    },
  };
}
