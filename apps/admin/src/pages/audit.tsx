import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { get, qs } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { Card, Input, Pager, Table, Empty } from '../components/ui';
import { PageHeader } from '../components/layout';
import type { Page } from '@vs/shared';

interface AuditRow {
  id: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  diff: unknown;
  ip: string | null;
  createdAt: string;
  actor: string | null;
}

export function AuditPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: '/audit' });
  const navigate = useNavigate({ from: '/audit' });
  const q = useQuery({
    queryKey: ['audit', search],
    queryFn: () => get<Page<AuditRow>>(`/audit-log${qs({ ...search })}`),
  });
  return (
    <>
      <PageHeader title={t('audit.title')} />
      <Card>
        <Input
          placeholder={t('app.search')}
          defaultValue={search.q ?? ''}
          className="mb-3 max-w-xs"
          onChange={(e) => void navigate({ search: { ...search, q: e.target.value || undefined, page: 1 } })}
        />
        {q.data?.items.length === 0 ? (
          <Empty>{t('app.none')}</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t('audit.time')}</th>
                <th>{t('audit.actor')}</th>
                <th>{t('audit.action')}</th>
                <th>{t('audit.entity')}</th>
                <th>{t('audit.ip')}</th>
                <th>{t('audit.details')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.items.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{fmtDateTime(r.createdAt)}</td>
                  <td>{r.actor ?? '–'}</td>
                  <td>
                    <code>{r.action}</code>
                  </td>
                  <td className="text-xs">
                    {r.entity} {r.entityId?.slice(0, 8)}
                  </td>
                  <td className="text-xs">{r.ip ?? '–'}</td>
                  <td className="max-w-md truncate text-xs" title={r.diff ? JSON.stringify(r.diff) : ''}>
                    {r.diff ? JSON.stringify(r.diff) : ''}
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
            onPage={(p) => void navigate({ search: { ...search, page: p } })}
            labels={{ prev: t('app.prev'), next: t('app.next'), of: t('app.of') }}
          />
        )}
      </Card>
    </>
  );
}
