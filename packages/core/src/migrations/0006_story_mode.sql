-- Story mode: full-viewport mobile flow (video → feedback → documents page).
ALTER TABLE videos ADD COLUMN story_mode boolean NOT NULL DEFAULT false;
-- [{ "atMs": 0, "title": "Kuka olen" }, ...] sorted by atMs
ALTER TABLE videos ADD COLUMN chapters jsonb NOT NULL DEFAULT '[]';
-- NULL = follow the video's setting
ALTER TABLE share_links ADD COLUMN story_mode boolean;

ALTER TABLE session_summaries ADD COLUMN reached_documents boolean NOT NULL DEFAULT false;
ALTER TABLE session_summaries ADD COLUMN documents_via text CHECK (documents_via IN ('swipe', 'ended', 'button'));

CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  session_id uuid NOT NULL UNIQUE REFERENCES view_sessions(id) ON DELETE CASCADE,
  link_id uuid NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  rating text NOT NULL CHECK (rating IN ('up', 'meh', 'down')),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);
CREATE INDEX feedback_video_idx ON feedback (video_id, created_at DESC);
CREATE INDEX feedback_link_idx ON feedback (link_id, created_at DESC);
