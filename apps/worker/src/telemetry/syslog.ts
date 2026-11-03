import dgram from 'node:dgram';
import type { Logger } from 'pino';
import { PREVIEW_SESSION, type Sql } from '@vs/core';
import { parseSegmentFile } from '@vs/shared';
import { recomputeServerEstimate } from './sessions.js';

export interface MediaLogLine {
  ts: string;
  sess: string;
  vid: string;
  ver: string;
  file: string;
  status: number;
  bytes: number;
  rt: number;
  proto?: string;
  tls?: string;
  ip?: string;
  ua?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parses one syslog datagram from nginx (`<pri>… vsmedia: {json}`). */
export function parseSyslogLine(msg: string): MediaLogLine | null {
  const i = msg.indexOf('{');
  if (i < 0) return null;
  try {
    const j = JSON.parse(msg.slice(i)) as MediaLogLine;
    if (!UUID.test(j.sess) || !UUID.test(j.vid) || j.sess === PREVIEW_SESSION) return null;
    return j;
  } catch {
    return null;
  }
}

/** Stores parsed media log lines and refreshes the server-side estimates of the touched sessions. */
export async function storeMediaLines(sql: Sql, lines: MediaLogLine[]): Promise<number> {
  if (!lines.length) return 0;
  const rows = lines.map((l) => {
    const seg = parseSegmentFile(l.file);
    return {
      session_id: l.sess,
      ts: new Date(l.ts),
      rendition: seg?.rendition ?? (/^(\d+)p/.exec(l.file) ? Number(/^(\d+)p/.exec(l.file)![1]) : null),
      segment_index: seg?.index ?? null,
      file: l.file.slice(0, 64),
      status: Number(l.status) || 0,
      bytes: Number(l.bytes) || 0,
      request_time_ms: Math.round((Number(l.rt) || 0) * 1000),
      http_version: (l.proto ?? '').slice(0, 16) || null,
      tls_version: (l.tls ?? '').slice(0, 16) || null,
    };
  });
  const sessions = [...new Set(rows.map((r) => r.session_id))];
  const existing = new Set(
    (await sql<{ id: string }[]>`SELECT id FROM view_sessions WHERE id = ANY(${sessions})`).map((r) => r.id),
  );
  const valid = rows.filter((r) => existing.has(r.session_id));
  if (!valid.length) return 0;
  await sql`INSERT INTO segment_fetches ${sql(valid as never, 'session_id', 'ts', 'rendition', 'segment_index', 'file', 'status', 'bytes', 'request_time_ms', 'http_version', 'tls_version')}`;
  for (const id of new Set(valid.map((r) => r.session_id))) await recomputeServerEstimate(sql, id);
  return valid.length;
}

/** UDP syslog receiver for the nginx media access log; flushes in batches every 2 s. */
export function startSyslogReceiver(sql: Sql, port: number, log: Logger): { close(): void } {
  const sock = dgram.createSocket('udp4');
  let buffer: MediaLogLine[] = [];
  sock.on('message', (msg) => {
    const line = parseSyslogLine(msg.toString('utf8'));
    if (line) buffer.push(line);
    if (buffer.length > 5000) buffer = buffer.slice(-5000);
  });
  sock.on('error', (err) => log.error({ err }, 'syslog socket error'));
  sock.bind(port, '0.0.0.0', () => log.info({ port }, 'media log receiver listening'));
  let running = false;
  const timer = setInterval(() => {
    if (running || !buffer.length) return;
    running = true;
    const batch = buffer;
    buffer = [];
    storeMediaLines(sql, batch)
      .catch((err) => log.error({ err }, 'storing media log failed'))
      .finally(() => (running = false));
  }, 2000);
  return {
    close() {
      clearInterval(timer);
      sock.close();
    },
  };
}
