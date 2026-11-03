// Page components; placeholders are replaced as milestones land.
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout';

function Placeholder({ title }: { title: string }) {
  const { t } = useTranslation();
  return <PageHeader title={t(title)} />;
}

export const pages = {
  Dashboard: () => <Placeholder title="nav.dashboard" />,
  Videos: () => <Placeholder title="nav.videos" />,
  VideoDetail: () => <Placeholder title="nav.videos" />,
  Upload: () => <Placeholder title="nav.upload" />,
  LinkDetail: () => <Placeholder title="nav.videos" />,
  Analytics: () => <Placeholder title="nav.analytics" />,
  Sessions: () => <Placeholder title="nav.sessions" />,
  SessionDetail: () => <Placeholder title="nav.sessions" />,
  Visitors: () => <Placeholder title="nav.visitors" />,
  VisitorDetail: () => <Placeholder title="nav.visitors" />,
  System: () => <Placeholder title="nav.system" />,
};
