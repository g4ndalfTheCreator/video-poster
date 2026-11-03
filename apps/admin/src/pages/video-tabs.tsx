// Links (M3) and analytics (M5) tabs of the video page.
import type { VideoDetail } from './video-detail';

export const tabs = {
  Links: (_p: { video: VideoDetail }) => null,
  Analytics: (_p: { videoId: string }) => null,
};
