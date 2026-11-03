import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import type { Cta, Page } from '@vs/shared';
import { del, get, patch, post, qs } from '../lib/api';
import { can, useMe } from '../lib/auth';
import { fmtDateTime, fmtNum, fmtPct, fmtRelative } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  Empty,
  ErrorText,
  Field,
  Input,
  Pager,
  Select,
  SortHeader,
  Table,
  Textarea,
} from '../components/ui';
import { CtaEditor, type VideoDetail } from './video-detail';

export interface LinkRow {
  id: string;
  videoId: string;
  videoTitle?: string;
  slug: string;
  url: string;
  label: string;
  recipientName: string | null;
  recipientOrg: string | null;
  note: string | null;
  hasPassword: boolean;
  expiresAt: string | null;
  maxSessions: number | null;
  isActive: boolean;
  allowDownload: boolean;
  allowEmbed: boolean;
  notifyOnOpen: boolean;
  notifyEveryOpen: boolean;
  ctaConfig: Cta[] | null;
  storyMode: boolean | null;
  sessions: number;
  maxCompletion: number | null;
  previews: number;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  createdAt: string;
  state: 'active' | 'closed' | 'expired' | 'exhausted';
}

export function LinkStateBadge({ state }: { state: LinkRow['state'] }) {
  const { t } = useTranslation();
  return (
    <Badge tone={state === 'active' ? 'ok' : state === 'closed' ? 'neutral' : 'warn'}>
      {t(`links.states.${state}`)}
    </Badge>
  );
}

export function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? t('app.copied') : t('app.copy')}
    </Button>
  );
}

export function LinksTab({ video }: { video: VideoDetail }) {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const editor = can(me, 'editor');
  const [search, setSearch] = useState({ page: 1, sort: 'createdAt', dir: 'desc' as 'asc' | 'desc', q: '' });
  const key = ['links', video.id, search];
  const q = useQuery({
    queryKey: key,
    queryFn: () => get<Page<LinkRow>>(`/videos/${video.id}/links${qs({ ...search, pageSize: 25 })}`),
  });
  const [editing, setEditing] = useState<LinkRow | 'new' | null>(null);
  const [bulk, setBulk] = useState(false);
  const [qr, setQr] = useState<LinkRow | null>(null);
  const [deleting, setDeleting] = useState<LinkRow | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['links', video.id] });

  // Optimistic open/close toggle
  const toggle = useMutation({
    mutationFn: (l: LinkRow) => patch(`/links/${l.id}`, { isActive: !l.isActive }),
    onMutate: async (l) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<Page<LinkRow>>(key);
      qc.setQueryData<Page<LinkRow>>(key, (p) =>
        p
          ? {
              ...p,
              items: p.items.map((x) =>
                x.id === l.id ? { ...x, isActive: !l.isActive, state: l.isActive ? 'closed' : 'active' } : x,
              ),
            }
          : p,
      );
      return { prev };
    },
    onError: (_e, _l, c) => c?.prev && qc.setQueryData(key, c.prev),
    onSettled: refresh,
  });

  const sortBy = (f: string) =>
    setSearch((s) => ({ ...s, page: 1, sort: f, dir: s.sort === f && s.dir === 'desc' ? 'asc' : 'desc' }));
  return (
    <Card
      title={t('links.title')}
      actions={
        editor && (
          <>
            <Button size="sm" variant="secondary" onClick={() => setBulk(true)}>
              {t('links.bulk')}
            </Button>
            <Button size="sm" onClick={() => setEditing('new')}>
              {t('links.new')}
            </Button>
          </>
        )
      }
    >
      {editor && <QuickCreate videoId={video.id} onCreated={refresh} />}
      <Input
        placeholder={t('app.search')}
        className="my-3 max-w-xs"
        value={search.q}
        onChange={(e) => setSearch({ ...search, q: e.target.value, page: 1 })}
      />
      {q.data?.items.length === 0 ? (
        <Empty>{t('links.empty')}</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <SortHeader
                label={t('links.label')}
                field="label"
                sort={search.sort}
                dir={search.dir}
                onSort={sortBy}
              />
              <SortHeader
                label={t('links.recipient')}
                field="recipient"
                sort={search.sort}
                dir={search.dir}
                onSort={sortBy}
              />
              <th>{t('links.slug')}</th>
              <th>{t('links.state')}</th>
              <SortHeader
                label={t('links.expires')}
                field="expires"
                sort={search.sort}
                dir={search.dir}
                onSort={sortBy}
              />
              <SortHeader
                label={t('links.sessions')}
                field="sessions"
                sort={search.sort}
                dir={search.dir}
                onSort={sortBy}
              />
              <SortHeader
                label={t('links.lastOpened')}
                field="lastOpened"
                sort={search.sort}
                dir={search.dir}
                onSort={sortBy}
              />
              <SortHeader
                label={t('links.maxWatched')}
                field="completion"
                sort={search.sort}
                dir={search.dir}
                onSort={sortBy}
              />
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data?.items.map((l) => (
              <tr key={l.id}>
                <td>
                  <Link to="/links/$id" params={{ id: l.id }} className="font-medium hover:underline">
                    {l.label}
                  </Link>
                  {l.hasPassword && <span title={t('links.hasPassword')}> 🔒</span>}
                </td>
                <td>
                  {l.recipientName}
                  {l.recipientOrg && <div className="text-xs text-muted-fg">{l.recipientOrg}</div>}
                </td>
                <td>
                  <code className="text-xs">{l.slug}</code>
                </td>
                <td>
                  <LinkStateBadge state={l.state} />
                </td>
                <td className="whitespace-nowrap">{l.expiresAt ? fmtDateTime(l.expiresAt) : '–'}</td>
                <td className="tabular-nums">
                  {fmtNum(l.sessions)}
                  {l.maxSessions ? ` / ${l.maxSessions}` : ''}
                  {l.previews > 0 && (
                    <div className="text-xs text-muted-fg">
                      +{l.previews} {t('links.previews').toLowerCase()}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap" title={fmtDateTime(l.lastOpenedAt)}>
                  {l.lastOpenedAt ? fmtRelative(l.lastOpenedAt) : '–'}
                </td>
                <td className="tabular-nums">{fmtPct(l.maxCompletion)}</td>
                <td className="whitespace-nowrap text-right">
                  <CopyButton text={l.url} />{' '}
                  <Button size="sm" variant="ghost" onClick={() => setQr(l)}>
                    {t('links.qr')}
                  </Button>
                  {editor && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => toggle.mutate(l)}>
                        {l.isActive ? t('links.close') : t('links.open')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(l)}>
                        {t('app.edit')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(l)}>
                        {t('app.delete')}
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {q.data && (
        <Pager
          page={search.page}
          pageSize={q.data.pageSize}
          total={q.data.total}
          onPage={(p) => setSearch({ ...search, page: p })}
          labels={{ prev: t('app.prev'), next: t('app.next'), of: t('app.of') }}
        />
      )}
      <Dialog
        open={!!editing}
        title={editing === 'new' ? t('links.new') : t('app.edit')}
        onClose={() => setEditing(null)}
      >
        {editing && (
          <LinkForm
            videoId={video.id}
            link={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null);
              void refresh();
            }}
          />
        )}
      </Dialog>
      <Dialog open={bulk} title={t('links.bulk')} onClose={() => setBulk(false)}>
        <BulkForm videoId={video.id} onDone={refresh} />
      </Dialog>
      <Dialog open={!!qr} title={t('links.qr')} onClose={() => setQr(null)}>
        {qr && <QrView url={qr.url} />}
      </Dialog>
      <DeleteLinkDialog link={deleting} onClose={() => setDeleting(null)} onDeleted={refresh} />
    </Card>
  );
}

function QuickCreate({ videoId, onCreated }: { videoId: string; onCreated: () => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ label: '', recipientName: '' });
  const [created, setCreated] = useState<LinkRow | null>(null);
  const m = useMutation({
    mutationFn: () =>
      post<LinkRow>(`/videos/${videoId}/links`, {
        label: form.label,
        recipientName: form.recipientName || undefined,
      }),
    onSuccess: (l) => {
      setCreated(l);
      setForm({ label: '', recipientName: '' });
      onCreated();
    },
  });
  return (
    <div className="space-y-2">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label={t('links.label')}>
          <Input
            required
            placeholder="Yritys X / rekrytoija"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
        </Field>
        <Field label={t('links.recipientName')}>
          <Input
            value={form.recipientName}
            onChange={(e) => setForm({ ...form, recipientName: e.target.value })}
          />
        </Field>
        <Button type="submit" disabled={m.isPending}>
          {t('links.create')}
        </Button>
      </form>
      <ErrorText error={m.error} />
      {created && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-ok/10 p-2 text-sm">
          {t('links.created')}: <code className="select-all break-all">{created.url}</code>{' '}
          <CopyButton text={created.url} />
        </div>
      )}
    </div>
  );
}

function toLocalInput(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function LinkForm({
  videoId,
  link,
  onDone,
}: {
  videoId: string;
  link: LinkRow | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [f, setF] = useState({
    label: link?.label ?? '',
    recipientName: link?.recipientName ?? '',
    recipientOrg: link?.recipientOrg ?? '',
    note: link?.note ?? '',
    slug: link?.slug ?? '',
    password: '',
    removePassword: false,
    expiresAt: toLocalInput(link?.expiresAt ?? null),
    maxSessions: link?.maxSessions ? String(link.maxSessions) : '',
    allowDownload: link?.allowDownload ?? false,
    allowEmbed: link?.allowEmbed ?? false,
    notifyOnOpen: link?.notifyOnOpen ?? true,
    notifyEveryOpen: link?.notifyEveryOpen ?? false,
    ctaOverride: !!link?.ctaConfig,
    ctaConfig: link?.ctaConfig ?? [],
    keepOldSlugRedirect: true,
    storyMode: link?.storyMode ?? null,
  });
  const [advanced, setAdvanced] = useState(!!link);
  const [slugCheck, setSlugCheck] = useState<{
    ok: boolean;
    guessable?: boolean;
    available: boolean;
    suggestion: string;
    reason?: string;
  } | null>(null);
  useEffect(() => {
    if (!f.slug || f.slug === link?.slug) {
      setSlugCheck(null);
      return;
    }
    const h = setTimeout(() => {
      void get<typeof slugCheck>(`/slugs/check${qs({ slug: f.slug, linkId: link?.id })}`).then(setSlugCheck);
    }, 300);
    return () => clearTimeout(h);
  }, [f.slug, link?.slug, link?.id]);

  const m = useMutation({
    mutationFn: () => {
      const body = {
        label: f.label,
        recipientName: f.recipientName || undefined,
        recipientOrg: f.recipientOrg || undefined,
        note: f.note || undefined,
        slug: f.slug && f.slug !== link?.slug ? f.slug : undefined,
        ...(f.password ? { password: f.password } : f.removePassword ? { password: null } : {}),
        expiresAt: f.expiresAt ? new Date(f.expiresAt).toISOString() : null,
        maxSessions: f.maxSessions ? Number(f.maxSessions) : null,
        allowDownload: f.allowDownload,
        allowEmbed: f.allowEmbed,
        notifyOnOpen: f.notifyOnOpen,
        notifyEveryOpen: f.notifyEveryOpen,
        ctaConfig: f.ctaOverride ? f.ctaConfig : null,
        storyMode: f.storyMode,
        ...(link ? { keepOldSlugRedirect: f.keepOldSlugRedirect } : {}),
      };
      return link ? patch(`/links/${link.id}`, body) : post(`/videos/${videoId}/links`, body);
    },
    onSuccess: onDone,
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Field label={t('links.label')}>
        <Input required value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('links.recipientName')}>
          <Input value={f.recipientName} onChange={(e) => setF({ ...f, recipientName: e.target.value })} />
        </Field>
        <Field label={t('links.recipientOrg')}>
          <Input value={f.recipientOrg} onChange={(e) => setF({ ...f, recipientOrg: e.target.value })} />
        </Field>
      </div>
      <button
        type="button"
        className="text-sm text-primary"
        onClick={() => setAdvanced(!advanced)}
        aria-expanded={advanced}
      >
        {advanced ? '▾' : '▸'} {t('links.advanced')}
      </button>
      {advanced && (
        <div className="space-y-3">
          <Field label={t('links.note')}>
            <Textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </Field>
          <Field
            label={link ? t('links.slug') : t('links.customSlug')}
            hint={t('links.slugHelp')}
            error={
              slugCheck && (!slugCheck.ok || !slugCheck.available)
                ? (slugCheck.reason ?? 'not available')
                : null
            }
          >
            <Input
              value={f.slug}
              onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })}
              pattern="[a-z0-9][a-z0-9-]{2,62}[a-z0-9]"
            />
          </Field>
          {slugCheck?.ok && slugCheck.guessable && (
            <p className="text-xs text-warn">
              {t('links.guessable')} <code>{slugCheck.suggestion}</code>{' '}
              <button
                type="button"
                className="underline"
                onClick={() => setF({ ...f, slug: slugCheck.suggestion })}
              >
                {t('links.useSuggestion')}
              </button>
            </p>
          )}
          {link && f.slug !== link.slug && (
            <Checkbox
              label={t('links.keepRedirect')}
              checked={f.keepOldSlugRedirect}
              onChange={(v) => setF({ ...f, keepOldSlugRedirect: v })}
            />
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('links.password')}>
              <Input
                type="password"
                autoComplete="new-password"
                value={f.password}
                onChange={(e) => setF({ ...f, password: e.target.value })}
              />
            </Field>
            <Field label={t('links.expires')}>
              <Input
                type="datetime-local"
                value={f.expiresAt}
                onChange={(e) => setF({ ...f, expiresAt: e.target.value })}
              />
            </Field>
            <Field label={t('links.maxSessions')}>
              <Input
                type="number"
                min={1}
                value={f.maxSessions}
                onChange={(e) => setF({ ...f, maxSessions: e.target.value })}
              />
            </Field>
          </div>
          {link?.hasPassword && (
            <Checkbox
              label={t('links.removePassword')}
              checked={f.removePassword}
              onChange={(v) => setF({ ...f, removePassword: v })}
            />
          )}
          <Checkbox
            label={t('links.allowDownload')}
            checked={f.allowDownload}
            onChange={(v) => setF({ ...f, allowDownload: v })}
          />
          <Checkbox
            label={t('links.allowEmbed')}
            checked={f.allowEmbed}
            onChange={(v) => setF({ ...f, allowEmbed: v })}
          />
          <Checkbox
            label={t('links.notifyOnOpen')}
            checked={f.notifyOnOpen}
            onChange={(v) => setF({ ...f, notifyOnOpen: v })}
          />
          <Checkbox
            label={t('links.notifyEveryOpen')}
            checked={f.notifyEveryOpen}
            onChange={(v) => setF({ ...f, notifyEveryOpen: v })}
          />
          <Field label={t('story.linkSetting')}>
            <Select
              value={f.storyMode === null ? '' : String(f.storyMode)}
              onChange={(e) =>
                setF({ ...f, storyMode: e.target.value === '' ? null : e.target.value === 'true' })
              }
            >
              <option value="">{t('story.followVideo')}</option>
              <option value="true">{t('story.on')}</option>
              <option value="false">{t('story.off')}</option>
            </Select>
          </Field>
          <Checkbox
            label={t('links.ctaOverride')}
            checked={f.ctaOverride}
            onChange={(v) => setF({ ...f, ctaOverride: v })}
          />
          {f.ctaOverride && (
            <CtaEditor title="" value={f.ctaConfig} onChange={(ctaConfig) => setF({ ...f, ctaConfig })} />
          )}
        </div>
      )}
      <ErrorText error={m.error} />
      <Button type="submit" disabled={m.isPending}>
        {link ? t('app.save') : t('links.create')}
      </Button>
    </form>
  );
}

function BulkForm({ videoId, onDone }: { videoId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [csv, setCsv] = useState('');
  const m = useMutation({
    mutationFn: () => post<{ created: LinkRow[] }>(`/videos/${videoId}/links/bulk`, { csv }),
    onSuccess: onDone,
  });
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-fg">{t('links.bulkHelp')}</p>
      <Textarea
        rows={8}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        placeholder={'label,recipient_name,recipient_org\nYritys X / HR,Maija Meikäläinen,Yritys X'}
      />
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void f.text().then(setCsv);
        }}
      />
      <ErrorText error={m.error} />
      <Button disabled={!csv || m.isPending} onClick={() => m.mutate()}>
        {t('app.create')}
      </Button>
      {m.data && (
        <div className="space-y-1 text-sm">
          <p className="text-ok">{t('links.bulkCreated', { n: m.data.created.length })}</p>
          <Textarea readOnly rows={6} value={m.data.created.map((l) => `${l.label}\t${l.url}`).join('\n')} />
        </div>
      )}
    </div>
  );
}

function QrView({ url }: { url: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    void QRCode.toString(url, { type: 'svg', margin: 1, width: 280 }).then(setSvg);
  }, [url]);
  return (
    <div className="space-y-3 text-center">
      <div className="mx-auto w-[280px] rounded bg-white p-2" dangerouslySetInnerHTML={{ __html: svg }} />
      <code className="block break-all text-xs">{url}</code>
      <a
        className="text-sm underline"
        href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
        download="qr.svg"
      >
        SVG
      </a>
    </div>
  );
}

export function DeleteLinkDialog({
  link,
  onClose,
  onDeleted,
}: {
  link: LinkRow | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [telemetry, setTelemetry] = useState(false);
  return (
    <Dialog open={!!link} title={t('links.deleteTitle')} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm">
          {t('app.confirmDelete')} <strong>{link?.label}</strong>
        </p>
        <Checkbox label={t('links.deleteTelemetry')} checked={telemetry} onChange={setTelemetry} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() =>
              void del(`/links/${link!.id}${telemetry ? '?telemetry=true' : ''}`).then(() => {
                onClose();
                onDeleted();
              })
            }
          >
            {t('app.delete')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
