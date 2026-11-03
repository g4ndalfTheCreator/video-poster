/** Helpers for typed URL search params (shareable list views). */
export interface ListSearch {
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  q?: string;
}

export function listSearch(s: Record<string, unknown>): ListSearch {
  const page = Number(s.page);
  const pageSize = Number(s.pageSize);
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 200 ? pageSize : undefined,
    sort: typeof s.sort === 'string' ? s.sort : undefined,
    dir: s.dir === 'asc' || s.dir === 'desc' ? s.dir : undefined,
    q: typeof s.q === 'string' && s.q ? s.q : undefined,
  };
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function toggleSort<T extends ListSearch>(s: T, field: string): T {
  if (s.sort === field) return { ...s, dir: s.dir === 'asc' ? 'desc' : 'asc', page: 1 };
  return { ...s, sort: field, dir: 'desc', page: 1 };
}
