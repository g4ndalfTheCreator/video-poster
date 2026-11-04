import { z } from 'zod';
import { CUSTOM_SLUG_RE } from './slug.js';
import { ROLES, TELEMETRY_LEVELS, NOTIFICATION_KINDS, VIDEO_STATUSES } from './constants.js';

export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof errorSchema>;

export const uuid = z.string().uuid();
export const idParams = z.object({ id: uuid });

// ---------- auth ----------
export const bootstrapSchema = z.object({
  token: z.string().min(16).max(128),
  email: z.string().email().max(254),
  password: z.string().min(12).max(256),
});
export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});
export const totpSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
/** Re-authentication before sensitive actions; `code` is required when TOTP is enabled. */
export const reauthSchema = z.object({
  password: z.string().min(1).max(256),
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export const totpEnrollConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const meSchema = z.object({
  id: uuid,
  email: z.string(),
  role: z.enum(ROLES),
  totpEnabled: z.boolean(),
  totpRequired: z.boolean(),
});
export type Me = z.infer<typeof meSchema>;

// ---------- pagination ----------
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().max(200).optional(),
});
export type PageQuery = z.infer<typeof pageQuery>;
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------- videos ----------
export const chapterSchema = z.object({ atMs: z.number().int().min(0), title: z.string().min(1).max(80) });
export const chaptersSchema = z
  .array(chapterSchema)
  .max(20)
  .transform((c) => [...c].sort((a, b) => a.atMs - b.atMs));
export type Chapter = z.infer<typeof chapterSchema>;

export const FEEDBACK_RATINGS = ['up', 'meh', 'down'] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];
export const feedbackSchema = z.object({
  token: z.string().min(10).max(512),
  rating: z.enum(FEEDBACK_RATINGS),
  comment: z
    .string()
    .max(2000)
    .transform((s) => s.trim() || undefined)
    .optional(),
});

export const videoPatchSchema = z.object({
  storyMode: z.boolean().optional(),
  chapters: chaptersSchema.optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  autoplayMuted: z.boolean().optional(),
  loudnorm: z.boolean().optional(),
  ctaConfig: z.lazy(() => ctaConfigSchema).optional(),
  status: z.enum(['ready', 'archived']).optional(),
});
export const videoListQuery = pageQuery.extend({ status: z.enum(VIDEO_STATUSES).optional() });
export const posterSchema = z.object({ atMs: z.number().int().min(0) });

// ---------- links ----------
export const ctaSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/i),
  label: z.string().min(1).max(60),
  href: z
    .string()
    .url()
    .max(2000)
    .refine((u) => /^(https?:|mailto:|tel:)/i.test(u), 'only http(s), mailto and tel links'),
});
export const ctaConfigSchema = z.array(ctaSchema).max(3);
export type Cta = z.infer<typeof ctaSchema>;

const slugField = z.string().regex(CUSTOM_SLUG_RE, 'invalid slug');

export const linkCreateSchema = z.object({
  label: z.string().min(1).max(200),
  recipientName: z.string().max(200).optional(),
  recipientOrg: z.string().max(200).optional(),
  note: z.string().max(2000).optional(),
  slug: slugField.optional(),
  password: z.string().min(4).max(256).optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  maxSessions: z.number().int().min(1).max(1_000_000).nullable().optional(),
  isActive: z.boolean().default(true),
  allowDownload: z.boolean().default(false),
  allowEmbed: z.boolean().default(false),
  notifyOnOpen: z.boolean().default(true),
  notifyEveryOpen: z.boolean().default(false),
  ctaConfig: ctaConfigSchema.nullable().optional(),
  /** null = follow the video's story-mode setting */
  storyMode: z.boolean().nullable().optional(),
});
export type LinkCreate = z.input<typeof linkCreateSchema>;

export const linkPatchSchema = linkCreateSchema.partial().extend({
  password: z.string().min(4).max(256).nullable().optional(),
  keepOldSlugRedirect: z.boolean().optional(),
});

export const linkBulkSchema = z.object({ csv: z.string().min(1).max(500_000) });

// ---------- settings ----------
export const settingsSchema = z.object({
  branding: z
    .object({
      name: z.string().max(100).default('Video'),
      primaryColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default('#2563eb'),
      footer: z.string().max(500).default(''),
    })
    .default({ name: 'Video', primaryColor: '#2563eb', footer: '' }),
  privacy: z
    .object({ fi: z.string().max(20000).default(''), en: z.string().max(20000).default('') })
    .default({ fi: '', en: '' }),
  telemetry: z.object({ level: z.enum(TELEMETRY_LEVELS).default('full') }).default({ level: 'full' }),
  ipIntel: z
    .object({ rdapEnabled: z.boolean().default(true), ptrEnabled: z.boolean().default(true) })
    .default({ rdapEnabled: true, ptrEnabled: true }),
  serverTelemetry: z.object({ ja4: z.boolean().default(false) }).default({ ja4: false }),
  retention: z
    .object({
      eventsDays: z.number().int().min(1).max(3650).default(90),
      fingerprintSignalsDays: z.number().int().min(1).max(3650).default(180),
      serverData: z.union([z.literal('forever'), z.number().int().min(30).max(36500)]).default('forever'),
      archiveAfterMonths: z.number().int().min(1).max(120).default(12),
    })
    .default({ eventsDays: 90, fingerprintSignalsDays: 180, serverData: 'forever', archiveAfterMonths: 12 }),
  ui: z
    .object({
      locale: z.enum(['fi', 'en']).default('fi'),
      timezone: z.string().max(64).default('Europe/Helsinki'),
    })
    .default({ locale: 'fi', timezone: 'Europe/Helsinki' }),
  blocklist: z.array(z.string().max(64)).max(1000).default([]),
  notifications: z.object({ sessionSummary: z.boolean().default(false) }).default({ sessionSummary: false }),
});
export type Settings = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = settingsSchema.partial();

// ---------- users, channels, tokens ----------
export const userCreateSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(256),
  role: z.enum(ROLES),
});
export const userPatchSchema = z.object({
  role: z.enum(ROLES).optional(),
  password: z.string().min(12).max(256).optional(),
  disabled: z.boolean().optional(),
});

export const ntfyConfigSchema = z.object({
  url: z.string().url(),
  topic: z.string().min(1).max(128),
  token: z.string().max(512).optional(),
});
export const emailConfigSchema = z.object({ to: z.string().email() });
export const webhookConfigSchema = z.object({
  url: z.string().url(),
  secret: z.string().max(256).optional(),
});
export const channelCreateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ntfy'), config: ntfyConfigSchema, isActive: z.boolean().default(true) }),
  z.object({ kind: z.literal('email'), config: emailConfigSchema, isActive: z.boolean().default(true) }),
  z.object({ kind: z.literal('webhook'), config: webhookConfigSchema, isActive: z.boolean().default(true) }),
]);
export const channelKinds = NOTIFICATION_KINDS;

export const apiTokenCreateSchema = z.object({ name: z.string().min(1).max(100) });

// ---------- analytics ----------
export const rangeQuery = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
export const sessionFilterQuery = pageQuery.extend({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  videoId: uuid.optional(),
  linkId: uuid.optional(),
  visitorId: uuid.optional(),
  country: z.string().length(2).optional(),
  device: z.string().max(20).optional(),
  ip: z.string().max(64).optional(),
  hideBots: z.coerce.boolean().default(true),
});

export const visitorPatchSchema = z.object({ label: z.string().max(200).nullable().optional() });
export const visitorMergeSchema = z.object({ intoId: uuid });
export const ipOverrideSchema = z.object({
  cidr: z.string().max(64),
  orgLabel: z.string().min(1).max(200),
  note: z.string().max(1000).optional(),
});
