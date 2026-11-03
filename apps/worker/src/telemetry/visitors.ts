import { newId, type Sql } from '@vs/core';
import { signalSimilarity, RANDOMIZABLE_SIGNALS, VOLATILE_SIGNALS } from '@vs/shared';

const FUZZY_THRESHOLD = 0.9;
const FUZZY_DAYS = 30;

/**
 * Links a session to a returning viewer based on its browser profile:
 * exact fp_hash → same visitor; randomised profile → stable hash; otherwise weighted similarity ≥ 0.9
 * with a profile seen in the last 30 days from the same ASN or /24 → "probable".
 */
export async function matchVisitor(
  sql: Sql,
  sessionId: string,
  fingerprintId: string,
): Promise<{ visitorId: string; confidence: 'exact' | 'probable' } | null> {
  return sql.begin(async (tx) => {
    const fp = await tx<
      {
        id: string;
        visitor_id: string | null;
        stable_hash: string;
        signals: Record<string, unknown> | null;
        randomized: boolean;
      }[]
    >`
      SELECT id, visitor_id, stable_hash, signals, randomized FROM browser_fingerprints WHERE id = ${fingerprintId} FOR UPDATE`;
    const f = fp[0];
    const sess = await tx<
      { asn: number | null; ip_trunc: string | null; link_id: string; visitor_id: string | null }[]
    >`
      SELECT asn, ip_trunc::text AS ip_trunc, link_id, visitor_id FROM view_sessions WHERE id = ${sessionId}`;
    const s = sess[0];
    if (!f || !s) return null;

    let visitorId = f.visitor_id;
    let confidence: 'exact' | 'probable' = 'exact';
    if (!visitorId) {
      const stable = await tx<{ visitor_id: string }[]>`
        SELECT visitor_id FROM browser_fingerprints WHERE stable_hash = ${f.stable_hash} AND visitor_id IS NOT NULL AND id <> ${f.id}
        ORDER BY last_seen_at DESC LIMIT 1`;
      if (stable[0]) {
        visitorId = stable[0].visitor_id;
        confidence = f.randomized ? 'probable' : 'exact';
      }
    }
    if (!visitorId && f.signals) {
      const candidates = await tx<{ visitor_id: string; signals: Record<string, unknown> }[]>`
        SELECT DISTINCT ON (bf.id) bf.visitor_id, bf.signals FROM browser_fingerprints bf
        JOIN view_sessions vs ON vs.fingerprint_id = bf.id
        WHERE bf.visitor_id IS NOT NULL AND bf.id <> ${f.id} AND bf.signals IS NOT NULL
          AND bf.last_seen_at > now() - make_interval(days => ${FUZZY_DAYS})
          AND ((${s.asn}::int IS NOT NULL AND vs.asn = ${s.asn}) OR (${s.ip_trunc}::inet IS NOT NULL AND vs.ip_trunc = ${s.ip_trunc}::inet))
        LIMIT 200`;
      const ignore = f.randomized
        ? new Set([...VOLATILE_SIGNALS, ...RANDOMIZABLE_SIGNALS])
        : VOLATILE_SIGNALS;
      let best: { id: string; score: number } | null = null;
      for (const c of candidates) {
        const score = signalSimilarity(f.signals, c.signals, ignore);
        if (score >= FUZZY_THRESHOLD && (!best || score > best.score)) best = { id: c.visitor_id, score };
      }
      if (best) {
        visitorId = best.id;
        confidence = 'probable';
      }
    }
    if (!visitorId) {
      visitorId = newId();
      await tx`INSERT INTO visitors (id) VALUES (${visitorId})`;
    }
    // Follow merges.
    const merged = await tx<{ id: string }[]>`
      WITH RECURSIVE m AS (SELECT id, merged_into FROM visitors WHERE id = ${visitorId}
        UNION ALL SELECT v.id, v.merged_into FROM visitors v JOIN m ON v.id = m.merged_into)
      SELECT id FROM m WHERE merged_into IS NULL LIMIT 1`;
    visitorId = merged[0]?.id ?? visitorId;
    if (!f.visitor_id && confidence === 'exact')
      await tx`UPDATE browser_fingerprints SET visitor_id = ${visitorId} WHERE id = ${f.id}`;
    if (!f.visitor_id && confidence === 'probable')
      await tx`UPDATE browser_fingerprints SET visitor_id = ${visitorId} WHERE id = ${f.id}`;
    await tx`UPDATE view_sessions SET visitor_id = ${visitorId}, visitor_confidence = ${confidence} WHERE id = ${sessionId}`;
    await refreshVisitorCounts(tx as unknown as Sql, visitorId);
    return { visitorId, confidence };
  });
}

export async function refreshVisitorCounts(sql: Sql, visitorId: string): Promise<void> {
  await sql`
    UPDATE visitors v SET
      session_count = x.sessions, link_count = x.links,
      first_seen_at = least(v.first_seen_at, x.first), last_seen_at = greatest(v.last_seen_at, x.last)
    FROM (SELECT count(*)::int AS sessions, count(DISTINCT link_id)::int AS links, min(started_at) AS first, max(last_seen_at) AS last
          FROM view_sessions WHERE visitor_id = ${visitorId}) x
    WHERE v.id = ${visitorId}`;
}
