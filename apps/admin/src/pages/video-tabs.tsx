// Links and analytics tabs of the video page.
import { LinksTab } from './links';

export const tabs = {
  Links: LinksTab,
  Analytics: (_p: { videoId: string }) => null,
};
