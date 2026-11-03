import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { get, qs } from '../lib/api';
import { fmtNum, fmtPct } from '../lib/format';
import { Button, Card, Stat, Table, Tabs } from '../components/ui';
import { PageHeader } from '../components/layout';
import { FilterBar } from '../components/filters';
import { BarList, KpiGrid, TrendChart } from '../components/charts';
import { KpiRow, type Kpis } from './dashboard';
import { VideoAnalyticsView } from './video-analytics';

interface Quality {
  startupP50: number | null;
  startupP95: number | null;
  ttffP50: number | null;
  ttffP95: number | null;
  rebufferRatio: number;
  renditions: { height: number; share: number }[];
  errors: { code: string; n: number; fatal: number }[];
  byBrowser: { browser: string; sessions: number; errors: number }[];
}

export function AnalyticsPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: '/analytics' });
  const navigate = useNavigate({ from: '/analytics' });
  const filters = { from: search.from, to: search.to, videoId: search.videoId, linkId: search.linkId };
  const view = search.view ?? 'overview';
  const overview = useQuery({
    queryKey: ['overview', filters],
    queryFn: () =>
      get<{ current: Kpis; previous: Kpis; series: { date: string; sessions: number; views: number }[] }>(
        `/analytics/overview${qs(filters)}`,
      ),
    enabled: view === 'overview',
  });
  const quality = useQuery({
    queryKey: ['quality', filters],
    queryFn: () => get<Quality>(`/analytics/quality${qs(filters)}`),
    enabled: view === 'quality',
  });
  const exportUrl = (format: string, v: string) =>
    `/api/admin/analytics/export${qs({ ...filters, format, view: v })}`;
  return (
    <>
      <PageHeader
        title={t('an.title')}
        actions={
          <>
            <a href={exportUrl('csv', 'daily')}>
              <Button variant="secondary" size="sm">
                {t('an.exportCsv')}
              </Button>
            </a>
            <a href={exportUrl('json', 'sessions')}>
              <Button variant="secondary" size="sm">
                {t('an.exportJson')}
              </Button>
            </a>
          </>
        }
      />
      <FilterBar value={search} onChange={(v) => void navigate({ search: { ...search, ...v } })} />
      <Tabs
        value={view}
        onChange={(v) => void navigate({ search: { ...search, view: v } })}
        items={[
          { value: 'overview', label: t('an.overview') },
          { value: 'quality', label: t('an.quality') },
        ]}
      />
      <div className="mt-4 space-y-4">
        {view === 'overview' && overview.data && (
          <>
            <KpiRow cur={overview.data.current} prev={overview.data.previous} />
            <Card title={t('dash.daily')}>
              <TrendChart
                data={overview.data.series}
                series={[
                  { key: 'sessions', label: t('dash.sessions'), color: 'var(--series-1)' },
                  { key: 'views', label: t('dash.views'), color: 'var(--series-2)' },
                ]}
              />
            </Card>
            {search.videoId && (
              <VideoAnalyticsView
                videoId={search.videoId}
                filters={{ from: search.from, to: search.to, linkId: search.linkId }}
              />
            )}
          </>
        )}
        {view === 'quality' && quality.data && (
          <>
            <KpiGrid>
              <Stat
                label={`${t('an.startup')} ${t('an.p50')}`}
                value={quality.data.startupP50 !== null ? `${fmtNum(quality.data.startupP50)} ms` : '–'}
              />
              <Stat
                label={`${t('an.startup')} ${t('an.p95')}`}
                value={quality.data.startupP95 !== null ? `${fmtNum(quality.data.startupP95)} ms` : '–'}
              />
              <Stat
                label={`${t('an.ttff')} ${t('an.p50')}`}
                value={quality.data.ttffP50 !== null ? `${fmtNum(quality.data.ttffP50)} ms` : '–'}
              />
              <Stat
                label={`${t('an.ttff')} ${t('an.p95')}`}
                value={quality.data.ttffP95 !== null ? `${fmtNum(quality.data.ttffP95)} ms` : '–'}
              />
              <Stat label={t('an.rebufferRatio')} value={fmtPct(quality.data.rebufferRatio * 100, 2)} />
            </KpiGrid>
            <div className="grid gap-4 lg:grid-cols-3">
              <Card title={t('an.renditions')}>
                <BarList
                  items={quality.data.renditions.map((r) => ({
                    key: `${r.height}p`,
                    count: Math.round(r.share * 1000) / 10,
                  }))}
                  format={(n) => fmtPct(n, 1)}
                />
              </Card>
              <Card title={t('an.errors')}>
                <Table>
                  <tbody>
                    {quality.data.errors.map((e) => (
                      <tr key={e.code}>
                        <td>
                          <code className="text-xs">{e.code}</code>
                        </td>
                        <td className="text-right tabular-nums">{fmtNum(e.n)}</td>
                        <td className="text-right text-xs text-danger">
                          {e.fatal ? `${e.fatal} fatal` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
              <Card title={t('an.byBrowser')}>
                <Table>
                  <tbody>
                    {quality.data.byBrowser.map((b) => (
                      <tr key={b.browser}>
                        <td>{b.browser}</td>
                        <td className="text-right tabular-nums">{fmtNum(b.sessions)}</td>
                        <td className="text-right tabular-nums text-muted-fg">{fmtNum(b.errors)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            </div>
          </>
        )}
      </div>
    </>
  );
}
