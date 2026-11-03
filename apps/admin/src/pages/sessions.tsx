import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { Page } from '@vs/shared';
import { get, qs } from '../lib/api';
import { can, useMe } from '../lib/auth';
import { fmtDateTime, fmtPct } from '../lib/format';
import { toggleSort } from '../lib/search';
import { Badge, Card, Empty, Input, Pager, SortHeader, Table } from '../components/ui';
import { PageHeader } from '../components/layout';
import { FilterBar } from '../components/filters';
import { NetworkCell, type SessionRow } from './link-extras';

type Row = SessionRow & {
  linkId: string;
  linkLabel: string;
  recipientName: string | null;
  videoTitle: string;
  live: boolean;
};

export function SessionsPage() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const search = useSearch({ from: '/sessions' });
  const navigate = useNavigate({ from: '/sessions' });
  const set = (v: Partial<typeof search>) =>
    void navigate({ search: { ...search, ...v, page: v.page ?? 1 } });
  const q = useQuery({
    queryKey: ['sessions', search],
    queryFn: () => get<Page<Row>>(`/analytics/sessions${qs({ pageSize: 50, ...search })}`),
  });
  return (
    <>
      <PageHeader title={t('sess.title')} />
      <FilterBar value={search} onChange={(v) => set(v)} />
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <Input
            placeholder={t('app.search')}
            defaultValue={search.q ?? ''}
            className="max-w-xs"
            onChange={(e) => set({ q: e.target.value || undefined })}
          />
          <Input
            placeholder={t('sess.country')}
            defaultValue={search.country ?? ''}
            className="w-28"
            maxLength={2}
            onChange={(e) => set({ country: e.target.value || undefined })}
          />
          {can(me, 'editor') && (
            <Input
              placeholder={t('sess.ip')}
              defaultValue={search.ip ?? ''}
              className="w-56"
              onChange={(e) => set({ ip: e.target.value || undefined })}
            />
          )}
        </div>
        {q.data?.items.length === 0 ? (
          <Empty>{t('an.noData')}</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <SortHeader
                  label={t('sess.time')}
                  field="startedAt"
                  sort={search.sort}
                  dir={search.dir}
                  onSort={(f) => set(toggleSort(search, f))}
                />
                <SortHeader
                  label={t('sess.link')}
                  field="link"
                  sort={search.sort}
                  dir={search.dir}
                  onSort={(f) => set(toggleSort(search, f))}
                />
                <SortHeader
                  label={t('sess.location')}
                  field="country"
                  sort={search.sort}
                  dir={search.dir}
                  onSort={(f) => set(toggleSort(search, f))}
                />
                <th>{t('sess.device')}</th>
                <th>{t('sess.network')}</th>
                <SortHeader
                  label={t('sess.watched')}
                  field="completion"
                  sort={search.sort}
                  dir={search.dir}
                  onSort={(f) => set(toggleSort(search, f))}
                />
                <th>{t('sess.visitor')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.items.map((s) => (
                <tr key={s.id} className={s.isBot ? 'opacity-50' : ''}>
                  <td className="whitespace-nowrap">
                    <Link to="/sessions/$id" params={{ id: s.id }} className="hover:underline">
                      {fmtDateTime(s.startedAt)}
                    </Link>{' '}
                    {s.live && <Badge tone="ok">{t('sess.live')}</Badge>}
                    {s.isBot && <Badge tone="warn">bot</Badge>}
                  </td>
                  <td>
                    <Link to="/links/$id" params={{ id: s.linkId }} className="hover:underline">
                      {s.linkLabel}
                    </Link>
                    <div className="text-xs text-muted-fg">{s.videoTitle}</div>
                  </td>
                  <td>{[s.city, s.country].filter(Boolean).join(', ') || '–'}</td>
                  <td>
                    {s.device}
                    <div className="text-xs text-muted-fg">{s.browser}</div>
                  </td>
                  <td>
                    <NetworkCell s={s} />
                  </td>
                  <td className="tabular-nums">{fmtPct(s.completionPct)}</td>
                  <td className="text-xs">
                    {s.visitorId && (
                      <Link to="/visitors/$id" params={{ id: s.visitorId }} className="hover:underline">
                        {s.visitorLabel ?? s.visitorId.slice(0, 8)}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {q.data && (
          <Pager
            page={search.page ?? 1}
            pageSize={q.data.pageSize}
            total={q.data.total}
            onPage={(p) => set({ page: p })}
            labels={{ prev: t('app.prev'), next: t('app.next'), of: t('app.of') }}
          />
        )}
      </Card>
    </>
  );
}
