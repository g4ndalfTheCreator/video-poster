// Page components; placeholders are replaced as milestones land.
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/layout';
import { VideosPage } from './videos';
import { VideoDetailPage } from './video-detail';
import { UploadPage } from './upload';

function Placeholder({ title }: { title: string }) {
  const { t } = useTranslation();
  return <PageHeader title={t(title)} />;
}

export const pages = {
  Dashboard: () => <Placeholder title="nav.dashboard" />,
  Videos: VideosPage,
  VideoDetail: VideoDetailPage,
  Upload: UploadPage,
  LinkDetail: () => <Placeholder title="nav.videos" />,
  Analytics: () => <Placeholder title="nav.analytics" />,
  Sessions: () => <Placeholder title="nav.sessions" />,
  SessionDetail: () => <Placeholder title="nav.sessions" />,
  Visitors: () => <Placeholder title="nav.visitors" />,
  VisitorDetail: () => <Placeholder title="nav.visitors" />,
  System: () => <Placeholder title="nav.system" />,
};
