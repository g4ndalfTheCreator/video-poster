import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Page } from '@vs/shared';
import { get, qs } from '../lib/api';
import { Checkbox, Input, Select } from './ui';

export interface FilterValue {
  from?: string;
  to?: string;
  videoId?: string;
  linkId?: string;
  hideBots?: boolean;
}

/** Filter row: date range, video, link, hide bots. All values live in the URL. */
export function FilterBar({
  value,
  onChange,
  showLink = true,
  showBots = true,
}: {
  value: FilterValue;
  onChange: (v: FilterValue) => void;
  showLink?: boolean;
  showBots?: boolean;
}) {
  const { t } = useTranslation();
  const videos = useQuery({
    queryKey: ['videos-all'],
    queryFn: () => get<Page<{ id: string; title: string }>>('/videos?pageSize=200&sort=title&dir=asc'),
  });
  const links = useQuery({
    queryKey: ['links-of', value.videoId],
    queryFn: () =>
      get<Page<{ id: string; label: string }>>(
        `/videos/${value.videoId}/links${qs({ pageSize: 200, sort: 'label', dir: 'asc' })}`,
      ),
    enabled: !!value.videoId && showLink,
  });
  return (
    <div className="mb-4 flex flex-wrap items-end gap-2">
      <label className="text-xs text-muted-fg">
        {t('an.from')}
        <Input
          type="date"
          value={value.from ?? ''}
          onChange={(e) => onChange({ ...value, from: e.target.value || undefined })}
          className="mt-0.5 w-40"
        />
      </label>
      <label className="text-xs text-muted-fg">
        {t('an.to')}
        <Input
          type="date"
          value={value.to ?? ''}
          onChange={(e) => onChange({ ...value, to: e.target.value || undefined })}
          className="mt-0.5 w-40"
        />
      </label>
      <label className="text-xs text-muted-fg">
        {t('an.video')}
        <Select
          value={value.videoId ?? ''}
          onChange={(e) => onChange({ ...value, videoId: e.target.value || undefined, linkId: undefined })}
          className="mt-0.5 block max-w-56"
        >
          <option value="">{t('an.allVideos')}</option>
          {videos.data?.items.map((v) => (
            <option key={v.id} value={v.id}>
              {v.title}
            </option>
          ))}
        </Select>
      </label>
      {showLink && value.videoId && (
        <label className="text-xs text-muted-fg">
          {t('an.link')}
          <Select
            value={value.linkId ?? ''}
            onChange={(e) => onChange({ ...value, linkId: e.target.value || undefined })}
            className="mt-0.5 block max-w-56"
          >
            <option value="">{t('an.allLinks')}</option>
            {links.data?.items.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </Select>
        </label>
      )}
      {showBots && (
        <div className="pb-2">
          <Checkbox
            label={t('an.hideBots')}
            checked={value.hideBots !== false}
            onChange={(v) => onChange({ ...value, hideBots: v })}
          />
        </div>
      )}
    </div>
  );
}
