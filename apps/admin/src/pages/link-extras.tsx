import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { get } from '../lib/api';
import { fmtDateTime, fmtNum, fmtPct, fmtDuration } from '../lib/format';
import { Badge, Card, Stat, Table } from '../components/ui';
import { KpiGrid } from '../components/charts';
import type { LinkRow } from './links';

export interface SessionRow {
  id: string;
  startedAt: string;
  ip: string | null;
  city: string | null;
  country: string | null;
  device: string | null;
  os: string | null;
  browser: string | null;
  isBot: boolean;
  networkType: string | null;
  org: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  completionPct: number | null;
  uniqueWatchedMs: number | null;
  source: string | null;
  visitorId: string | null;
  visitorLabel: string | null;
  otherLinks?: number;
  feedbackRating?: 'up' | 'meh' | 'down' | null;
  feedbackComment?: string | null;
  reachedDocuments?: boolean;
}

export const FEEDBACK_EMOJI = { up: '👍', meh: '🤷', down: '👎' } as const;

export function NetworkCell({ s }: { s: Pick<SessionRow, 'networkType' | 'org' | 'confidence' | 'ip'> }) {
  const { t } = useTranslation();
  return (
    <div>
      <div>{s.org ?? '–'}</div>
      <div className="text-xs text-muted-fg">
        {s.networkType ? t(`sess.nets.${s.networkType}`) : ''}
        {s.confidence && (
          <>
            {' · '}
            <Badge tone={s.confidence === 'high' ? 'ok' : s.confidence === 'medium' ? 'info' : 'neutral'}>
              {t('sess.confidence')}: {t(`sess.conf.${s.confidence}`)}
            </Badge>
          </>
        )}
        {s.ip && <div className="font-mono">{s.ip}</div>}
      </div>
    </div>
  );
}

interface Recipient {
  opened: boolean;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  totals: {
    sessions: number;
    maxCompletionPct: number;
    ctaClicks: number;
    attachmentDownloads: number;
    videoDownloads: number;
    watchMs: number;
  };
  sessions: SessionRow[];
  previews: {
    fetchedAt: string;
    botName: string | null;
    country: string | null;
    org: string | null;
    networkType: string | null;
  }[];
  linkEvents: { type: string; ts: string }[];
}

function RecipientView({ link }: { link: LinkRow }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['recipient', link.id],
    queryFn: () => get<Recipient>(`/analytics/links/${link.id}`),
  });
  const r = q.data;
  if (!r) return null;
  return (
    <div className="space-y-4">
      <KpiGrid className="xl:grid-cols-4">
        <Stat label={r.opened ? t('rec.opened') : t('rec.notOpened')} value={r.opened ? '✓' : '–'} />
        <Stat label={t('dash.sessions')} value={fmtNum(r.totals.sessions)} />
        <Stat label={t('rec.maxWatched')} value={fmtPct(r.totals.maxCompletionPct)} />
        <Stat label={t('dash.watchTime')} value={fmtDuration(Number(r.totals.watchMs))} />
        <Stat
          label={t('rec.firstOpen')}
          value={<span className="text-base">{fmtDateTime(r.firstOpenedAt)}</span>}
        />
        <Stat
          label={t('rec.lastOpen')}
          value={<span className="text-base">{fmtDateTime(r.lastOpenedAt)}</span>}
        />
        <Stat label={t('dash.ctaClicks')} value={fmtNum(r.totals.ctaClicks)} />
        <Stat
          label={t('rec.attachments')}
          value={fmtNum(r.totals.attachmentDownloads + r.totals.videoDownloads)}
        />
      </KpiGrid>
      <Card title={t('sess.title')}>
        <Table>
          <thead>
            <tr>
              <th>{t('sess.time')}</th>
              <th>{t('sess.location')}</th>
              <th>{t('sess.device')}</th>
              <th>{t('sess.network')}</th>
              <th className="text-right">{t('sess.watched')}</th>
              <th>{t('sess.visitor')}</th>
            </tr>
          </thead>
          <tbody>
            {r.sessions.map((s) => (
              <tr key={s.id} className={s.isBot ? 'opacity-50' : ''}>
                <td className="whitespace-nowrap">
                  <Link to="/sessions/$id" params={{ id: s.id }} className="hover:underline">
                    {fmtDateTime(s.startedAt)}
                  </Link>
                  {s.isBot && <Badge tone="warn">bot</Badge>}
                </td>
                <td>{[s.city, s.country].filter(Boolean).join(', ') || '–'}</td>
                <td>
                  {s.device}
                  <div className="text-xs text-muted-fg">{[s.browser, s.os].filter(Boolean).join(' · ')}</div>
                </td>
                <td>
                  <NetworkCell s={s} />
                </td>
                <td className="text-right tabular-nums">
                  {fmtPct(s.completionPct)}
                  <div className="text-xs text-muted-fg">
                    {s.source === 'server' ? t('sess.sourceServer') : ''}
                  </div>
                  {s.reachedDocuments && (
                    <div className="text-xs" title={t('story.reached')}>
                      📄 {t('story.docs')}
                    </div>
                  )}
                  {s.feedbackRating && (
                    <div className="text-xs" title={s.feedbackComment ?? ''}>
                      {FEEDBACK_EMOJI[s.feedbackRating]}{' '}
                      {s.feedbackComment ? `“${s.feedbackComment.slice(0, 60)}”` : ''}
                    </div>
                  )}
                </td>
                <td className="text-xs">
                  {s.visitorId ? (
                    <Link to="/visitors/$id" params={{ id: s.visitorId }} className="hover:underline">
                      {s.visitorLabel ?? s.visitorId.slice(0, 8)}
                    </Link>
                  ) : (
                    '–'
                  )}
                  {!!s.otherLinks && (
                    <div className="text-warn">{t('sess.otherLinks', { n: s.otherLinks })}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card title={`${t('dash.previews')} (${r.previews.length})`}>
        <p className="mb-2 text-xs text-muted-fg">{t('rec.previewsHint')}</p>
        <Table>
          <tbody>
            {r.previews.map((p, i) => (
              <tr key={i}>
                <td className="whitespace-nowrap">{fmtDateTime(p.fetchedAt)}</td>
                <td>{p.botName}</td>
                <td>{p.country}</td>
                <td>{p.org}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        {r.linkEvents.length > 0 && (
          <>
            <h3 className="mb-1 mt-3 text-xs font-medium text-muted-fg">{t('rec.linkEvents')}</h3>
            <ul className="text-xs">
              {r.linkEvents.map((e, i) => (
                <li key={i}>
                  {fmtDateTime(e.ts)} <code>{e.type}</code>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

export const linkExtras = { Recipient: RecipientView };
