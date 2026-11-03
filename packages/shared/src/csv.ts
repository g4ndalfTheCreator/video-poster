/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF, ',' or ';' separators). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((f) => f.trim()));
}

export interface BulkLinkRow {
  label: string;
  recipientName?: string;
  recipientOrg?: string;
}

/** Rows of `label, recipient_name, recipient_org`; a header row is detected and skipped. */
export function parseBulkLinks(text: string): BulkLinkRow[] {
  const rows = parseCsv(text);
  let cols = { label: 0, name: 1, org: 2 };
  if (rows[0]?.some((c) => /^label$/i.test(c))) {
    const h = rows.shift()!.map((c) => c.toLowerCase());
    cols = { label: h.indexOf('label'), name: h.indexOf('recipient_name'), org: h.indexOf('recipient_org') };
  }
  return rows
    .map((r) => ({
      label: (r[cols.label] ?? '').slice(0, 200),
      recipientName: cols.name >= 0 ? r[cols.name]?.slice(0, 200) || undefined : undefined,
      recipientOrg: cols.org >= 0 ? r[cols.org]?.slice(0, 200) || undefined : undefined,
    }))
    .filter((r) => r.label);
}
