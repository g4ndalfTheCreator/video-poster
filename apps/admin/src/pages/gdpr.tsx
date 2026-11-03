import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { get, post, qs } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { Button, Card, ConfirmDialog, ErrorText, Field, Input, Table } from '../components/ui';

interface Found {
  id: string;
  startedAt: string;
  ip: string | null;
  city: string | null;
  country: string | null;
  device: string | null;
  linkLabel: string;
  videoTitle: string;
}

export function GdprCard() {
  const { t } = useTranslation();
  const [f, setF] = useState({ ip: '', linkId: '', visitorId: '' });
  const [rows, setRows] = useState<Found[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const filter = Object.fromEntries(
    Object.entries(f)
      .filter(([, v]) => v.trim())
      .map(([k, v]) => [k, v.trim()]),
  );
  const search = () => {
    setErr(null);
    setDone(null);
    void get<{ sessions: Found[] }>(`/gdpr/search${qs(filter)}`)
      .then((r) => setRows(r.sessions))
      .catch(setErr);
  };
  return (
    <Card title={t('gdpr.tab')}>
      <p className="mb-3 text-sm text-muted-fg">{t('gdpr.intro')}</p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <Field label={t('gdpr.ip')}>
          <Input
            value={f.ip}
            placeholder="192.0.2.10 / 192.0.2.0/24"
            onChange={(e) => setF({ ...f, ip: e.target.value })}
          />
        </Field>
        <Field label={t('gdpr.linkId')}>
          <Input value={f.linkId} onChange={(e) => setF({ ...f, linkId: e.target.value })} className="w-80" />
        </Field>
        <Field label={t('gdpr.visitorId')}>
          <Input
            value={f.visitorId}
            onChange={(e) => setF({ ...f, visitorId: e.target.value })}
            className="w-80"
          />
        </Field>
        <Button type="submit" disabled={!Object.keys(filter).length}>
          {t('gdpr.search')}
        </Button>
      </form>
      <ErrorText error={err} />
      {done !== null && <p className="mt-3 text-sm text-ok">{t('gdpr.deleted', { n: done })}</p>}
      {rows && (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm">{t('gdpr.found', { n: rows.length })}</span>
            <a href={`/api/admin/gdpr/export${qs(filter)}`}>
              <Button size="sm" variant="secondary" disabled={!rows.length}>
                {t('gdpr.export')}
              </Button>
            </a>
            <Button size="sm" variant="danger" disabled={!rows.length} onClick={() => setConfirm(true)}>
              {t('gdpr.delete')}
            </Button>
          </div>
          <Table>
            <tbody>
              {rows.slice(0, 200).map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">
                    <Link to="/sessions/$id" params={{ id: r.id }} className="hover:underline">
                      {fmtDateTime(r.startedAt)}
                    </Link>
                  </td>
                  <td className="font-mono text-xs">{r.ip}</td>
                  <td>{r.linkLabel}</td>
                  <td>{[r.city, r.country].filter(Boolean).join(', ')}</td>
                  <td>{r.device}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title={t('gdpr.delete')}
        body={t('gdpr.confirm', { n: rows?.length ?? 0 })}
        confirmLabel={t('gdpr.delete')}
        cancelLabel={t('app.cancel')}
        onClose={() => setConfirm(false)}
        onConfirm={() =>
          void post<{ sessions: number }>('/gdpr/delete', { filter, confirm: true })
            .then((r) => {
              setDone(r.sessions);
              setRows(null);
              setConfirm(false);
            })
            .catch(setErr)
        }
      />
    </Card>
  );
}
