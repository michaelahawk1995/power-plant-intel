// Minimal HTML→text + chunker. No deps; we control quality.

export function htmlToText(html: string): string {
  let s = html;
  // strip scripts and styles
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  // strip head
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  // block-level → newline
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|article|section)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // strip remaining tags
  s = s.replace(/<[^>]+>/g, ' ');
  // entities (basic)
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  // collapse whitespace per line, preserve paragraph breaks
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n');
  return s;
}

// Approx-token chunker. ~4 chars per token; we slice by characters with overlap on paragraph boundaries.
export function chunkText(text: string, maxTokens = 2000, overlapTokens = 100): string[] {
  const maxChars = maxTokens * 4;
  const overlapChars = overlapTokens * 4;
  if (text.length <= maxChars) return [text];

  const paras = text.split(/\n+/);
  const chunks: string[] = [];
  let buf = '';
  let i = 0;
  while (i < paras.length) {
    const p = paras[i] ?? '';
    if (buf.length + p.length + 1 <= maxChars) {
      buf = buf ? `${buf}\n${p}` : p;
      i++;
    } else {
      if (buf) chunks.push(buf);
      // Start next chunk with tail overlap from previous
      const tail = buf.slice(Math.max(0, buf.length - overlapChars));
      buf = tail ? `${tail}\n${p}` : p;
      i++;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}
