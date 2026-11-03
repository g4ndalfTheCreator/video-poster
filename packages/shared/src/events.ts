import { z } from 'zod';
import { INGEST_MAX_EVENTS } from './constants.js';

/** String that is truncated instead of rejected. */
const tstr = (max: number) => z.string().transform((s) => s.slice(0, max));
const ms = z
  .number()
  .finite()
  .min(0)
  .max(24 * 3600 * 1000);
const rangeTuple = z.tuple([ms, ms]);

export const EVENT_TYPES = [
  'page_view',
  'fingerprint',
  'player_ready',
  'play',
  'pause',
  'first_frame',
  'heartbeat',
  'seek',
  'quartile',
  'ended',
  'rebuffer_start',
  'rebuffer_end',
  'quality_change',
  'captions_toggle',
  'fullscreen',
  'pip',
  'volume_change',
  'visibility',
  'cta_click',
  'attachment_download',
  'video_download',
  'error',
  'session_end',
  'story_documents',
  'story_feedback_shown',
  'chapter',
] as const;
export type ClientEventType = (typeof EVENT_TYPES)[number];

/** Events produced by the server itself (never accepted from clients). */
export const SERVER_EVENT_TYPES = [
  'password_ok',
  'password_fail',
  'link_expired_hit',
  'preview_fetch',
  'session_timeout',
] as const;

export const payloadSchemas = {
  page_view: z.object({
    viewport: z
      .object({ w: z.number().int().min(0).max(20000), h: z.number().int().min(0).max(20000) })
      .optional(),
    screen: z
      .object({ w: z.number().int().min(0).max(20000), h: z.number().int().min(0).max(20000) })
      .optional(),
    dpr: z.number().min(0).max(10).optional(),
    lang: tstr(35).optional(),
    tz: tstr(64).optional(),
    effectiveType: tstr(16).optional(),
    referrer: tstr(512).optional(),
    utm: z.record(tstr(32), tstr(200)).optional(),
    webdriver: z.boolean().optional(),
  }),
  fingerprint: z.object({
    signals: z.record(z.string().max(64), z.unknown()),
    randomized: z.boolean().optional(),
    elapsed_ms: z.number().min(0).max(60_000).optional(),
  }),
  player_ready: z.object({
    startup_ms: ms.optional(),
    renditions: z.array(z.number().int()).max(16).optional(),
  }),
  play: z.object({ source: z.enum(['user', 'autoplay', 'system']).optional() }),
  pause: z.object({ source: z.enum(['user', 'autoplay', 'system']).optional() }),
  first_frame: z.object({ ttff_ms: ms.optional() }),
  heartbeat: z.object({
    played_delta: z.array(rangeTuple).max(200).default([]),
    rendition: z.number().int().min(0).max(10000).optional(),
    bandwidth_kbps: z.number().min(0).max(10_000_000).optional(),
    buffer_ms: ms.optional(),
    volume: z.number().min(0).max(1).optional(),
    muted: z.boolean().optional(),
    rate: z.number().min(0).max(16).optional(),
  }),
  seek: z.object({ from_ms: ms, to_ms: ms }),
  quartile: z.object({ q: z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]) }),
  ended: z.object({ replay_count: z.number().int().min(0).max(1000).optional() }),
  rebuffer_start: z.object({}),
  rebuffer_end: z.object({ duration_ms: ms.optional() }),
  quality_change: z.object({
    from: z.number().int().optional(),
    to: z.number().int().optional(),
    auto: z.boolean().optional(),
  }),
  captions_toggle: z.object({ lang: tstr(16).nullable().optional() }),
  fullscreen: z.object({ enabled: z.boolean() }),
  pip: z.object({ enabled: z.boolean() }),
  volume_change: z.object({ volume: z.number().min(0).max(1), muted: z.boolean() }),
  visibility: z.object({ state: z.enum(['visible', 'hidden']) }),
  cta_click: z.object({ cta_id: tstr(64), href_host: tstr(255).optional() }),
  attachment_download: z.object({ asset_id: tstr(64) }),
  video_download: z.object({}),
  error: z.object({
    code: tstr(64).optional(),
    fatal: z.boolean().optional(),
    message: tstr(200).optional(),
  }),
  session_end: z.object({ exit_reason: z.enum(['closed', 'navigated', 'idle']).optional() }),
  story_documents: z.object({ via: z.enum(['swipe', 'ended', 'button']) }),
  story_feedback_shown: z.object({}),
  chapter: z.object({ index: z.number().int().min(0).max(50) }),
} satisfies Record<ClientEventType, z.ZodType>;

const baseEvent = z.object({
  seq: z.number().int().min(0).max(1_000_000),
  type: z.enum(EVENT_TYPES),
  client_ts: z.number().int().min(0),
  position_ms: ms.nullable().optional(),
  payload: z.unknown().optional(),
});

/** A validated client event with a type-specific payload. Unknown keys are dropped. */
export const clientEventSchema = baseEvent.transform((e, ctx) => {
  const schema = payloadSchemas[e.type];
  const parsed = schema.safeParse(e.payload ?? {});
  if (!parsed.success) {
    ctx.addIssue({ code: 'custom', message: `invalid payload for ${e.type}` });
    return z.NEVER;
  }
  return { ...e, position_ms: e.position_ms ?? null, payload: parsed.data as Record<string, unknown> };
});
export type ClientEvent = z.output<typeof clientEventSchema>;

export const ingestBatchSchema = z.object({
  token: z.string().min(10).max(512),
  events: z.array(z.unknown()).min(1).max(INGEST_MAX_EVENTS),
});
export type IngestBatch = z.infer<typeof ingestBatchSchema>;

export type HeartbeatPayload = z.output<(typeof payloadSchemas)['heartbeat']>;
