import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { get } from '../lib/api';
import { can, useMe } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { Button, Card, Dialog, ErrorText } from '../components/ui';
import { PageHeader } from '../components/layout';
import { CopyButton, LinkForm, LinkStateBadge, type LinkRow } from './links';
import { linkExtras } from './link-extras';

export function LinkDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams({ from: '/links/$id' });
  const { data: me } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['link', id], queryFn: () => get<LinkRow>(`/links/${id}`) });
  const [editing, setEditing] = useState(false);
  const l = q.data;
  if (!l) return <ErrorText error={q.error} />;
  const Extra = linkExtras.Recipient;
  return (
    <>
      <PageHeader
        title={l.label}
        actions={
          <>
            <CopyButton text={l.url} />
            {can(me, 'editor') && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                {t('app.edit')}
              </Button>
            )}
          </>
        }
      >
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-fg">
          <LinkStateBadge state={l.state} />
          <Link
            to="/videos/$id"
            params={{ id: l.videoId }}
            search={{ tab: 'links' }}
            className="hover:underline"
          >
            {l.videoTitle}
          </Link>
          · <code>{l.url}</code>
        </div>
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t('links.recipient')}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-fg">{t('links.recipientName')}</dt>
            <dd>{l.recipientName ?? '–'}</dd>
            <dt className="text-muted-fg">{t('links.recipientOrg')}</dt>
            <dd>{l.recipientOrg ?? '–'}</dd>
            <dt className="text-muted-fg">{t('links.note')}</dt>
            <dd className="whitespace-pre-wrap">{l.note ?? '–'}</dd>
            <dt className="text-muted-fg">{t('links.expires')}</dt>
            <dd>{fmtDateTime(l.expiresAt)}</dd>
            <dt className="text-muted-fg">{t('links.maxSessions')}</dt>
            <dd>{l.maxSessions ?? '–'}</dd>
          </dl>
        </Card>
        <div className="lg:col-span-2">
          <Extra link={l} />
        </div>
      </div>
      <Dialog open={editing} title={t('app.edit')} onClose={() => setEditing(false)}>
        <LinkForm
          videoId={l.videoId}
          link={l}
          onDone={() => {
            setEditing(false);
            void qc.invalidateQueries({ queryKey: ['link', id] });
          }}
        />
      </Dialog>
    </>
  );
}
