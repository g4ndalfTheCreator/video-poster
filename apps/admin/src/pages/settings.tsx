import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { Settings, Role } from '@vs/shared';
import { del, get, patch, post, put } from '../lib/api';
import { can, useMe } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Dialog,
  ErrorText,
  Field,
  Input,
  Select,
  Table,
  Tabs,
  Textarea,
} from '../components/ui';
import { PageHeader } from '../components/layout';
import { ChannelsCard, IpOverridesCard } from './settings-extra';
import { GdprCard } from './gdpr';

type Tab = 'general' | 'users' | 'tokens' | 'channels' | 'gdpr' | 'account';

export function SettingsPage() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const search = useSearch({ from: '/settings' });
  const navigate = useNavigate({ from: '/settings' });
  const tab = (search.tab ?? 'general') as Tab;
  const items: { value: Tab; label: string }[] = [
    { value: 'general', label: t('settings.general') },
    ...(can(me, 'owner')
      ? ([
          { value: 'users', label: t('settings.users') },
          { value: 'tokens', label: t('settings.apiTokens') },
          { value: 'channels', label: t('settings.channels') },
          { value: 'gdpr', label: t('gdpr.tab') },
        ] as const)
      : []),
    { value: 'account', label: t('settings.account') },
  ];
  return (
    <>
      <PageHeader title={t('settings.title')} />
      <Tabs value={tab} onChange={(v) => void navigate({ search: { tab: v } })} items={items} />
      <div className="mt-4 space-y-4">
        {tab === 'general' && <GeneralSettings readOnly={!can(me, 'owner')} />}
        {tab === 'general' && can(me, 'editor') && <IpOverridesCard />}
        {tab === 'users' && <UsersCard />}
        {tab === 'tokens' && <TokensCard />}
        {tab === 'channels' && <ChannelsCard />}
        {tab === 'gdpr' && <GdprCard />}
        {tab === 'account' && <AccountCard />}
      </div>
    </>
  );
}

function GeneralSettings({ readOnly }: { readOnly: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => get<Settings>('/settings') });
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (q.data) setS(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: (v: Settings) => put<Settings>('/settings', v),
    onSuccess: (v) => qc.setQueryData(['settings'], v),
  });
  if (!s) return null;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(s);
      }}
    >
      <fieldset disabled={readOnly} className="space-y-4">
        <Card title={t('settings.branding')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('settings.brandName')}>
              <Input
                value={s.branding.name}
                onChange={(e) => set('branding', { ...s.branding, name: e.target.value })}
              />
            </Field>
            <Field label={t('settings.primaryColor')}>
              <Input
                type="color"
                value={s.branding.primaryColor}
                onChange={(e) => set('branding', { ...s.branding, primaryColor: e.target.value })}
              />
            </Field>
            <Field label={t('settings.footer')}>
              <Input
                value={s.branding.footer}
                onChange={(e) => set('branding', { ...s.branding, footer: e.target.value })}
              />
            </Field>
          </div>
        </Card>
        <Card title={t('settings.telemetry')}>
          <div className="space-y-3">
            <Field label={t('settings.telemetryLevel')}>
              <Select
                value={s.telemetry.level}
                onChange={(e) =>
                  set('telemetry', { level: e.target.value as Settings['telemetry']['level'] })
                }
              >
                {(['full', 'server', 'minimal'] as const).map((l) => (
                  <option key={l} value={l}>
                    {t(`settings.levels.${l}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {s.telemetry.level === 'full' && (
              <p className="rounded-md bg-warn/10 p-2 text-xs text-warn">{t('settings.levelWarning')}</p>
            )}
            <Checkbox
              label={t('settings.rdap')}
              checked={s.ipIntel.rdapEnabled}
              onChange={(v) => set('ipIntel', { ...s.ipIntel, rdapEnabled: v })}
            />
            <Checkbox
              label={t('settings.ptr')}
              checked={s.ipIntel.ptrEnabled}
              onChange={(v) => set('ipIntel', { ...s.ipIntel, ptrEnabled: v })}
            />
            <Checkbox
              label={t('settings.ja4')}
              checked={s.serverTelemetry.ja4}
              onChange={(v) => set('serverTelemetry', { ja4: v })}
            />
            <Field label={t('settings.blocklist')}>
              <Textarea
                value={s.blocklist.join('\n')}
                onChange={(e) =>
                  set(
                    'blocklist',
                    e.target.value
                      .split('\n')
                      .map((x) => x.trim())
                      .filter(Boolean),
                  )
                }
              />
            </Field>
          </div>
        </Card>
        <Card title={t('settings.retention')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('settings.eventsDays')}>
              <Input
                type="number"
                min={1}
                value={s.retention.eventsDays}
                onChange={(e) => set('retention', { ...s.retention, eventsDays: Number(e.target.value) })}
              />
            </Field>
            <Field label={t('settings.signalsDays')}>
              <Input
                type="number"
                min={1}
                value={s.retention.fingerprintSignalsDays}
                onChange={(e) =>
                  set('retention', { ...s.retention, fingerprintSignalsDays: Number(e.target.value) })
                }
              />
            </Field>
            <Field label={t('settings.serverData')}>
              <div className="flex gap-2">
                <Select
                  value={s.retention.serverData === 'forever' ? 'forever' : 'days'}
                  onChange={(e) =>
                    set('retention', {
                      ...s.retention,
                      serverData: e.target.value === 'forever' ? 'forever' : 365,
                    })
                  }
                >
                  <option value="forever">{t('settings.forever')}</option>
                  <option value="days">{t('settings.serverDataDays')}</option>
                </Select>
                {s.retention.serverData !== 'forever' && (
                  <Input
                    type="number"
                    min={30}
                    value={s.retention.serverData}
                    onChange={(e) => set('retention', { ...s.retention, serverData: Number(e.target.value) })}
                  />
                )}
              </div>
            </Field>
            <Field label={t('settings.archiveMonths')}>
              <Input
                type="number"
                min={1}
                value={s.retention.archiveAfterMonths}
                onChange={(e) =>
                  set('retention', { ...s.retention, archiveAfterMonths: Number(e.target.value) })
                }
              />
            </Field>
          </div>
        </Card>
        <Card title={t('settings.privacy')}>
          <div className="space-y-3">
            <Field label={t('settings.privacyFi')}>
              <Textarea
                rows={8}
                value={s.privacy.fi}
                onChange={(e) => set('privacy', { ...s.privacy, fi: e.target.value })}
              />
            </Field>
            <Field label={t('settings.privacyEn')}>
              <Textarea
                rows={8}
                value={s.privacy.en}
                onChange={(e) => set('privacy', { ...s.privacy, en: e.target.value })}
              />
            </Field>
          </div>
        </Card>
        <Card title={t('settings.ui')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('settings.locale')}>
              <Select
                value={s.ui.locale}
                onChange={(e) => set('ui', { ...s.ui, locale: e.target.value as 'fi' | 'en' })}
              >
                <option value="fi">suomi</option>
                <option value="en">English</option>
              </Select>
            </Field>
            <Field label={t('settings.timezone')}>
              <Input
                value={s.ui.timezone}
                onChange={(e) => set('ui', { ...s.ui, timezone: e.target.value })}
              />
            </Field>
          </div>
        </Card>
      </fieldset>
      {!readOnly && (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            {t('app.save')}
          </Button>
          {save.isSuccess && <span className="text-sm text-ok">{t('app.saved')}</span>}
          <ErrorText error={save.error} />
        </div>
      )}
    </form>
  );
}

interface UserRow {
  id: string;
  email: string;
  role: Role;
  disabled: boolean;
  totpEnabled: boolean;
  lastLoginAt: string | null;
}

function UsersCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<UserRow[]>('/users') });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', role: 'viewer' as Role });
  const [confirm, setConfirm] = useState<UserRow | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const create = useMutation({
    mutationFn: () => post('/users', form),
    onSuccess: () => {
      setAdding(false);
      setForm({ email: '', password: '', role: 'viewer' });
      void refresh();
    },
  });
  return (
    <Card
      title={t('settings.users')}
      actions={
        <Button size="sm" onClick={() => setAdding(true)}>
          {t('settings.addUser')}
        </Button>
      }
    >
      <Table>
        <thead>
          <tr>
            <th>{t('auth.email')}</th>
            <th>{t('settings.role')}</th>
            <th>{t('settings.totp')}</th>
            <th>{t('settings.lastLogin')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.data?.map((u) => (
            <tr key={u.id}>
              <td>
                {u.email} {u.disabled && <Badge tone="danger">{t('settings.disabled')}</Badge>}
              </td>
              <td>
                <Select
                  value={u.role}
                  onChange={(e) => void patch(`/users/${u.id}`, { role: e.target.value }).then(refresh)}
                >
                  {(['owner', 'editor', 'viewer'] as const).map((r) => (
                    <option key={r} value={r}>
                      {t(`settings.roles.${r}`)}
                    </option>
                  ))}
                </Select>
              </td>
              <td>{u.totpEnabled ? <Badge tone="ok">✓</Badge> : <Badge>–</Badge>}</td>
              <td>{fmtDateTime(u.lastLoginAt)}</td>
              <td className="space-x-1 whitespace-nowrap text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void post(`/users/${u.id}/reset-totp`).then(refresh)}
                >
                  {t('settings.resetTotp')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void patch(`/users/${u.id}`, { disabled: !u.disabled }).then(refresh)}
                >
                  {t('settings.disabled')}: {u.disabled ? t('app.yes') : t('app.no')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(u)}>
                  {t('app.delete')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Dialog open={adding} title={t('settings.addUser')} onClose={() => setAdding(false)}>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label={t('auth.email')}>
            <Input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <Field label={t('auth.password')} hint={t('auth.passwordHint')}>
            <Input
              type="password"
              minLength={12}
              required
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>
          <Field label={t('settings.role')}>
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {(['owner', 'editor', 'viewer'] as const).map((r) => (
                <option key={r} value={r}>
                  {t(`settings.roles.${r}`)}
                </option>
              ))}
            </Select>
          </Field>
          <ErrorText error={create.error} />
          <Button type="submit">{t('app.create')}</Button>
        </form>
      </Dialog>
      <ConfirmDialog
        open={!!confirm}
        title={t('app.delete')}
        body={`${t('app.confirmDelete')} ${confirm?.email ?? ''}`}
        confirmLabel={t('app.delete')}
        cancelLabel={t('app.cancel')}
        onClose={() => setConfirm(null)}
        onConfirm={() => void del(`/users/${confirm!.id}`).then(() => (setConfirm(null), refresh()))}
      />
    </Card>
  );
}

function TokensCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const tokens = useQuery({
    queryKey: ['api-tokens'],
    queryFn: () =>
      get<
        { id: string; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }[]
      >('/api-tokens'),
  });
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  return (
    <Card title={t('settings.apiTokens')}>
      <form
        className="mb-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void post<{ token: string }>('/api-tokens', { name }).then((r) => {
            setCreated(r.token);
            setName('');
            void qc.invalidateQueries({ queryKey: ['api-tokens'] });
          });
        }}
      >
        <Input
          placeholder={t('settings.tokenName')}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="max-w-xs"
        />
        <Button type="submit">{t('settings.createToken')}</Button>
      </form>
      {created && (
        <p className="mb-3 rounded-md bg-ok/10 p-2 text-sm">
          {t('settings.tokenCreated')} <code className="select-all break-all">{created}</code>
        </p>
      )}
      <Table>
        <tbody>
          {tokens.data?.map((tk) => (
            <tr key={tk.id}>
              <td>{tk.name}</td>
              <td>{fmtDateTime(tk.createdAt)}</td>
              <td>{fmtDateTime(tk.lastUsedAt)}</td>
              <td className="text-right">
                {tk.revokedAt ? (
                  <Badge>{t('settings.revoked')}</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void del(`/api-tokens/${tk.id}`).then(() =>
                        qc.invalidateQueries({ queryKey: ['api-tokens'] }),
                      )
                    }
                  >
                    {t('settings.revoke')}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function AccountCard() {
  const { t } = useTranslation();
  const [form, setForm] = useState({ current: '', next: '' });
  const m = useMutation({
    mutationFn: () => post('/me/password', form),
    onSuccess: () => setForm({ current: '', next: '' }),
  });
  return (
    <Card title={t('settings.changePassword')}>
      <form
        className="max-w-sm space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label={t('settings.currentPassword')}>
          <Input
            type="password"
            required
            value={form.current}
            onChange={(e) => setForm({ ...form, current: e.target.value })}
          />
        </Field>
        <Field label={t('settings.newPassword')} hint={t('auth.passwordHint')}>
          <Input
            type="password"
            minLength={12}
            required
            value={form.next}
            onChange={(e) => setForm({ ...form, next: e.target.value })}
          />
        </Field>
        <ErrorText error={m.error} />
        {m.isSuccess && <p className="text-sm text-ok">{t('app.saved')}</p>}
        <Button type="submit">{t('app.save')}</Button>
      </form>
    </Card>
  );
}
