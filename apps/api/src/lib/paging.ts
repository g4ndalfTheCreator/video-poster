import type { PageQuery } from '@vs/shared';

/** Whitelisted ORDER BY column for a page query. */
export function orderBy(
  q: PageQuery,
  allowed: Record<string, string>,
  fallback: string,
): { col: string; dir: 'ASC' | 'DESC' } {
  const col = (q.sort && allowed[q.sort]) || allowed[fallback] || fallback;
  return { col, dir: q.dir === 'asc' ? 'ASC' : 'DESC' };
}

export function offset(q: PageQuery): number {
  return (q.page - 1) * q.pageSize;
}
