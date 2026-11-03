import { clsx } from 'clsx';
import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

export const cn = clsx;

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      {...p}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        size === 'sm' ? 'h-8 px-2.5 text-sm' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-primary text-primary-fg hover:opacity-90',
        variant === 'secondary' && 'border border-border bg-card hover:bg-muted',
        variant === 'ghost' && 'hover:bg-muted',
        variant === 'danger' && 'bg-danger text-white hover:opacity-90',
        className,
      )}
    />
  );
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      className={cn(
        'h-9 w-full rounded-md border border-border bg-card px-3 text-sm placeholder:text-muted-fg',
        className,
      )}
    />
  );
}
export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...p}
      className={cn('min-h-20 w-full rounded-md border border-border bg-card px-3 py-2 text-sm', className)}
    />
  );
}
export function Select({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...p} className={cn('h-9 rounded-md border border-border bg-card px-2 text-sm', className)} />
  );
}
export function Field({
  label,
  children,
  hint,
  error,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
  error?: string | null;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-fg">{hint}</span>}
      {error && <span className="block text-xs text-danger">{error}</span>}
    </label>
  );
}
export function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-4 accent-[var(--primary)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-lg border border-border bg-card', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'info';
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium',
        tone === 'neutral' && 'bg-muted text-muted-fg',
        tone === 'ok' && 'bg-ok/15 text-ok',
        tone === 'warn' && 'bg-warn/15 text-warn',
        tone === 'danger' && 'bg-danger/15 text-danger',
        tone === 'info' && 'bg-primary/15 text-primary',
      )}
    >
      {children}
    </span>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2 [&_th]:text-xs [&_th]:font-medium [&_th]:text-muted-fg [&_tbody_tr]:border-t [&_tbody_tr]:border-border">
        {children}
      </table>
    </div>
  );
}

export function SortHeader({
  label,
  field,
  sort,
  dir,
  onSort,
}: {
  label: string;
  field: string;
  sort?: string;
  dir?: string;
  onSort: (f: string) => void;
}) {
  const active = sort === field;
  return (
    <th>
      <button
        className="inline-flex items-center gap-1 hover:text-fg"
        onClick={() => onSort(field)}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        <span aria-hidden>{active ? (dir === 'asc' ? '▲' : '▼') : ''}</span>
      </button>
    </th>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
  labels,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  labels: { prev: string; next: string; of: string };
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-end gap-2 pt-3 text-sm text-muted-fg">
      <span>
        {page} {labels.of} {pages} ({total})
      </span>
      <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        {labels.prev}
      </Button>
      <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {labels.next}
      </Button>
    </div>
  );
}

export function Dialog({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-0 text-fg backdrop:bg-black/50"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="font-semibold">{title}</h2>
        <button className="text-muted-fg hover:text-fg" onClick={onClose} aria-label="close">
          ✕
        </button>
      </header>
      <div className="max-h-[75vh] overflow-y-auto p-4">{open && children}</div>
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <div className="space-y-4">
        <div className="text-sm">{body}</div>
        {children}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function Stat({
  label,
  value,
  delta,
  hint,
}: {
  label: string;
  value: ReactNode;
  delta?: number | null;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-fg">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {delta !== undefined && delta !== null && Number.isFinite(delta) && (
        <div className={cn('mt-1 text-xs tabular-nums', delta >= 0 ? 'text-ok' : 'text-danger')}>
          {delta >= 0 ? '▲' : '▼'} {Math.abs(Math.round(delta * 100))} %{hint ? ` ${hint}` : ''}
        </div>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-8 text-center text-sm text-muted-fg">{children}</div>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="text-sm text-danger">{error instanceof Error ? error.message : String(error)}</p>;
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: string }[];
}) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-border">
      {items.map((i) => (
        <button
          key={i.value}
          role="tab"
          aria-selected={value === i.value}
          onClick={() => onChange(i.value)}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-sm',
            value === i.value
              ? 'border-primary font-medium'
              : 'border-transparent text-muted-fg hover:text-fg',
          )}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}
