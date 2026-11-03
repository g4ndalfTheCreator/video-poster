const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]!);
}

/** JSON safe to embed in a <script type="application/json"> block. */
export function jsonForHtml(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Very small, safe Markdown subset for the privacy notice: paragraphs, "- " lists, **bold**. */
export function simpleMarkdown(text: string): string {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  return blocks
    .map((b) => {
      const lines = b.split('\n');
      const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      if (lines.every((l) => /^\s*[-*] /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`;
      if (/^#{1,3} /.test(b)) return `<h2>${inline(b.replace(/^#{1,3} /, ''))}</h2>`;
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    })
    .join('\n');
}
