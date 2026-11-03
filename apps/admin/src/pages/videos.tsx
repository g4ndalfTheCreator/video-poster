import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { Page, VideoStatus } from '@vs/shared';
import { get, post, qs } from '../lib/api';
import { can, useMe } from '../lib/auth';
import { fmtDate, fmtDateTime, fmtDuration, fmtNum, fmtPct } from '../lib/format';
import { toggleSort } from '../lib/search';
import { useSse } from '../lib/sse';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Empty,
  Input,
  Pager,
  Select,
  SortHeader,
  Table,
} from '../components/ui';
import { PageHeader } from '../components/layout';

export interface VideoRow {
  id: string;
  title: string;
  status: VideoStatus;
  durationMs: number | null;
  createdAt: string;
  posterUrl: string | null;
  linkCount: number;
  sessions: number;
  avgCompletion: number | null;
  error: string | null;
}

export function StatusBadge({ status }: { status: VideoStatus }) {
  const { t } = useTranslation();
  const tone =
    status === 'ready' ? 'ok' : status === 'failed' ? 'danger' : status === 'archived' ? 'neutral' : 'info';
  return <Badge tone={tone}>{t(`videos.statuses.${status}`)}</Badge>;
}

export function VideosPage() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const search = useSearch({ from: '/videos' });
  const navigate = useNavigate({ from: '/videos' });
  const [trash, setTrash] = useState(false);
  const q = useQuery({
    queryKey: ['videos', search],
    queryFn: () => get<Page<VideoRow>>(`/videos${qs({ ...search })}`),
  });
  useSse('/videos-events', 'video', (e) => {
    if ((e as { type?: string }).type === 'status') void qc.invalidateQueries({ queryKey: ['videos'] });
  });
  const setSearch = (s: Partial<typeof search>) => void navigate({ search: { ...search, ...s } });
  return (
    <>
      <PageHeader
        title={t('videos.title')}
        actions={
          <>
            {can(me, 'editor') && (
              <Button variant="secondary" onClick={() => setTrash(true)}>
                {t('videos.trash')}
              </Button>
            )}
            {can(me, 'editor') && (
              <Link to="/upload">
                <Button>{t('nav.upload')}</Button>
              </Link>
            )}
          </>
        }
      />
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <Input
            placeholder={t('app.search')}
            className="max-w-xs"
            defaultValue={search.q ?? ''}
            onChange={(e) => setSearch({ q: e.target.value || undefined, page: 1 })}
          />
          <Select
            value={search.status ?? ''}
            onChange={(e) => setSearch({ status: e.target.value || undefined, page: 1 })}
            aria-label={t('videos.filterStatus')}
          >
            <option value="">{t('app.all')}</option>
            {(['ready', 'processing', 'failed', 'uploading', 'archived'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`videos.statuses.${s}`)}
              </option>
            ))}
          </Select>
        </div>
        {q.data?.items.length === 0 ? (
          <Empty>{t('videos.empty')}</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className="w-24">{t('videos.poster')}</th>
                <SortHeader
                  label={t('videos.name')}
                  field="title"
                  sort={search.sort}
                  dir={search.dir}
                  onSort={(f) => setSearch(toggleSort(search, f))}
                />
                <SortHeader
                  label={t('videos.duration')}
                  field="duration"
                  sort={search.sort}
                  dir={search.dir}
                  onSort={(f) => setSearch(toggleSort(search, f))}
                />
                <SortHeader
                  label={t('videos.status')}
                  field="status"
                  sort={search.sort}
                  dir={search.dir}
                  onSort={(f) => setSearch(toggleSort(search, f))}
                />
                <SortHeader
                  label={t('videos.links')}
                  field="links"
                  sort={search.sort}
                  dir={search.dir}
                  onSort={(f) => setSearch(toggleSort(search, f))}
                />
                <SortHeader
                  label={t('videos.sessions')}
                  field="sessions"
                  sort={search.sort}
                  dir={search.dir}
                  onSort={(f) => setSearch(toggleSort(search, f))}
                />
                <SortHeader
                  label={t('videos.avgWatched')}
                  field="completion"
                  sort={search.sort}
                  dir={search.dir}
                  onSort={(f) => setSearch(toggleSort(search, f))}
                />
                <SortHeader
                  label={t('videos.created')}
                  field="createdAt"
                  sort={search.sort}
                  dir={search.dir}
                  onSort={(f) => setSearch(toggleSort(search, f))}
                />
              </tr>
            </thead>
            <tbody>
              {q.data?.items.map((v) => (
                <tr key={v.id}>
                  <td>
                    {v.posterUrl ? (
                      <img
                        src={v.posterUrl}
                        alt=""
                        className="h-12 w-20 rounded object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="h-12 w-20 rounded bg-muted" />
                    )}
                  </td>
                  <td>
                    <Link
                      to="/videos/$id"
                      params={{ id: v.id }}
                      search={{ tab: 'details' }}
                      className="font-medium hover:underline"
                    >
                      {v.title}
                    </Link>
                  </td>
                  <td className="tabular-nums">{fmtDuration(v.durationMs)}</td>
                  <td>
                    <StatusBadge status={v.status} />
                  </td>
                  <td className="tabular-nums">{fmtNum(v.linkCount)}</td>
                  <td className="tabular-nums">{fmtNum(v.sessions)}</td>
                  <td className="tabular-nums">{fmtPct(v.avgCompletion)}</td>
                  <td className="whitespace-nowrap">{fmtDate(v.createdAt)}</td>
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
            onPage={(p) => setSearch({ page: p })}
            labels={{ prev: t('app.prev'), next: t('app.next'), of: t('app.of') }}
          />
        )}
      </Card>
      <TrashDialog open={trash} onClose={() => setTrash(false)} />
    </>
  );
}

function TrashDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['trash'],
    queryFn: () => get<{ id: string; title: string; deletedAt: string; purgeAt: string }[]>('/videos-trash'),
    enabled: open,
  });
  return (
    <Dialog open={open} title={t('videos.trash')} onClose={onClose}>
      {q.data?.length === 0 && <Empty>{t('app.none')}</Empty>}
      <Table>
        <tbody>
          {q.data?.map((v) => (
            <tr key={v.id}>
              <td>{v.title}</td>
              <td className="text-xs text-muted-fg">
                {t('videos.purgeAt')} {fmtDateTime(v.purgeAt)}
              </td>
              <td className="text-right">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void post(`/videos/${v.id}/restore`).then(() => qc.invalidateQueries())}
                >
                  {t('videos.restore')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Dialog>
  );
}
