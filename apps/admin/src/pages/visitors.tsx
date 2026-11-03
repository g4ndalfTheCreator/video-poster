import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { Page } from '@vs/shared';
import { get, patch, post, qs } from '../lib/api';
import { can, useMe } from '../lib/auth';
import { fmtDateTime, fmtNum, fmtPct } from '../lib/format';
import { toggleSort } from '../lib/search';
import { Button, Card, ErrorText, Input, Pager, SortHeader, Table } from '../components/ui';
import { PageHeader } from '../components/layout';

export function VisitorsPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: '/visitors' });
  const navigate = useNavigate({ from: '/visitors' });
  const set = (v: Partial<typeof search>) => void navigate({ search: { ...search, ...v } });
  const q = useQuery({
    queryKey: ['visitors', search],
    queryFn: () =>
      get<
        Page<{
          id: string;
          label: string | null;
          firstSeenAt: string;
          lastSeenAt: string;
          sessions: number;
          links: number;
          linkLabels: string | null;
          org: string | null;
        }>
      >(`/visitors${qs({ pageSize: 50, ...search })}`),
  });
  return (
    <>
      <PageHeader title={t('vis.title')} />
      <Card>
        <Input
          placeholder={t('app.search')}
          defaultValue={search.q ?? ''}
          className="mb-3 max-w-xs"
          onChange={(e) => set({ q: e.target.value || undefined, page: 1 })}
        />
        <Table>
          <thead>
            <tr>
              <SortHeader
                label={t('vis.label')}
                field="label"
                sort={search.sort}
                dir={search.dir}
                onSort={(f) => set(toggleSort(search, f))}
              />
              <th>{t('sess.network')}</th>
              <SortHeader
                label={t('dash.sessions')}
                field="sessions"
                sort={search.sort}
                dir={search.dir}
                onSort={(f) => set(toggleSort(search, f))}
              />
              <SortHeader
                label={t('vis.links')}
                field="links"
                sort={search.sort}
                dir={search.dir}
                onSort={(f) => set(toggleSort(search, f))}
              />
              <SortHeader
                label={t('vis.lastSeen')}
                field="lastSeen"
                sort={search.sort}
                dir={search.dir}
                onSort={(f) => set(toggleSort(search, f))}
              />
            </tr>
          </thead>
          <tbody>
            {q.data?.items.map((v) => (
              <tr key={v.id}>
                <td>
                  <Link to="/visitors/$id" params={{ id: v.id }} className="hover:underline">
                    {v.label ?? v.id.slice(0, 8)}
                  </Link>
                  <div className="max-w-sm truncate text-xs text-muted-fg">{v.linkLabels}</div>
                </td>
                <td className="text-sm">{v.org}</td>
                <td className="tabular-nums">{fmtNum(v.sessions)}</td>
                <td className="tabular-nums">{fmtNum(v.links)}</td>
                <td className="whitespace-nowrap">{fmtDateTime(v.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
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

export function VisitorDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams({ from: '/visitors/$id' });
  const { data: me } = useMe();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['visitor', id],
    queryFn: () =>
      get<{
        id: string;
        label: string | null;
        firstSeenAt: string;
        lastSeenAt: string;
        sessions: number;
        links: number;
        mergedInto: string | null;
        sessionsList: {
          id: string;
          startedAt: string;
          linkId: string;
          linkLabel: string;
          videoTitle: string;
          city: string | null;
          country: string | null;
          device: string | null;
          org: string | null;
          completionPct: number | null;
          confidence: string | null;
        }[];
      }>(`/visitors/${id}`),
  });
  const [label, setLabel] = useState<string | null>(null);
  const [mergeInto, setMergeInto] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const v = q.data;
  if (!v) return <ErrorText error={q.error} />;
  const refresh = () => qc.invalidateQueries({ queryKey: ['visitor', id] });
  return (
    <>
      <PageHeader title={v.label ?? v.id.slice(0, 8)}>
        <p className="text-sm text-muted-fg">
          {t('vis.firstSeen')} {fmtDateTime(v.firstSeenAt)} · {t('vis.lastSeen')} {fmtDateTime(v.lastSeenAt)}{' '}
          · {v.sessions} {t('dash.sessions').toLowerCase()} · {v.links} {t('vis.links').toLowerCase()}
        </p>
      </PageHeader>
      {can(me, 'editor') && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-end gap-2">
            <Input
              placeholder="Yritys X:n rekrytoija"
              value={label ?? v.label ?? ''}
              onChange={(e) => setLabel(e.target.value)}
              className="max-w-xs"
            />
            <Button
              onClick={() =>
                void patch(`/visitors/${id}`, { label: label || null })
                  .then(refresh)
                  .catch(setErr)
              }
            >
              {t('vis.rename')}
            </Button>
            <Input
              placeholder={t('vis.mergeInto')}
              value={mergeInto}
              onChange={(e) => setMergeInto(e.target.value.trim())}
              className="ml-auto w-80"
            />
            <Button
              variant="secondary"
              disabled={!mergeInto}
              onClick={() =>
                void post(`/visitors/${id}/merge`, { intoId: mergeInto }).then(refresh).catch(setErr)
              }
            >
              {t('vis.merge')}
            </Button>
          </div>
          <ErrorText error={err} />
        </Card>
      )}
      <Card title={t('sess.title')}>
        <Table>
          <tbody>
            {v.sessionsList.map((s) => (
              <tr key={s.id}>
                <td className="whitespace-nowrap">
                  <Link to="/sessions/$id" params={{ id: s.id }} className="hover:underline">
                    {fmtDateTime(s.startedAt)}
                  </Link>
                </td>
                <td>
                  <Link to="/links/$id" params={{ id: s.linkId }} className="hover:underline">
                    {s.linkLabel}
                  </Link>
                  <div className="text-xs text-muted-fg">{s.videoTitle}</div>
                </td>
                <td>{[s.city, s.country].filter(Boolean).join(', ')}</td>
                <td>{s.device}</td>
                <td>{s.org}</td>
                <td className="tabular-nums">{fmtPct(s.completionPct)}</td>
                <td className="text-xs text-muted-fg">{s.confidence}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
