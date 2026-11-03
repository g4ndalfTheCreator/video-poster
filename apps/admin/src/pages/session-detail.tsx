import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { del, get, post } from '../lib/api';
import { can, useMe } from '../lib/auth';
import { fmtDateTime, fmtDuration, fmtNum, fmtPct } from '../lib/format';
import { Badge, Button, Card, ConfirmDialog, ErrorText, Stat, Table } from '../components/ui';
import { PageHeader } from '../components/layout';
import { KpiGrid } from '../components/charts';
import { FEEDBACK_EMOJI, NetworkCell } from './link-extras';

type R = [number, number];
interface Ev {
  seq: number;
  type: string;
  serverTs: string;
  clientTs: string | null;
  positionMs: number | null;
  payload: Record<string, unknown>;
}
interface Detail {
  id: string;
  linkId: string;
  linkLabel: string;
  videoId: string;
  videoTitle: string;
  durationMs: number;
  startedAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  ip: string | null;
  ipTrunc: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  asn: number | null;
  asOrg: string | null;
  network: {
    type: string | null;
    orgGuess: string | null;
    confidence: 'high' | 'medium' | 'low' | null;
    ptr: string | null;
    ptrConfirmed: boolean | null;
    rdapOrg: string | null;
    rdapNetname: string | null;
    rdapCidr: string | null;
    abuseEmail: string | null;
  };
  device: {
    type: string | null;
    os: string | null;
    browser: string | null;
    browserVersion: string | null;
    screen: [number, number] | null;
    lang: string | null;
    tz: string | null;
  };
  referrerHost: string | null;
  utm: Record<string, string> | null;
  isBot: boolean;
  botName: string | null;
  dnt: boolean | null;
  gpc: boolean | null;
  httpVersion: string | null;
  tlsVersion: string | null;
  visitor: {
    id: string;
    label: string | null;
    confidence: string | null;
    sessions: number;
    links: number;
  } | null;
  summary: {
    source: string;
    watchMs: number;
    uniqueWatchedMs: number;
    completionPct: number;
    playCount: number;
    seekCount: number;
    rebufferCount: number;
    rebufferMs: number;
    startupMs: number | null;
    ttffMs: number | null;
    playedRanges: R[];
    rawRanges: R[];
    serverPlayedRanges: R[];
    serverUniqueWatchedMs: number;
    ctaClicks: number;
    attachmentDownloads: number;
    exitReason: string | null;
  };
  feedback: { rating: 'up' | 'meh' | 'down'; comment: string | null; createdAt: string } | null;
  reachedDocuments: boolean;
  documentsVia: string | null;
  fingerprint: {
    fpHash: string;
    randomized: boolean;
    signals: Record<string, unknown>;
    seenCount: number;
  } | null;
  events: Ev[];
  segmentFetches: { ts: string; rendition: number; segmentIndex: number }[];
}

/** Player-timeline view: played ranges, server estimate, seeks, pauses and rebuffers on one axis. */
function Timeline({ d }: { d: Detail }) {
  const { t } = useTranslation();
  const dur = d.durationMs || 1;
  const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / dur) * 100))}%`;
  const marks = d.events.filter(
    (e) => ['seek', 'pause', 'rebuffer_start', 'ended'].includes(e.type) && e.positionMs !== null,
  );
  const color: Record<string, string> = {
    seek: 'var(--series-2)',
    pause: 'var(--muted-fg)',
    rebuffer_start: 'var(--danger)',
    ended: 'var(--ok)',
  };
  const Row = ({ label, ranges, tone }: { label: string; ranges: R[]; tone: string }) => (
    <div className="grid grid-cols-[10rem_1fr] items-center gap-3 text-xs">
      <span className="text-muted-fg">{label}</span>
      <div className="relative h-4 rounded bg-muted">
        {ranges.map((r, i) => (
          <div
            key={i}
            className="absolute inset-y-0 rounded-[3px]"
            style={{ left: pct(r[0]), width: `calc(${pct(r[1] - r[0])} - 1px)`, background: tone }}
            title={`${fmtDuration(r[0])}–${fmtDuration(r[1])}`}
          />
        ))}
      </div>
    </div>
  );
  return (
    <div className="space-y-2">
      <Row label={t('sess.played')} ranges={d.summary.playedRanges} tone="var(--series-1)" />
      {d.summary.rawRanges.length > d.summary.playedRanges.length && (
        <Row
          label={t('an.rewatch')}
          ranges={d.summary.rawRanges}
          tone="color-mix(in srgb, var(--series-1) 45%, transparent)"
        />
      )}
      <Row label={t('sess.serverEstimate')} ranges={d.summary.serverPlayedRanges} tone="var(--series-3)" />
      <div className="grid grid-cols-[10rem_1fr] items-center gap-3 text-xs">
        <span className="text-muted-fg">
          {t('sess.seeks')} / {t('sess.pauses')} / {t('sess.rebuffers')}
        </span>
        <div className="relative h-4">
          <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
          {marks.map((e) => (
            <div
              key={e.seq}
              className="absolute top-0 h-4 w-0.5 rounded"
              style={{ left: pct(e.positionMs!), background: color[e.type] }}
              title={`${e.type} ${fmtDuration(e.positionMs)}`}
            />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-[10rem_1fr] text-[11px] text-muted-fg">
        <span />
        <div className="flex justify-between tabular-nums">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span key={f}>{fmtDuration(dur * f)}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SessionDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams({ from: '/sessions/$id' });
  const { data: me } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['session', id], queryFn: () => get<Detail>(`/analytics/sessions/${id}`) });
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const d = q.data;
  if (!d) return <ErrorText error={q.error} />;
  const s = d.summary;
  const kv = (k: string, v: React.ReactNode) =>
    v !== null && v !== undefined && v !== '' ? (
      <>
        <dt className="text-muted-fg">{k}</dt>
        <dd className="break-words">{v}</dd>
      </>
    ) : null;
  return (
    <>
      <PageHeader
        title={`${t('sess.detail')}: ${d.linkLabel}`}
        actions={
          can(me, 'owner') && (
            <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
              {t('gdpr.deleteSession')}
            </Button>
          )
        }
      >
        <div className="mt-1 text-sm text-muted-fg">
          <Link
            to="/videos/$id"
            params={{ id: d.videoId }}
            search={{ tab: 'analytics' }}
            className="hover:underline"
          >
            {d.videoTitle}
          </Link>{' '}
          · {fmtDateTime(d.startedAt)} {d.isBot && <Badge tone="warn">bot: {d.botName}</Badge>}
        </div>
      </PageHeader>
      <div className="space-y-4">
        <KpiGrid>
          <Stat label={t('sess.watched')} value={fmtPct(s.completionPct)} />
          <Stat label={t('dash.watchTime')} value={fmtDuration(s.watchMs)} />
          <Stat label={t('sess.seeks')} value={fmtNum(s.seekCount)} />
          <Stat
            label={t('sess.rebuffers')}
            value={`${fmtNum(s.rebufferCount)} (${fmtDuration(s.rebufferMs)})`}
          />
          <Stat label={t('an.startup')} value={s.startupMs !== null ? `${s.startupMs} ms` : '–'} />
          <Stat
            label={t('sess.source')}
            value={
              <span className="text-base">
                {s.source === 'client' ? t('sess.sourceClient') : t('sess.sourceServer')}
              </span>
            }
          />
        </KpiGrid>
        <Card title={t('sess.timeline')}>
          <Timeline d={d} />
        </Card>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={t('sess.network')}>
            <NetworkCell
              s={{
                networkType: d.network.type,
                org: d.network.orgGuess,
                confidence: d.network.confidence,
                ip: d.ip,
              }}
            />
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {kv(t('sess.location'), [d.city, d.region, d.country].filter(Boolean).join(', '))}
              {kv('ASN', d.asn ? `AS${d.asn} ${d.asOrg ?? ''}` : null)}
              {kv(
                t('sess.rdap'),
                [d.network.rdapOrg, d.network.rdapNetname, d.network.rdapCidr].filter(Boolean).join(' · '),
              )}
              {kv(
                t('sess.ptr'),
                d.network.ptr ? `${d.network.ptr}${d.network.ptrConfirmed ? ' ✓' : ''}` : null,
              )}
              {kv('abuse', d.network.abuseEmail)}
              {kv('IP /24', d.ipTrunc)}
              {kv('HTTP / TLS', [d.httpVersion, d.tlsVersion].filter(Boolean).join(' · '))}
            </dl>
          </Card>
          <Card title={t('sess.device')}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {kv(t('sess.device'), d.device.type)}
              {kv('OS', d.device.os)}
              {kv('Browser', [d.device.browser, d.device.browserVersion].filter(Boolean).join(' '))}
              {kv('Screen', d.device.screen?.join('×'))}
              {kv('Lang / TZ', [d.device.lang, d.device.tz].filter(Boolean).join(' · '))}
              {kv('Referrer', d.referrerHost)}
              {kv(
                'UTM',
                d.utm
                  ? Object.entries(d.utm)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(', ')
                  : null,
              )}
              {kv('DNT / GPC', `${d.dnt ? 'DNT' : '–'} / ${d.gpc ? 'GPC' : '–'}`)}
              {kv(t('sess.exit'), s.exitReason)}
              {kv(
                t('story.docs'),
                d.reachedDocuments ? `✓ ${t(`story.via.${d.documentsVia ?? 'unknown'}`)}` : null,
              )}
              {kv(
                t('story.feedback'),
                d.feedback ? `${FEEDBACK_EMOJI[d.feedback.rating]} ${d.feedback.comment ?? ''}` : null,
              )}
            </dl>
          </Card>
          <Card title={t('sess.visitor')}>
            {d.visitor ? (
              <div className="space-y-2 text-sm">
                <Link
                  to="/visitors/$id"
                  params={{ id: d.visitor.id }}
                  className="font-medium hover:underline"
                >
                  {d.visitor.label ?? d.visitor.id.slice(0, 8)}
                </Link>
                <div className="text-muted-fg">
                  {d.visitor.confidence} · {d.visitor.sessions} {t('dash.sessions').toLowerCase()} ·{' '}
                  {d.visitor.links} {t('vis.links').toLowerCase()}
                </div>
                {can(me, 'editor') && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      void post(`/analytics/sessions/${d.id}/detach-visitor`).then(() =>
                        qc.invalidateQueries({ queryKey: ['session', id] }),
                      )
                    }
                  >
                    {t('sess.detach')}
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-fg">–</p>
            )}
            {d.fingerprint && (
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer">
                  {t('sess.profile')}{' '}
                  {d.fingerprint.randomized && <Badge tone="warn">{t('sess.randomized')}</Badge>}
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded bg-muted p-2">
                  {JSON.stringify(d.fingerprint.signals, null, 1)}
                </pre>
              </details>
            )}
          </Card>
        </div>
        <ConfirmDialog
          open={confirmDelete}
          title={t('gdpr.deleteSession')}
          body={t('gdpr.confirm', { n: 1 })}
          confirmLabel={t('gdpr.delete')}
          cancelLabel={t('app.cancel')}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() =>
            void del(`/analytics/sessions/${d.id}`).then(() =>
              navigate({ to: '/sessions', search: { page: 1 } }),
            )
          }
        />
        <Card title={`${t('sess.events')} (${d.events.length})`}>
          <Table>
            <tbody>
              {d.events.map((e) => (
                <tr key={`${e.seq}-${e.serverTs}`}>
                  <td className="whitespace-nowrap text-xs">{fmtDateTime(e.serverTs)}</td>
                  <td>
                    <code className="text-xs">{e.type}</code>
                  </td>
                  <td className="tabular-nums text-xs">
                    {e.positionMs !== null ? fmtDuration(e.positionMs) : ''}
                  </td>
                  <td className="max-w-lg truncate text-xs text-muted-fg" title={JSON.stringify(e.payload)}>
                    {e.type === 'fingerprint' ? '' : JSON.stringify(e.payload)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </>
  );
}
