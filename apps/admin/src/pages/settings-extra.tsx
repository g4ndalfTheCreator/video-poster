import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { del, get, patch, post } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { Badge, Button, Card, Checkbox, ErrorText, Field, Input, Select, Table } from '../components/ui';

interface Channel {
  id: string;
  kind: 'ntfy' | 'email' | 'webhook';
  isActive: boolean;
  config: Record<string, string>;
  lastDelivery: { ok: boolean; error: string | null; sent_at: string } | null;
}

export function ChannelsCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['channels'], queryFn: () => get<Channel[]>('/notification-channels') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['channels'] });
  const [kind, setKind] = useState<Channel['kind']>('ntfy');
  const [cfg, setCfg] = useState<Record<string, string>>({ url: 'https://ntfy.sh', topic: '' });
  const [tested, setTested] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      post('/notification-channels', {
        kind,
        config: Object.fromEntries(Object.entries(cfg).filter(([, v]) => v)),
        isActive: true,
      }),
    onSuccess: () => {
      setCfg(kind === 'ntfy' ? { url: 'https://ntfy.sh', topic: '' } : {});
      void refresh();
    },
  });
  const fields: Record<Channel['kind'], [string, string][]> = {
    ntfy: [
      ['url', t('settings.ntfyUrl')],
      ['topic', t('settings.ntfyTopic')],
      ['token', t('settings.ntfyToken')],
    ],
    email: [['to', t('settings.emailTo')]],
    webhook: [
      ['url', t('settings.webhookUrl')],
      ['secret', 'HMAC secret'],
    ],
  };
  return (
    <Card title={t('settings.channels')}>
      <Table>
        <tbody>
          {q.data?.map((c) => (
            <tr key={c.id}>
              <td>
                <Badge>{c.kind}</Badge>
              </td>
              <td className="text-xs">
                {Object.entries(c.config)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(' · ')}
              </td>
              <td className="text-xs">
                {c.lastDelivery &&
                  (c.lastDelivery.ok ? (
                    <span className="text-ok">✓ {fmtDateTime(c.lastDelivery.sent_at)}</span>
                  ) : (
                    <span className="text-danger" title={c.lastDelivery.error ?? ''}>
                      {t('settings.failed')} {fmtDateTime(c.lastDelivery.sent_at)}
                    </span>
                  ))}
              </td>
              <td className="whitespace-nowrap text-right">
                <Checkbox
                  label={t('settings.active')}
                  checked={c.isActive}
                  onChange={(v) =>
                    void patch(`/notification-channels/${c.id}`, { isActive: v }).then(refresh)
                  }
                />
              </td>
              <td className="whitespace-nowrap text-right">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void post(`/notification-channels/${c.id}/test`).then(() => setTested(c.id))}
                >
                  {tested === c.id ? t('settings.testSent') : t('settings.test')}
                </Button>{' '}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void del(`/notification-channels/${c.id}`).then(refresh)}
                >
                  {t('app.delete')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label={t('settings.kind')}>
          <Select
            value={kind}
            onChange={(e) => {
              const k = e.target.value as Channel['kind'];
              setKind(k);
              setCfg(k === 'ntfy' ? { url: 'https://ntfy.sh', topic: '' } : {});
            }}
          >
            <option value="ntfy">ntfy</option>
            <option value="email">email</option>
            <option value="webhook">webhook</option>
          </Select>
        </Field>
        {fields[kind].map(([k, label]) => (
          <Field key={k} label={label}>
            <Input
              value={cfg[k] ?? ''}
              required={k !== 'token' && k !== 'secret'}
              onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })}
            />
          </Field>
        ))}
        <Button type="submit">{t('settings.addChannel')}</Button>
      </form>
      <ErrorText error={create.error} />
    </Card>
  );
}

export function IpOverridesCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['ip-overrides'],
    queryFn: () =>
      get<
        {
          id: string;
          cidr: string;
          orgLabel: string;
          note: string | null;
          createdAt: string;
          createdBy: string | null;
        }[]
      >('/ip-overrides'),
  });
  const [form, setForm] = useState({ cidr: '', orgLabel: '', note: '' });
  const m = useMutation({
    mutationFn: () => post('/ip-overrides', { ...form, note: form.note || undefined }),
    onSuccess: () => {
      setForm({ cidr: '', orgLabel: '', note: '' });
      void qc.invalidateQueries({ queryKey: ['ip-overrides'] });
    },
  });
  return (
    <Card title={t('settings.ipOverrides')}>
      <p className="mb-2 text-xs text-muted-fg">{t('settings.overrideHint')}</p>
      <Table>
        <tbody>
          {q.data?.map((o) => (
            <tr key={o.id}>
              <td>
                <code>{o.cidr}</code>
              </td>
              <td>{o.orgLabel}</td>
              <td className="text-xs text-muted-fg">{o.note}</td>
              <td className="text-xs">{fmtDateTime(o.createdAt)}</td>
              <td className="text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void del(`/ip-overrides/${o.id}`).then(() =>
                      qc.invalidateQueries({ queryKey: ['ip-overrides'] }),
                    )
                  }
                >
                  {t('app.delete')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="IP / CIDR">
          <Input
            required
            placeholder="203.0.113.0/24"
            value={form.cidr}
            onChange={(e) => setForm({ ...form, cidr: e.target.value })}
          />
        </Field>
        <Field label={t('settings.orgLabel')}>
          <Input
            required
            value={form.orgLabel}
            onChange={(e) => setForm({ ...form, orgLabel: e.target.value })}
          />
        </Field>
        <Field label={t('settings.note')}>
          <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
        <Button type="submit">{t('app.create')}</Button>
      </form>
      <ErrorText error={m.error} />
    </Card>
  );
}
