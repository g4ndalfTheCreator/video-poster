import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, post, setReauthHandler } from '../lib/api';
import type { Me } from '../lib/auth';
import { Button, Dialog, ErrorText, Field, Input } from './ui';

/**
 * Password (+ TOTP) prompt for sensitive actions. Registered as the api client's reauth handler, so
 * any request answered with `reauth_required` opens this dialog and is retried after confirmation.
 */
export function ReauthDialog({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    setReauthHandler(
      () =>
        new Promise<boolean>((resolve) => {
          pending.current?.(false);
          pending.current = resolve;
          setPassword('');
          setCode('');
          setError(null);
          setOpen(true);
        }),
    );
    return () => setReauthHandler(null);
  }, []);

  const finish = (ok: boolean) => {
    pending.current?.(ok);
    pending.current = null;
    setOpen(false);
  };

  return (
    <Dialog open={open} title={t('reauth.title')} onClose={() => finish(false)}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await post('/auth/reauth', { password, ...(me.totpEnabled ? { code } : {}) });
            finish(true);
          } catch (err) {
            if (err instanceof ApiError && err.status === 429) window.location.reload();
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-sm text-muted-fg">{t('reauth.body')}</p>
        <Field label={t('auth.password')}>
          <Input
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {me.totpEnabled && (
          <Field label={t('auth.code')}>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
        )}
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => finish(false)}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {t('reauth.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
