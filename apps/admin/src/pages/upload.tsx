import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import Uppy from '@uppy/core';
import Tus from '@uppy/tus';
import Dashboard from '@uppy/react/dashboard';
import '@uppy/core/css/style.min.css';
import '@uppy/dashboard/css/style.min.css';
import { useMe } from '../lib/auth';
import { useSse } from '../lib/sse';
import { fmtBytes } from '../lib/format';
import { Card } from '../components/ui';
import { PageHeader } from '../components/layout';

interface Uploaded {
  videoId: string;
  name: string;
  status: string;
  progress: number;
}

export function UploadPage() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const [uploaded, setUploaded] = useState<Uploaded[]>([]);
  const [uppy] = useState(() =>
    new Uppy({ restrictions: { allowedFileTypes: ['video/*', '.mkv', '.mov'] }, autoProceed: false }).use(
      Tus,
      {
        endpoint: '/api/admin/uploads',
        chunkSize: 8 * 1024 * 1024,
        retryDelays: [0, 1000, 3000, 5000, 10000],
        removeFingerprintOnSuccess: true,
        withCredentials: true,
        onAfterResponse: (_req, res) => {
          const id = res.getHeader('x-video-id');
          if (id)
            setUploaded((u) =>
              u.some((x) => x.videoId === id)
                ? u
                : [...u, { videoId: id, name: '', status: 'processing', progress: 0 }],
            );
        },
      },
    ),
  );
  useEffect(() => {
    uppy.getPlugin('Tus')?.setOptions({ headers: { 'x-csrf-token': me?.csrfToken ?? '' } });
    uppy.on('file-added', (f) =>
      uppy.setFileMeta(f.id, { title: (f.name ?? 'video').replace(/\.[^.]+$/, ''), filename: f.name }),
    );
    return () => uppy.destroy();
  }, [uppy, me?.csrfToken]);
  useSse('/videos-events', 'video', (raw) => {
    const e = raw as { videoId: string; type: string; status?: string; progressPct?: number };
    setUploaded((list) =>
      list.map((u) =>
        u.videoId === e.videoId
          ? { ...u, status: e.status ?? u.status, progress: e.progressPct ?? u.progress }
          : u,
      ),
    );
  });
  return (
    <>
      <PageHeader title={t('upload.title')}>
        <p className="text-sm text-muted-fg">
          {t('upload.hint', { max: fmtBytes(2 * 1024 ** 3), minutes: 15 })}
        </p>
      </PageHeader>
      <Dashboard
        uppy={uppy}
        proudlyDisplayPoweredByUppy={false}
        width="100%"
        height={380}
        theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
      />
      {uploaded.length > 0 && (
        <Card title={t('upload.processing')} className="mt-4">
          <ul className="space-y-2">
            {uploaded.map((u) => (
              <li key={u.videoId} className="flex items-center gap-3 text-sm">
                <Link
                  to="/videos/$id"
                  params={{ id: u.videoId }}
                  search={{ tab: 'details' }}
                  className="w-48 truncate hover:underline"
                >
                  {u.videoId.slice(0, 8)}
                </Link>
                <progress max={100} value={u.status === 'ready' ? 100 : u.progress} className="h-2 flex-1" />
                <span className="w-24 text-right">
                  {t(`videos.statuses.${u.status}`, { defaultValue: u.status })}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
