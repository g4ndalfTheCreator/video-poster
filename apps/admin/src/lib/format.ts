import i18n from '../i18n';

let timeZone = 'Europe/Helsinki';
export const setTimeZone = (tz: string) => {
  timeZone = tz;
};

const locale = () => (i18n.language === 'en' ? 'en-GB' : 'fi-FI');

export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return '–';
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'short', timeStyle: 'short', timeZone }).format(
    new Date(v),
  );
}
export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return '–';
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeZone }).format(new Date(v));
}
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}
export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(n);
}
export function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined) return '–';
  return `${fmtNum(n, digits)} %`;
}
export function fmtBytes(n: number | null | undefined): string {
  if (!n) return '0 B';
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${fmtNum(n / 1024 ** i, 1)} ${u[i]}`;
}
export function fmtRelative(v: string | Date | null | undefined): string {
  if (!v) return '–';
  const diff = (new Date(v).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}
