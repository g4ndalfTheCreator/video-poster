import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { Chapter, Cta, VideoStatus } from '@vs/shared';
import { api, del, get, patch, post } from '../lib/api';
import { can, useMe } from '../lib/auth';
import { fmtBytes, fmtDateTime, fmtDuration } from '../lib/format';
import { useSse } from '../lib/sse';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  ErrorText,
  Field,
  Input,
  Table,
  Tabs,
  Textarea,
} from '../components/ui';
import { PageHeader } from '../components/layout';
import { HlsPlayer, type PlayerHandle } from '../components/hls-player';
import { StatusBadge } from './videos';
import { tabs } from './video-tabs';

export interface VideoDetail {
  id: string;
  title: string;
  description: string;
  status: VideoStatus;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  hlsVersion: number;
  posterAtMs: number | null;
  autoplayMuted: boolean;
  storyMode: boolean;
  chapters: Chapter[];
  loudnorm: boolean;
  ctaConfig: Cta[];
  error: string | null;
  originalSha256: string | null;
  originalSizeBytes: number | null;
  createdAt: string;
  renditions: { height: number; width: number; bitrateKbps: number; sizeBytes: number }[];
  assets: {
    id: string;
    kind: string;
    mime: string;
    sizeBytes: number;
    lang: string | null;
    label: string | null;
    filename: string | null;
  }[];
  jobs: {
    id: string;
    state: string;
    progressPct: number;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  }[];
  linkCount: number;
  preview: { master: string; poster: string; sprite: string; spriteVtt: string } | null;
}

type Tab = 'details' | 'links' | 'analytics';

export function VideoDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams({ from: '/videos/$id' });
  const search = useSearch({ from: '/videos/$id' });
  const navigate = useNavigate({ from: '/videos/$id' });
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['video', id], queryFn: () => get<VideoDetail>(`/videos/${id}`) });
  const [progress, setProgress] = useState<number | null>(null);
  useSse(`/videos/${id}/events`, 'video', (raw) => {
    const e = raw as { type: string; progressPct?: number };
    if (e.type === 'progress') setProgress(e.progressPct ?? null);
    else {
      setProgress(null);
      void qc.invalidateQueries({ queryKey: ['video', id] });
    }
  });
  const v = q.data;
  if (!v) return <ErrorText error={q.error} />;
  const tab = (search.tab ?? 'details') as Tab;
  const Links = tabs.Links;
  const Analytics = tabs.Analytics;
  return (
    <>
      <PageHeader title={v.title}>
        <div className="mt-1 flex items-center gap-2 text-sm text-muted-fg">
          <StatusBadge status={v.status} /> {fmtDuration(v.durationMs)} · {v.width}×{v.height}
        </div>
      </PageHeader>
      <Tabs
        value={tab}
        onChange={(tb) => void navigate({ search: { ...search, tab: tb } })}
        items={[
          { value: 'details', label: t('video.details') },
          { value: 'links', label: `${t('video.links')} (${v.linkCount})` },
          { value: 'analytics', label: t('video.analytics') },
        ]}
      />
      <div className="mt-4">
        {tab === 'details' && (
          <DetailsTab v={v} progress={progress} seekTo={search.t ? Number(search.t) : undefined} />
        )}
        {tab === 'links' && <Links video={v} />}
        {tab === 'analytics' && <Analytics videoId={v.id} />}
      </div>
    </>
  );
}

function DetailsTab({ v, progress, seekTo }: { v: VideoDetail; progress: number | null; seekTo?: number }) {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const player = useRef<PlayerHandle>(null);
  useEffect(() => {
    if (seekTo !== undefined) setTimeout(() => player.current?.seek(seekTo), 500);
  }, [seekTo]);
  const editor = can(me, 'editor');
  const refresh = () => qc.invalidateQueries({ queryKey: ['video', v.id] });
  const [form, setForm] = useState({
    title: v.title,
    description: v.description,
    autoplayMuted: v.autoplayMuted,
    loudnorm: v.loudnorm,
    ctaConfig: v.ctaConfig,
    storyMode: v.storyMode,
    chapters: v.chapters,
  });
  const [confirm, setConfirm] = useState<'delete' | 'purge' | null>(null);
  useEffect(
    () =>
      setForm({
        title: v.title,
        description: v.description,
        autoplayMuted: v.autoplayMuted,
        loudnorm: v.loudnorm,
        ctaConfig: v.ctaConfig,
        storyMode: v.storyMode,
        chapters: v.chapters,
      }),
    [v],
  );
  const save = useMutation({
    mutationFn: () =>
      patch(`/videos/${v.id}`, { ...form, chapters: form.chapters.filter((c) => c.title.trim()) }),
    onSuccess: refresh,
  });
  const retranscode = useMutation({
    mutationFn: () => post(`/videos/${v.id}/retranscode`),
    onSuccess: refresh,
  });
  const captions = v.assets.filter((a) => a.kind === 'captions');
  const attachments = v.assets.filter((a) => a.kind === 'attachment');
  const running = v.jobs.find((j) => j.state === 'running' || j.state === 'queued');

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-4">
        <Card>
          {v.preview ? (
            <HlsPlayer
              ref={player}
              src={v.preview.master}
              poster={`${v.preview.poster}?t=${v.posterAtMs ?? 0}`}
              captions={captions.map((c) => ({
                src: `/api/admin/videos/${v.id}/assets/${c.id}/file`,
                lang: c.lang ?? 'und',
                label: c.label ?? c.lang ?? '',
              }))}
            />
          ) : (
            <p className="text-sm text-muted-fg">{t('video.notReady')}</p>
          )}
          {v.error && (
            <p className="mt-2 text-sm text-danger">
              {t('video.error')}: {v.error}
            </p>
          )}
          {editor && v.preview && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{t('video.posterTitle')}:</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void post(`/videos/${v.id}/poster`, { atMs: player.current?.currentTimeMs() ?? 0 }).then(
                    refresh,
                  )
                }
              >
                {t('video.posterFromTime')}
              </Button>
              <FileButton
                label={t('video.posterUpload')}
                accept="image/jpeg,image/png,image/webp"
                onFile={async (f) => {
                  const fd = new FormData();
                  fd.append('file', f);
                  await api(`/videos/${v.id}/poster`, { method: 'POST', body: fd });
                  await refresh();
                }}
              />
            </div>
          )}
        </Card>
        <Card
          title={t('video.jobs')}
          actions={
            editor && (
              <Button
                size="sm"
                variant="secondary"
                disabled={!!running || retranscode.isPending}
                onClick={() => retranscode.mutate()}
              >
                {t('video.retranscode')}
              </Button>
            )
          }
        >
          {running && (
            <progress className="mb-3 h-2 w-full" max={100} value={progress ?? running.progressPct} />
          )}
          <ErrorText error={retranscode.error} />
          <Table>
            <tbody>
              {v.jobs.map((j) => (
                <tr key={j.id}>
                  <td>{fmtDateTime(j.createdAt)}</td>
                  <td>
                    <Badge tone={j.state === 'done' ? 'ok' : j.state === 'failed' ? 'danger' : 'info'}>
                      {j.state}
                    </Badge>
                  </td>
                  <td className="max-w-xs truncate text-xs text-danger" title={j.error ?? ''}>
                    {j.error}
                  </td>
                  <td className="text-right">
                    {editor && j.state !== 'queued' && (
                      <a
                        className="text-xs underline"
                        href={`/api/admin/videos/${v.id}/jobs/${j.id}/log`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('video.log')}
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-3 text-xs text-muted-fg">
            {t('video.renditions')}:{' '}
            {v.renditions
              .map((r) => `${r.height}p ${r.bitrateKbps} kbps (${fmtBytes(r.sizeBytes)})`)
              .join(' · ') || '–'}
            <br />
            {t('video.original')}: {fmtBytes(v.originalSizeBytes)} · sha256{' '}
            <code className="break-all">{v.originalSha256?.slice(0, 16)}…</code>
          </div>
        </Card>
      </div>
      <div className="space-y-4">
        <Card title={t('video.details')}>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <fieldset disabled={!editor} className="space-y-3">
              <Field label={t('videos.name')}>
                <Input
                  value={form.title}
                  required
                  maxLength={200}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </Field>
              <Field label={t('video.description')}>
                <Textarea
                  value={form.description}
                  rows={4}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </Field>
              <Checkbox
                label={t('video.autoplayMuted')}
                checked={form.autoplayMuted}
                onChange={(x) => setForm({ ...form, autoplayMuted: x })}
              />
              <Checkbox
                label={t('video.loudnorm')}
                checked={form.loudnorm}
                onChange={(x) => setForm({ ...form, loudnorm: x })}
              />
              <CtaEditor
                value={form.ctaConfig}
                onChange={(ctaConfig) => setForm({ ...form, ctaConfig })}
                title={t('video.cta')}
              />
              <div className="space-y-2 rounded-md border border-border p-3">
                <Checkbox
                  label={t('story.mode')}
                  checked={form.storyMode}
                  onChange={(x) => setForm({ ...form, storyMode: x })}
                />
                <p className="text-xs text-muted-fg">{t('story.modeHint')}</p>
                <ChapterEditor
                  value={form.chapters}
                  onChange={(chapters) => setForm({ ...form, chapters })}
                  currentMs={() => player.current?.currentTimeMs() ?? 0}
                />
              </div>
            </fieldset>
            <ErrorText error={save.error} />
            {editor && (
              <div className="flex gap-2">
                <Button type="submit" disabled={save.isPending}>
                  {t('app.save')}
                </Button>
                {save.isSuccess && <span className="self-center text-sm text-ok">{t('app.saved')}</span>}
              </div>
            )}
          </form>
        </Card>
        <AssetsCard
          videoId={v.id}
          title={t('video.captions')}
          kind="captions"
          items={captions}
          editor={editor}
          onChange={refresh}
        />
        <AssetsCard
          videoId={v.id}
          title={t('video.attachments')}
          kind="attachment"
          items={attachments}
          editor={editor}
          onChange={refresh}
        />
        {editor && (
          <div className="flex flex-wrap gap-2">
            {v.status === 'ready' && (
              <Button
                variant="secondary"
                onClick={() => void patch(`/videos/${v.id}`, { status: 'archived' }).then(refresh)}
              >
                {t('videos.archive')}
              </Button>
            )}
            {v.status === 'archived' && (
              <Button
                variant="secondary"
                onClick={() => void patch(`/videos/${v.id}`, { status: 'ready' }).then(refresh)}
              >
                {t('videos.unarchive')}
              </Button>
            )}
            <Button variant="danger" onClick={() => setConfirm('delete')}>
              {t('video.delete')}
            </Button>
            {can(me, 'owner') && (
              <Button variant="ghost" onClick={() => setConfirm('purge')}>
                {t('video.purge')}
              </Button>
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={!!confirm}
        title={confirm === 'purge' ? t('video.purge') : t('video.delete')}
        body={confirm === 'purge' ? t('app.confirmDelete') : t('videos.deleteBody')}
        confirmLabel={t('app.delete')}
        cancelLabel={t('app.cancel')}
        onClose={() => setConfirm(null)}
        onConfirm={() =>
          void del(`/videos/${v.id}${confirm === 'purge' ? '?purge=true' : ''}`).then(() => {
            setConfirm(null);
            void qc.invalidateQueries({ queryKey: ['videos'] });
            void navigate({ to: '/videos', search: { page: 1 } });
          })
        }
      />
    </div>
  );
}

function mmss(ms: number) {
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
function parseMmss(v: string): number | null {
  const m = /^(\d+):([0-5]?\d)$/.exec(v.trim());
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 1000;
  return /^\d+$/.test(v.trim()) ? Number(v) * 1000 : null;
}

/** Chapter list (mm:ss + title) for the story-mode progress bar. */
export function ChapterEditor({
  value,
  onChange,
  currentMs,
}: {
  value: Chapter[];
  onChange: (v: Chapter[]) => void;
  currentMs: () => number;
}) {
  const { t } = useTranslation();
  const sorted = (c: Chapter[]) => [...c].sort((a, b) => a.atMs - b.atMs);
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{t('story.chapters')}</div>
      {value.map((c, i) => (
        <div key={`${i}-${c.atMs}`} className="flex gap-2">
          <Input
            aria-label="mm:ss"
            className="w-20 tabular-nums"
            defaultValue={mmss(c.atMs)}
            onBlur={(e) => {
              const ms = parseMmss(e.target.value);
              if (ms !== null) onChange(sorted(value.map((x, j) => (j === i ? { ...x, atMs: ms } : x))));
            }}
          />
          <Input
            placeholder={t('story.chapterTitle')}
            value={c.title}
            maxLength={80}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            aria-label={t('app.delete')}
          >
            ✕
          </Button>
        </div>
      ))}
      {value.length < 20 && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() =>
            onChange(sorted([...value, { atMs: Math.round(currentMs() / 1000) * 1000, title: '' }]))
          }
        >
          {t('story.addChapter')}
        </Button>
      )}
    </div>
  );
}

export function CtaEditor({
  value,
  onChange,
  title,
}: {
  value: Cta[];
  onChange: (v: Cta[]) => void;
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{title}</div>
      {value.map((c, i) => (
        <div key={i} className="flex gap-2">
          <Input
            placeholder={t('video.ctaLabel')}
            value={c.label}
            maxLength={60}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
          />
          <Input
            placeholder="https://…"
            value={c.href}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, href: e.target.value } : x)))}
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            aria-label={t('app.delete')}
          >
            ✕
          </Button>
        </div>
      ))}
      {value.length < 3 && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => onChange([...value, { id: `cta${Date.now().toString(36)}`, label: '', href: '' }])}
        >
          {t('video.addCta')}
        </Button>
      )}
    </div>
  );
}

function FileButton({
  label,
  accept,
  onFile,
}: {
  label: string;
  accept: string;
  onFile: (f: File) => Promise<void>;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<unknown>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f).catch(setErr);
          e.target.value = '';
        }}
      />
      <Button size="sm" variant="secondary" type="button" onClick={() => ref.current?.click()}>
        {label}
      </Button>
      <ErrorText error={err} />
    </>
  );
}

function AssetsCard({
  videoId,
  title,
  kind,
  items,
  editor,
  onChange,
}: {
  videoId: string;
  title: string;
  kind: 'captions' | 'attachment';
  items: VideoDetail['assets'];
  editor: boolean;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const [lang, setLang] = useState('fi');
  const [label, setLabel] = useState('');
  return (
    <Card title={title}>
      <ul className="mb-3 space-y-1 text-sm">
        {items.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-2">
            <a
              className="truncate hover:underline"
              href={`/api/admin/videos/${videoId}/assets/${a.id}/file`}
              target="_blank"
              rel="noreferrer"
            >
              {a.lang ? <Badge>{a.lang}</Badge> : null} {a.label ?? a.filename}{' '}
              <span className="text-xs text-muted-fg">({fmtBytes(a.sizeBytes)})</span>
            </a>
            {editor && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void del(`/videos/${videoId}/assets/${a.id}`).then(onChange)}
              >
                {t('app.delete')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {editor && (
        <div className="flex flex-wrap items-end gap-2">
          {kind === 'captions' && (
            <Field label={t('video.captionLang')}>
              <Input value={lang} onChange={(e) => setLang(e.target.value)} className="w-24" />
            </Field>
          )}
          <Field label={t('video.captionLabel')}>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} className="w-40" />
          </Field>
          <FileButton
            label={t('video.addFile')}
            accept={kind === 'captions' ? '.vtt,.srt,text/vtt' : '.pdf,.doc,.docx,.txt,.png,.jpg,.jpeg,.zip'}
            onFile={async (f) => {
              const fd = new FormData();
              fd.append('kind', kind);
              fd.append('lang', lang);
              fd.append('label', label);
              fd.append('file', f);
              await api(`/videos/${videoId}/assets`, { method: 'POST', body: fd });
              setLabel('');
              onChange();
            }}
          />
        </div>
      )}
    </Card>
  );
}
