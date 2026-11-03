import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  verifyIngestToken,
  sha256Hex,
  newId,
  LIVE_CHANNEL,
  QUEUES,
  type MatchVisitorJob,
  type NotifyJob,
  type Sql,
} from '@vs/core';
import {
  applyEvents,
  canonicalJson,
  clientEventSchema,
  emptySummary,
  feedbackSchema,
  ingestBatchSchema,
  INGEST_MAX_BYTES,
  stableSubset,
  type ClientEvent,
  type Range,
  type SummaryState,
} from '@vs/shared';
import type { AppContext } from '../../context.js';

const FUTURE_SKEW_MS = 10 * 60_000;
const PAST_SKEW_MS = 24 * 3600_000;
const MAX_SIGNALS_BYTES = 24 * 1024;

interface SummaryRow {
  watch_ms: number;
  unique_watched_ms: number;
  max_position_ms: number;
  completion_pct: number;
  play_count: number;
  seek_count: number;
  rebuffer_count: number;
  rebuffer_ms: number;
  startup_ms: number | null;
  ttff_ms: number | null;
  quality_switches: number;
  ended: boolean;
  quartiles: number[];
  played_ranges: Range[];
  raw_ranges: Range[];
  renditions: Record<string, number>;
  errors: number;
  exit_reason: string | null;
  source: string;
}

function rowToState(r: SummaryRow): SummaryState {
  // A session that so far only has a server-side estimate starts its client summary from scratch.
  if (r.source !== 'client') return emptySummary();
  return {
    watchMs: r.watch_ms,
    uniqueWatchedMs: r.unique_watched_ms,
    maxPositionMs: r.max_position_ms,
    completionPct: r.completion_pct,
    playCount: r.play_count,
    seekCount: r.seek_count,
    rebufferCount: r.rebuffer_count,
    rebufferMs: r.rebuffer_ms,
    startupMs: r.startup_ms,
    ttffMs: r.ttff_ms,
    qualitySwitches: r.quality_switches,
    ended: r.ended,
    quartiles: r.quartiles,
    playedRanges: r.played_ranges,
    rawRanges: r.raw_ranges,
    renditions: r.renditions,
    errors: r.errors,
    exitReason: r.exit_reason,
  };
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: number;
}

/**
 * Validates and stores a batch for one session. Events can only ever be written to the session named
 * in the signed token.
 */
export async function ingestBatch(
  ctx: AppContext,
  raw: unknown,
  req: FastifyRequest,
): Promise<{ status: number; result?: IngestResult }> {
  const sql: Sql = ctx.database.sql;
  const batch = ingestBatchSchema.safeParse(raw);
  if (!batch.success) return { status: 400 };
  const token = verifyIngestToken(ctx.config.INGEST_SIGNING_KEY, batch.data.token);
  if (!token) return { status: 401 };

  const valid: ClientEvent[] = [];
  let rejected = 0;
  for (const e of batch.data.events) {
    const p = clientEventSchema.safeParse(e);
    if (p.success) valid.push(p.data);
    else rejected++;
  }
  const now = Date.now();
  const outcome = await sql.begin(async (tx) => {
    const s = await tx<
      {
        telemetry_level: string;
        link_id: string;
        video_id: string;
        duration_ms: number | null;
        is_bot: boolean;
        first_play_at: Date | null;
      }[]
    >`
      SELECT s.telemetry_level, s.link_id, s.video_id, v.duration_ms, s.is_bot, s.first_play_at
      FROM view_sessions s JOIN videos v ON v.id = s.video_id
      WHERE s.id = ${token.s} AND s.link_id = ${token.l}`;
    const session = s[0];
    if (!session || session.telemetry_level !== 'full') return null;
    const summaryRows = await tx<
      SummaryRow[]
    >`SELECT * FROM session_summaries WHERE session_id = ${token.s} FOR UPDATE`;
    const seqs = valid.map((e) => e.seq);
    const existing = new Set(
      (
        await tx<
          { seq: number }[]
        >`SELECT seq FROM events WHERE session_id = ${token.s} AND seq = ANY(${seqs})`
      ).map((r) => r.seq),
    );
    const seen = new Set<number>();
    const fresh = valid
      .filter((e) => !existing.has(e.seq) && !seen.has(e.seq) && seen.add(e.seq))
      .sort((a, b) => a.seq - b.seq);
    if (!fresh.length)
      return {
        accepted: 0,
        duplicates: valid.length,
        rejected,
        plays: false,
        heartbeat: null as null | number,
      };

    let fingerprintId: string | null = null;
    let visitorId: string | null = null;
    const rows = [];
    for (const e of fresh) {
      let payload = e.payload;
      if (e.type === 'fingerprint') {
        const signals = (payload.signals ?? {}) as Record<string, unknown>;
        if (JSON.stringify(signals).length <= MAX_SIGNALS_BYTES) {
          const randomized = payload.randomized === true;
          const fpHash = sha256Hex(canonicalJson(stableSubset(signals, randomized)));
          const stableHash = sha256Hex(canonicalJson(stableSubset(signals, true)));
          const fp = await tx<{ id: string; visitor_id: string | null }[]>`
            INSERT INTO browser_fingerprints (id, fp_hash, stable_hash, signals, randomized)
            VALUES (${newId()}, ${fpHash}, ${stableHash}, ${tx.json(signals as never)}, ${randomized})
            ON CONFLICT (fp_hash) DO UPDATE SET last_seen_at = now(), seen_count = browser_fingerprints.seen_count + 1,
              signals = EXCLUDED.signals
            RETURNING id, visitor_id`;
          fingerprintId = fp[0]!.id;
          visitorId = fp[0]!.visitor_id;
        }
        // The full signal set lives in browser_fingerprints (180 d); the event keeps only a reference.
        payload = {
          fingerprint_id: fingerprintId,
          randomized: payload.randomized === true,
          elapsed_ms: payload.elapsed_ms,
        };
      }
      const trusted = e.client_ts <= now + FUTURE_SKEW_MS && e.client_ts >= now - PAST_SKEW_MS;
      rows.push({
        session_id: token.s,
        seq: e.seq,
        type: e.type,
        client_ts: new Date(Math.min(Math.max(e.client_ts, 0), 8.64e15)),
        client_ts_trusted: trusted,
        position_ms: e.position_ms === null ? null : Math.round(e.position_ms),
        payload: tx.json(payload as never),
      });
    }
    await tx`INSERT INTO events ${tx(rows as never, 'session_id', 'seq', 'type', 'client_ts', 'client_ts_trusted', 'position_ms', 'payload')}`;

    const prev = summaryRows[0] ? rowToState(summaryRows[0]) : emptySummary();
    const next = applyEvents(prev, fresh, session.duration_ms ?? 0);
    await tx`
      UPDATE session_summaries SET source = 'client', watch_ms = ${next.watchMs}, unique_watched_ms = ${next.uniqueWatchedMs},
        max_position_ms = ${next.maxPositionMs}, completion_pct = ${next.completionPct}, play_count = ${next.playCount},
        seek_count = ${next.seekCount}, rebuffer_count = ${next.rebufferCount}, rebuffer_ms = ${next.rebufferMs},
        startup_ms = ${next.startupMs}, ttff_ms = ${next.ttffMs}, quality_switches = ${next.qualitySwitches}, ended = ${next.ended},
        quartiles = ${next.quartiles}, played_ranges = ${tx.json(next.playedRanges as never)}, raw_ranges = ${tx.json(next.rawRanges as never)},
        renditions = ${tx.json(next.renditions as never)}, errors = ${next.errors}, exit_reason = ${next.exitReason},
        last_seq = greatest(last_seq, ${fresh[fresh.length - 1]!.seq}), updated_at = now()
      WHERE session_id = ${token.s}`;

    const pv = fresh.find((e) => e.type === 'page_view')?.payload as
      { screen?: { w: number; h: number }; tz?: string; webdriver?: boolean } | undefined;
    const headless = pv && (pv.webdriver === true || (pv.screen && (pv.screen.w === 0 || pv.screen.h === 0)));
    const played = fresh.some((e) => e.type === 'play');
    await tx`
      UPDATE view_sessions SET last_seen_at = now(), has_client_telemetry = true, closed_at = NULL,
        screen_w = coalesce(${pv?.screen?.w ?? null}, screen_w), screen_h = coalesce(${pv?.screen?.h ?? null}, screen_h),
        tz = coalesce(${pv?.tz?.slice(0, 64) ?? null}, tz),
        is_bot = is_bot OR ${!!headless}, bot_name = CASE WHEN ${!!headless} THEN 'headless' ELSE bot_name END,
        fingerprint_id = coalesce(${fingerprintId}, fingerprint_id),
        visitor_id = coalesce(${visitorId}, visitor_id),
        visitor_confidence = CASE WHEN ${visitorId !== null} THEN 'exact' ELSE visitor_confidence END,
        first_play_at = CASE WHEN ${played} THEN coalesce(first_play_at, now()) ELSE first_play_at END
      WHERE id = ${token.s}`;
    const docs = fresh.find((e) => e.type === 'story_documents');
    if (docs) {
      await tx`UPDATE session_summaries SET reached_documents = true, documents_via = coalesce(documents_via, ${String(docs.payload.via)})
               WHERE session_id = ${token.s}`;
    }
    const hb = fresh.filter((e) => e.type === 'heartbeat').pop();
    return {
      accepted: fresh.length,
      duplicates: valid.length - fresh.length,
      rejected,
      plays: played && !session.first_play_at && !session.is_bot && !headless,
      heartbeat: hb ? hb.position_ms : null,
      fingerprintId,
      visitorId,
      linkId: session.link_id,
      videoId: session.video_id,
    };
  });
  if (!outcome) return { status: 204 };
  if ('fingerprintId' in outcome && outcome.fingerprintId) {
    await ctx.jobs.send(QUEUES.matchVisitor, {
      sessionId: token.s,
      fingerprintId: outcome.fingerprintId,
    } satisfies MatchVisitorJob);
  }
  if (outcome.plays)
    await ctx.jobs.send(QUEUES.notify, { sessionId: token.s, kind: 'open' } satisfies NotifyJob, {
      singletonKey: `open:${token.s}`,
    });
  if (outcome.heartbeat !== null && 'linkId' in outcome) {
    await sql`SELECT pg_notify(${LIVE_CHANNEL}, ${JSON.stringify({ sessionId: token.s, linkId: outcome.linkId, videoId: outcome.videoId, positionMs: outcome.heartbeat })})`;
  }
  void req;
  return {
    status: 200,
    result: { accepted: outcome.accepted, duplicates: outcome.duplicates, rejected: outcome.rejected },
  };
}

/**
 * Viewer feedback (story mode): one thumbs answer per session, optionally with a comment; a later
 * answer replaces the earlier one. Accepted at every telemetry level because the viewer gives it
 * explicitly; never for sessions that were not stored (blocklist).
 */
export async function saveFeedback(ctx: AppContext, raw: unknown): Promise<number> {
  const sql = ctx.database.sql;
  const body = feedbackSchema.safeParse(raw);
  if (!body.success) return 400;
  const token = verifyIngestToken(ctx.config.INGEST_SIGNING_KEY, body.data.token);
  if (!token) return 401;
  const s = await sql<
    { link_id: string; video_id: string }[]
  >`SELECT link_id, video_id FROM view_sessions WHERE id = ${token.s} AND link_id = ${token.l}`;
  if (!s[0]) return 204;
  const rows = await sql<{ comment: string | null; notified_at: Date | null }[]>`
    INSERT INTO feedback (session_id, link_id, video_id, rating, comment)
    VALUES (${token.s}, ${s[0].link_id}, ${s[0].video_id}, ${body.data.rating}, ${body.data.comment ?? null})
    ON CONFLICT (session_id) DO UPDATE SET rating = EXCLUDED.rating, comment = coalesce(EXCLUDED.comment, feedback.comment), updated_at = now()
    RETURNING comment, notified_at`;
  if (rows[0]?.comment && !rows[0].notified_at) {
    await ctx.jobs.send(QUEUES.notify, { kind: 'feedback', sessionId: token.s } satisfies NotifyJob, {
      singletonKey: `feedback:${token.s}`,
    });
  }
  return 204;
}

export async function ingestRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/t/v1/feedback', { bodyLimit: 8 * 1024 }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return reply.code(await saveFeedback(ctx, req.body)).send();
  });
  const respond = async (req: FastifyRequest, reply: FastifyReply, body: unknown) => {
    reply.header('cache-control', 'no-store');
    const r = await ingestBatch(ctx, body, req);
    if (r.status === 200) {
      (reply as unknown as { vsAccepted?: number }).vsAccepted = r.result!.accepted;
      return reply.code(200).send(r.result);
    }
    return reply.code(r.status).send();
  };
  app.post('/t/v1/events', { bodyLimit: INGEST_MAX_BYTES }, async (req, reply) =>
    respond(req, reply, req.body),
  );
  // sendBeacon posts text/plain (no CORS preflight); the body is the same JSON document.
  app.post('/t/v1/beacon', { bodyLimit: INGEST_MAX_BYTES }, async (req, reply) => {
    let body: unknown = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return reply.code(400).send();
      }
    }
    return respond(req, reply, body);
  });
}
