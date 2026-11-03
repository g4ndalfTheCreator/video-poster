import { generateSlug, RESERVED_SLUGS, type Cta } from '@vs/shared';
import type { Sql } from '@vs/core';

export async function slugAvailable(sql: Sql, slug: string, exceptLinkId?: string): Promise<boolean> {
  if (RESERVED_SLUGS.has(slug.toLowerCase())) return false;
  const a =
    await sql`SELECT 1 FROM share_links WHERE lower(slug) = lower(${slug}) ${exceptLinkId ? sql`AND id <> ${exceptLinkId}` : sql``}`;
  if (a.length) return false;
  const b = await sql`SELECT 1 FROM share_link_redirects WHERE lower(slug) = lower(${slug})`;
  return b.length === 0;
}

export async function uniqueRandomSlug(sql: Sql): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const s = generateSlug();
    if (await slugAvailable(sql, s)) return s;
  }
  throw new Error('could not generate a unique slug');
}

export type LinkState = 'active' | 'closed' | 'expired' | 'exhausted';

export function linkState(l: {
  is_active: boolean;
  expires_at: Date | null;
  max_sessions: number | null;
  session_count: number;
}): LinkState {
  if (!l.is_active) return 'closed';
  if (l.expires_at && l.expires_at.getTime() <= Date.now()) return 'expired';
  if (l.max_sessions !== null && l.session_count >= l.max_sessions) return 'exhausted';
  return 'active';
}

export function effectiveCtas(link: { cta_config: Cta[] | null }, video: { cta_config: Cta[] }): Cta[] {
  return link.cta_config ?? video.cta_config ?? [];
}
