// Links and analytics tabs of the video page.
import { LinksTab } from './links';
import { VideoAnalyticsView } from './video-analytics';

export const tabs = {
  Links: LinksTab,
  Analytics: ({ videoId }: { videoId: string }) => <VideoAnalyticsView videoId={videoId} filters={{}} />,
};
