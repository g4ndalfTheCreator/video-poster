import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { ApiError, get, post, setCsrf } from '../lib/api';
import type { Me } from '../lib/auth';
import { Button, Card, Field, Input } from '../components/ui';

function useErrorText() {
  const { t } = useTranslation();
  return (e: unknown) => {
    if (e instanceof ApiError) return t(`auth.errors.${e.code}`, { defaultValue: e.message });
    return e instanceof Error ? e.message : String(e);
  };
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <Card title={title}>{children}</Card>
      </div>
    </main>
  );
}

export function AuthScreen({ me }: { me: Me | null }) {
  const state = useQuery({
    queryKey: ['auth-state'],
    queryFn: () => get<{ bootstrapRequired: boolean }>('/auth/state'),
  });
  if (me?.stage === 'pending_totp') return <TotpForm />;
  if (me?.stage === 'enroll_required') return <EnrollForm />;
  if (state.data?.bootstrapRequired) return <BootstrapForm />;
  return <LoginForm />;
}

function LoginForm() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errText = useErrorText();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ csrfToken: string }>('/auth/login', { email, password });
      setCsrf(r.csrfToken);
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title={t('auth.title')}>
      <form onSubmit={submit} className="space-y-3">
        <Field label={t('auth.email')}>
          <Input
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label={t('auth.password')}>
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy} className="w-full">
          {t('auth.login')}
        </Button>
      </form>
    </Shell>
  );
}

function CodeForm({
  onSubmit,
  children,
  title,
}: {
  onSubmit: (code: string) => Promise<void>;
  children?: React.ReactNode;
  title: string;
}) {
  const { t } = useTranslation();
  const errText = useErrorText();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await onSubmit(code);
    } catch (err) {
      setError(errText(err));
      setCode('');
    }
  };
  return (
    <Shell title={title}>
      <form onSubmit={submit} className="space-y-3">
        {children}
        <Field label={t('auth.code')}>
          <Input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full">
          {t('auth.verify')}
        </Button>
      </form>
    </Shell>
  );
}

function TotpForm() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  return (
    <CodeForm
      title={t('auth.totpTitle')}
      onSubmit={async (code) => {
        await post('/auth/totp', { code });
        await qc.invalidateQueries({ queryKey: ['me'] });
      }}
    >
      <p className="text-sm text-muted-fg">{t('auth.totpPrompt')}</p>
    </CodeForm>
  );
}

function EnrollForm() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [data, setData] = useState<{ secret: string; otpauthUrl: string; qr: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void post<{ secret: string; otpauthUrl: string }>('/auth/totp/enroll').then(async (r) => {
      const qr = await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 200 });
      if (!cancelled) setData({ ...r, qr });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <CodeForm
      title={t('auth.enrollTitle')}
      onSubmit={async (code) => {
        await post('/auth/totp/enroll/confirm', { code });
        await qc.invalidateQueries({ queryKey: ['me'] });
      }}
    >
      <p className="text-sm text-muted-fg">{t('auth.enrollPrompt')}</p>
      {data && (
        <div className="space-y-2 text-center">
          <img
            src={data.qr}
            alt="TOTP QR"
            className="mx-auto rounded bg-white p-1"
            width={200}
            height={200}
          />
          <div className="text-xs text-muted-fg">
            {t('auth.secret')}:{' '}
            <code data-testid="totp-secret" className="select-all break-all">
              {data.secret}
            </code>
          </div>
        </div>
      )}
    </CodeForm>
  );
}

function BootstrapForm() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errText = useErrorText();
  const [form, setForm] = useState({ token: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await post<{ csrfToken: string }>('/auth/bootstrap', form);
      setCsrf(r.csrfToken);
      await qc.invalidateQueries();
    } catch (err) {
      setError(errText(err));
    }
  };
  return (
    <Shell title={t('auth.bootstrapTitle')}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-muted-fg">{t('auth.bootstrapPrompt')}</p>
        <Field label={t('auth.bootstrapToken')}>
          <Input
            name="token"
            required
            value={form.token}
            onChange={(e) => setForm({ ...form, token: e.target.value.trim() })}
          />
        </Field>
        <Field label={t('auth.email')}>
          <Input
            name="email"
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
        <Field label={t('auth.password')} hint={t('auth.passwordHint')}>
          <Input
            name="password"
            type="password"
            minLength={12}
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full">
          {t('auth.createOwner')}
        </Button>
      </form>
    </Shell>
  );
}
