import type { Sql } from './db.js';
import { newId } from './ids.js';

export interface AuditEntry {
  actorUserId?: string | null;
  actorLabel?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  diff?: unknown;
  ip?: string | null;
}

export async function audit(sql: Sql, e: AuditEntry): Promise<void> {
  await sql`
    INSERT INTO audit_log (id, actor_user_id, actor_label, action, entity, entity_id, diff, ip)
    VALUES (${newId()}, ${e.actorUserId ?? null}, ${e.actorLabel ?? null}, ${e.action}, ${e.entity ?? null},
            ${e.entityId ?? null}, ${e.diff === undefined ? null : sql.json(e.diff as never)}, ${e.ip ?? null})`;
}

/** Shallow diff of changed keys, with secrets masked. */
export function diffObjects(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const secret = /password|secret|token|hash/i;
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      out[k] = secret.test(k)
        ? { from: '***', to: '***' }
        : { from: before[k] ?? null, to: after[k] ?? null };
    }
  }
  return out;
}
