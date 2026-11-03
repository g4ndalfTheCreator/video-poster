import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { get, qs } from '../lib/api';
import { fmtDuration, fmtNum, fmtPct, fmtRelative } from '../lib/format';
import { Button, Card, Empty, Table } from '../components/ui';
import { BarList, HeatStrip, RetentionChart, useSpriteCues } from '../components/charts';
import { KpiRow, type Kpis } from './dashboard';

interface VideoAnalytics {
  video: { id: string; title: string; durationMs: number; preview: { spriteVtt: string } | null };
  kpis: Kpis;
  retention: number[];
  rewatch: number[];
  viewsInCurve: number;
  dropOffs: { bucket: number; positionMs: number; drop: number }[];
  byCountry: { key: string; count: number }[];
  byDevice: { key: string; count: number }[];
  byReferrer: { key: string; count: number }[];
  byNetworkType: { key: string; count: number }[];
  byOrg: { key: string; count: number }[];
  links: {
    id: string;
    label: string;
    recipientName: string | null;
    sessions: number;
    views: number;
    avgCompletionPct: number;
    maxCompletionPct: number | null;
    lastOpenedAt: string | null;
    previews: number;
    ctaClicks: number;
  }[];
}

export function VideoAnalyticsView({
  videoId,
  filters,
}: {
  videoId: string;
  filters: { from?: string; to?: string; linkId?: string };
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['video-analytics', videoId, filters],
    queryFn: () => get<VideoAnalytics>(`/analytics/videos/${videoId}${qs(filters)}`),
  });
  const cues = useSpriteCues(q.data?.video.preview?.spriteVtt);
  const d = q.data;
  if (!d) return null;
  const seek = (ms: number) =>
    void navigate({
      to: '/videos/$id',
      params: { id: videoId },
      search: { tab: 'details', t: String(ms) } as never,
    });
  const exportUrl = (format: string, view: string) =>
    `/api/admin/analytics/export${qs({ ...filters, videoId, format, view })}`;
  return (
    <div className="space-y-4">
      <KpiRow cur={d.kpis} />
      <Card title={`${t('an.retention')} · ${fmtNum(d.viewsInCurve)} ${t('dash.views').toLowerCase()}`}>
        <p className="mb-2 text-xs text-muted-fg">{t('an.retentionHint')}</p>
        {d.viewsInCurve === 0 ? (
          <Empty>{t('an.noData')}</Empty>
        ) : (
          <>
            <RetentionChart
              retention={d.retention}
              durationMs={d.video.durationMs}
              cues={cues}
              onSeek={seek}
              labels={{ position: t('an.position'), share: t('an.share') }}
            />
            <div className="mt-4 mb-1 text-xs text-muted-fg">
              {t('an.rewatch')} – {t('an.rewatchHint')}
            </div>
            <HeatStrip values={d.rewatch} durationMs={d.video.durationMs} label={t('an.rewatch')} />
          </>
        )}
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t('an.dropOffs')}>
          <ol className="space-y-1.5 text-sm">
            {d.dropOffs.map((p) => (
              <li key={p.bucket} className="flex items-center justify-between gap-2">
                <button
                  className="tabular-nums text-primary hover:underline"
                  onClick={() => seek(p.positionMs)}
                >
                  {fmtDuration(p.positionMs)}
                </button>
                <span className="text-muted-fg">
                  {fmtPct(p.drop * 100, 1)} {t('an.viewersLost')}
                </span>
              </li>
            ))}
          </ol>
        </Card>
        <Card title={t('an.devices')}>
          <BarList items={d.byDevice} />
        </Card>
        <Card title={t('an.countries')}>
          <BarList items={d.byCountry} />
        </Card>
        <Card title={t('an.networks')}>
          <BarList items={d.byNetworkType} labelOf={(k) => t(`sess.nets.${k}`, { defaultValue: k })} />
        </Card>
        <Card title={t('an.orgs')}>
          <BarList items={d.byOrg} />
        </Card>
        <Card title={t('an.referrers')}>
          <BarList items={d.byReferrer} />
        </Card>
      </div>
      <Card
        title={t('an.linkCompare')}
        actions={
          <>
            <a href={exportUrl('csv', 'sessions')}>
              <Button size="sm" variant="secondary">
                {t('an.exportCsv')}
              </Button>
            </a>
            <a href={exportUrl('json', 'sessions')}>
              <Button size="sm" variant="secondary">
                {t('an.exportJson')}
              </Button>
            </a>
          </>
        }
      >
        <Table>
          <thead>
            <tr>
              <th>{t('links.label')}</th>
              <th className="text-right">{t('dash.sessions')}</th>
              <th className="text-right">{t('dash.views')}</th>
              <th className="text-right">{t('dash.avgWatched')}</th>
              <th className="text-right">{t('links.maxWatched')}</th>
              <th className="text-right">{t('dash.previews')}</th>
              <th className="text-right">{t('dash.ctaClicks')}</th>
              <th>{t('links.lastOpened')}</th>
            </tr>
          </thead>
          <tbody>
            {d.links.map((l) => (
              <tr key={l.id}>
                <td>
                  <Link to="/links/$id" params={{ id: l.id }} className="hover:underline">
                    {l.label}
                  </Link>
                  {l.recipientName && <div className="text-xs text-muted-fg">{l.recipientName}</div>}
                </td>
                <td className="text-right tabular-nums">{fmtNum(l.sessions)}</td>
                <td className="text-right tabular-nums">{fmtNum(l.views)}</td>
                <td className="text-right tabular-nums">{fmtPct(l.avgCompletionPct)}</td>
                <td className="text-right tabular-nums">{fmtPct(l.maxCompletionPct)}</td>
                <td className="text-right tabular-nums">{fmtNum(l.previews)}</td>
                <td className="text-right tabular-nums">{fmtNum(l.ctaClicks)}</td>
                <td className="whitespace-nowrap">{l.lastOpenedAt ? fmtRelative(l.lastOpenedAt) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
