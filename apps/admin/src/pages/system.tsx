import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get } from '../lib/api';
import { fmtBytes, fmtDateTime, fmtNum } from '../lib/format';
import { Badge, Card, Stat, Table } from '../components/ui';
import { PageHeader } from '../components/layout';
import { KpiGrid } from '../components/charts';

interface System {
  version: string;
  health: string;
  disk: { total: number; free: number } | null;
  databaseBytes: number;
  counts: Record<string, number>;
  queues: { name: string; state: string; n: number }[];
  failedJobs: { name: string; error: string | null; at: string | null }[];
  geoip: { city: boolean; asn: boolean; source: string };
  backup: { finishedAt?: string; ok?: boolean; file?: string; sizeBytes?: number } | null;
}

export function SystemPage() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['system'],
    queryFn: () => get<System>('/system'),
    refetchInterval: 15_000,
  });
  const s = q.data;
  if (!s) return null;
  return (
    <>
      <PageHeader title={t('sys.title')} />
      <div className="space-y-4">
        <KpiGrid>
          <Stat label={t('sys.version')} value={<span className="text-base">{s.version}</span>} />
          <Stat label={t('sys.health')} value={<Badge tone="ok">{s.health}</Badge>} />
          <Stat
            label={t('sys.disk')}
            value={
              <span className="text-base">{s.disk ? `${fmtBytes(s.disk.free)} ${t('sys.free')}` : '–'}</span>
            }
            hint={s.disk ? fmtBytes(s.disk.total) : ''}
          />
          <Stat label={t('sys.db')} value={<span className="text-base">{fmtBytes(s.databaseBytes)}</span>} />
          <Stat
            label={t('sys.backup')}
            value={
              <span className="text-base">
                {s.backup?.finishedAt
                  ? `${s.backup.ok ? '✓' : '✗'} ${fmtDateTime(s.backup.finishedAt)}`
                  : t('sys.none')}
              </span>
            }
          />
          <Stat
            label={t('sys.geoip')}
            value={
              <span className="text-base">
                {s.geoip.city && s.geoip.asn ? '✓' : s.geoip.city || s.geoip.asn ? '½' : '✗'}
              </span>
            }
          />
        </KpiGrid>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={t('sys.queues')}>
            <Table>
              <tbody>
                {s.queues.map((qq) => (
                  <tr key={`${qq.name}-${qq.state}`}>
                    <td>{qq.name}</td>
                    <td>
                      <Badge
                        tone={qq.state === 'failed' ? 'danger' : qq.state === 'completed' ? 'ok' : 'info'}
                      >
                        {qq.state}
                      </Badge>
                    </td>
                    <td className="text-right tabular-nums">{fmtNum(qq.n)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card title={t('sys.failed')}>
            <Table>
              <tbody>
                {s.failedJobs.map((j, i) => (
                  <tr key={i}>
                    <td className="whitespace-nowrap text-xs">{fmtDateTime(j.at)}</td>
                    <td>{j.name}</td>
                    <td className="max-w-sm truncate text-xs text-danger" title={j.error ?? ''}>
                      {j.error}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
        <Card>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            {Object.entries(s.counts).map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-muted-fg">{k}</dt>
                <dd className="tabular-nums">{fmtNum(Number(v))}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted-fg">
            {s.geoip.source} · {t('sys.attribution')}
          </p>
        </Card>
      </div>
    </>
  );
}
