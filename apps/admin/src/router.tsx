import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useMe } from './lib/auth';
import { listSearch, str, type ListSearch } from './lib/search';
import { Layout } from './components/layout';
import { AuthScreen } from './pages/auth';
import { AuditPage } from './pages/audit';
import { SettingsPage } from './pages/settings';
import { pages } from './pages/registry';

function Root() {
  const { t } = useTranslation();
  const me = useMe();
  if (me.isLoading) return <div className="p-8 text-sm text-muted-fg">{t('app.loading')}</div>;
  if (!me.data || me.data.stage !== 'full') return <AuthScreen me={me.data ?? null} />;
  return (
    <Layout me={me.data}>
      <Outlet />
    </Layout>
  );
}

const rootRoute = createRootRoute({ component: Root });

type Opt<T> = { [K in keyof T]?: T[K] };
interface VideoSearch {
  tab?: string;
  from?: string;
  to?: string;
  link?: string;
}
interface AnalyticsSearch {
  from?: string;
  to?: string;
  videoId?: string;
  linkId?: string;
  hideBots?: boolean;
  view?: string;
}
type VideosSearch = ListSearch & { status?: string };
type SessionsSearch = ListSearch &
  Opt<{
    from: string;
    to: string;
    videoId: string;
    linkId: string;
    visitorId: string;
    country: string;
    device: string;
    ip: string;
    hideBots: boolean;
  }>;

const noSearch = () => ({});
const r = <P extends string, S extends object = Record<string, never>>(
  path: P,
  component: () => React.ReactNode,
  validateSearch: (s: Record<string, unknown>) => S = noSearch as () => S,
) => createRoute({ getParentRoute: () => rootRoute, path, component, validateSearch });

const routeTree = rootRoute.addChildren([
  r('/', pages.Dashboard, (s): { days?: number } => ({ days: Number(s.days) || undefined })),
  r('/videos', pages.Videos, (s): VideosSearch => ({ ...listSearch(s), status: str(s.status) })),
  r('/videos/$id', pages.VideoDetail, (s): VideoSearch => ({
    tab: str(s.tab) ?? 'details',
    from: str(s.from),
    to: str(s.to),
    link: str(s.link),
  })),
  r('/upload', pages.Upload),
  r('/links/$id', pages.LinkDetail),
  r('/analytics', pages.Analytics, (s): AnalyticsSearch => ({
    from: str(s.from),
    to: str(s.to),
    videoId: str(s.videoId),
    linkId: str(s.linkId),
    hideBots: s.hideBots !== 'false' && s.hideBots !== false,
    view: str(s.view) ?? 'overview',
  })),
  r('/sessions', pages.Sessions, (s): SessionsSearch => ({
    ...listSearch(s),
    from: str(s.from),
    to: str(s.to),
    videoId: str(s.videoId),
    linkId: str(s.linkId),
    visitorId: str(s.visitorId),
    country: str(s.country),
    device: str(s.device),
    ip: str(s.ip),
    hideBots: s.hideBots !== 'false' && s.hideBots !== false,
  })),
  r('/sessions/$id', pages.SessionDetail),
  r('/visitors', pages.Visitors, (s) => listSearch(s)),
  r('/visitors/$id', pages.VisitorDetail),
  r('/settings', SettingsPage, (s): { tab?: string } => ({ tab: str(s.tab) })),
  r('/audit', AuditPage, (s) => listSearch(s)),
  r('/system', pages.System),
]);

export const router = createRouter({ routeTree, basepath: '/admin', defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
