import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { get } from '../lib/api';
import { fmtDuration, fmtNum, fmtPct, fmtRelative, fmtDateTime } from '../lib/format';
import { Card, Empty, Stat, Table } from '../components/ui';
import { PageHeader } from '../components/layout';
import { KpiGrid, TrendChart, delta } from '../components/charts';

export interface Kpis {
  sessions: number;
  views: number;
  plays: number;
  watchMs: number;
  completions: number;
  avgCompletionPct: number;
  previews: number;
  ctaClicks: number;
  uniqueVisitors: number;
  completionRate: number;
}

interface LiveRow {
  id: string;
  linkId: string;
  label: string;
  videoTitle: string;
  durationMs: number | null;
  city: string | null;
  country: string | null;
  device: string | null;
  positionMs: number;
  completionPct: number;
  lastSeenAt: string;
}

interface Overview {
  current: Kpis;
  previous: Kpis;
  series: { date: string; sessions: number; views: number; watchMs: number }[];
  topVideos: {
    id: string;
    title: string;
    sessions: number;
    views: number;
    avgCompletionPct: number | null;
  }[];
  topLinks: {
    id: string;
    label: string;
    recipientName: string | null;
    videoTitle: string;
    sessions: number;
    views: number;
    avgCompletionPct: number | null;
  }[];
  recent: {
    id: string;
    label: string;
    recipientName: string | null;
    videoTitle: string;
    lastOpenedAt: string;
    sessions: number;
  }[];
  live: LiveRow[];
  firstOpens: { id: string; label: string; videoTitle: string; at: string }[];
}

export function KpiRow({ cur, prev }: { cur: Kpis; prev?: Kpis }) {
  const { t } = useTranslation();
  const hint = t('dash.vsPrevious');
  return (
    <KpiGrid>
      <Stat
        label={t('dash.sessions')}
        value={fmtNum(cur.sessions)}
        delta={prev ? delta(cur.sessions, prev.sessions) : null}
        hint={hint}
      />
      <Stat
        label={t('dash.views')}
        value={fmtNum(cur.views)}
        delta={prev ? delta(cur.views, prev.views) : null}
        hint={hint}
      />
      <Stat
        label={t('dash.uniqueVisitors')}
        value={fmtNum(cur.uniqueVisitors)}
        delta={prev ? delta(cur.uniqueVisitors, prev.uniqueVisitors) : null}
        hint={hint}
      />
      <Stat
        label={t('dash.watchTime')}
        value={fmtDuration(Number(cur.watchMs))}
        delta={prev ? delta(Number(cur.watchMs), Number(prev.watchMs)) : null}
        hint={hint}
      />
      <Stat
        label={t('dash.avgWatched')}
        value={fmtPct(cur.avgCompletionPct)}
        delta={prev ? delta(cur.avgCompletionPct, prev.avgCompletionPct) : null}
        hint={hint}
      />
      <Stat
        label={t('dash.completionRate')}
        value={fmtPct(cur.completionRate, 1)}
        delta={prev ? delta(cur.completionRate, prev.completionRate) : null}
        hint={hint}
      />
    </KpiGrid>
  );
}

/** Live "watching now" list: snapshot + SSE heartbeats; entries expire after 15 s without a heartbeat. */
export function LiveCard({ initial }: { initial: LiveRow[] }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Record<string, LiveRow & { seen: number }>>({});
  useEffect(() => {
    setRows(Object.fromEntries(initial.map((r) => [r.id, { ...r, seen: Date.now() }])));
  }, [initial]);
  useEffect(() => {
    const es = new EventSource('/api/admin/analytics/live', { withCredentials: true });
    es.addEventListener('heartbeat', (e) => {
      const d = JSON.parse((e as MessageEvent).data as string) as { sessionId: string; positionMs: number };
      setRows((r) =>
        r[d.sessionId]
          ? { ...r, [d.sessionId]: { ...r[d.sessionId]!, positionMs: d.positionMs, seen: Date.now() } }
          : r,
      );
    });
    es.addEventListener('snapshot', (e) => {
      const list = JSON.parse((e as MessageEvent).data as string) as LiveRow[];
      setRows((r) => ({ ...r, ...Object.fromEntries(list.map((x) => [x.id, { ...x, seen: Date.now() }])) }));
    });
    const tick = setInterval(
      () =>
        setRows((r) => Object.fromEntries(Object.entries(r).filter(([, x]) => Date.now() - x.seen < 20_000))),
      5000,
    );
    return () => {
      es.close();
      clearInterval(tick);
    };
  }, []);
  const list = Object.values(rows);
  return (
    <Card title={`${t('dash.watchingNow')} (${list.length})`}>
      {list.length === 0 ? (
        <p className="text-sm text-muted-fg">{t('dash.nobodyWatching')}</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {list.map((r) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="inline-block size-2 animate-pulse rounded-full bg-ok" aria-hidden />
              <Link to="/sessions/$id" params={{ id: r.id }} className="truncate hover:underline">
                {r.label}
              </Link>
              <span className="ml-auto whitespace-nowrap text-xs text-muted-fg">
                {fmtDuration(r.positionMs)} / {fmtDuration(r.durationMs)} ·{' '}
                {[r.city, r.device].filter(Boolean).join(', ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['overview'],
    queryFn: () => get<Overview>('/analytics/overview'),
    refetchInterval: 60_000,
  });
  const o = q.data;
  return (
    <>
      <PageHeader title={t('dash.title')}>
        <p className="text-sm text-muted-fg">{t('dash.last30')}</p>
      </PageHeader>
      {o && (
        <div className="space-y-4">
          <KpiRow cur={o.current} prev={o.previous} />
          <div className="grid gap-4 xl:grid-cols-3">
            <Card title={t('dash.daily')} className="xl:col-span-2">
              <TrendChart
                data={o.series}
                series={[
                  { key: 'sessions', label: t('dash.sessions'), color: 'var(--series-1)' },
                  { key: 'views', label: t('dash.views'), color: 'var(--series-2)' },
                ]}
              />
            </Card>
            <LiveCard initial={o.live} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title={t('dash.topVideos')}>
              {o.topVideos.length === 0 ? (
                <Empty>{t('an.noData')}</Empty>
              ) : (
                <Table>
                  <tbody>
                    {o.topVideos.map((v) => (
                      <tr key={v.id}>
                        <td>
                          <Link
                            to="/videos/$id"
                            params={{ id: v.id }}
                            search={{ tab: 'analytics' }}
                            className="hover:underline"
                          >
                            {v.title}
                          </Link>
                        </td>
                        <td className="text-right tabular-nums">{fmtNum(v.sessions)}</td>
                        <td className="text-right tabular-nums text-muted-fg">
                          {fmtPct(v.avgCompletionPct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
            <Card title={t('dash.topLinks')}>
              {o.topLinks.length === 0 ? (
                <Empty>{t('an.noData')}</Empty>
              ) : (
                <Table>
                  <tbody>
                    {o.topLinks.map((l) => (
                      <tr key={l.id}>
                        <td>
                          <Link to="/links/$id" params={{ id: l.id }} className="hover:underline">
                            {l.label}
                          </Link>
                          <div className="text-xs text-muted-fg">{l.videoTitle}</div>
                        </td>
                        <td className="text-right tabular-nums">{fmtNum(l.sessions)}</td>
                        <td className="text-right tabular-nums text-muted-fg">
                          {fmtPct(l.avgCompletionPct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
            <Card title={t('dash.recentOpened')}>
              <ul className="space-y-1.5 text-sm">
                {o.recent.map((l) => (
                  <li key={l.id} className="flex justify-between gap-2">
                    <Link to="/links/$id" params={{ id: l.id }} className="truncate hover:underline">
                      {l.label}
                    </Link>
                    <span
                      className="whitespace-nowrap text-xs text-muted-fg"
                      title={fmtDateTime(l.lastOpenedAt)}
                    >
                      {fmtRelative(l.lastOpenedAt)}
                    </span>
                  </li>
                ))}
              </ul>
              {o.firstOpens.length > 0 && (
                <>
                  <h3 className="mb-1 mt-4 text-xs font-medium text-muted-fg">{t('dash.firstOpens')}</h3>
                  <ul className="space-y-1 text-sm">
                    {o.firstOpens.map((f) => (
                      <li key={f.id} className="flex justify-between gap-2">
                        <span className="truncate">🔔 {f.label}</span>
                        <span className="whitespace-nowrap text-xs text-muted-fg">{fmtRelative(f.at)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
