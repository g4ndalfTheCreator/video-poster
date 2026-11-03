import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { post, setCsrf } from '../lib/api';
import { can, type Me } from '../lib/auth';
import { setLanguage } from '../i18n';
import { cn } from './ui';

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('vs.theme', next ? 'dark' : 'light');
    } catch {
      /* ignore */
    }
  };
  return { dark, toggle };
}

export function Layout({ me, children }: { me: Me; children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { dark, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const nav: { to: string; label: string; show: boolean }[] = [
    { to: '/', label: t('nav.dashboard'), show: true },
    { to: '/videos', label: t('nav.videos'), show: true },
    { to: '/upload', label: t('nav.upload'), show: can(me, 'editor') },
    { to: '/analytics', label: t('nav.analytics'), show: true },
    { to: '/sessions', label: t('nav.sessions'), show: true },
    { to: '/visitors', label: t('nav.visitors'), show: true },
    { to: '/settings', label: t('nav.settings'), show: true },
    { to: '/audit', label: t('nav.audit'), show: can(me, 'editor') },
    { to: '/system', label: t('nav.system'), show: can(me, 'editor') },
  ];
  const logout = async () => {
    await post('/auth/logout');
    setCsrf(null);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    qc.setQueryData(['me'], null);
  };
  return (
    <div className="min-h-screen md:flex">
      <aside
        className={cn(
          'border-border bg-card md:sticky md:top-0 md:h-screen md:w-56 md:shrink-0 md:border-r',
          'border-b md:border-b-0',
        )}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-semibold">{t('app.name')}</span>
          <button className="md:hidden" aria-label="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
            ☰
          </button>
        </div>
        <nav
          className={cn('space-y-0.5 px-2 pb-3', !open && 'hidden md:block')}
          onClick={() => setOpen(false)}
        >
          {nav
            .filter((n) => n.show)
            .map((n) => (
              <Link
                key={n.to}
                to={n.to}
                activeOptions={{ exact: n.to === '/' }}
                className="block rounded-md px-3 py-1.5 text-sm text-muted-fg hover:bg-muted hover:text-fg"
                activeProps={{ className: 'bg-muted !text-fg font-medium' }}
              >
                {n.label}
              </Link>
            ))}
          <div className="mt-4 space-y-1 border-t border-border px-3 pt-3 text-xs text-muted-fg">
            <div className="truncate" title={me.email}>
              {me.email} · {t(`settings.roles.${me.role}`)}
            </div>
            <div className="flex gap-3">
              <button onClick={toggle}>
                {dark ? '☀' : '☾'} {t('nav.theme')}
              </button>
              <button onClick={() => setLanguage(i18n.language === 'fi' ? 'en' : 'fi')}>
                {i18n.language === 'fi' ? 'EN' : 'FI'}
              </button>
              <button onClick={logout}>{t('nav.logout')}</button>
            </div>
          </div>
        </nav>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
    </div>
  );
}

export function PageHeader({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {children}
      </div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}
