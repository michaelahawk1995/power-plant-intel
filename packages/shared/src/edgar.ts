// SEC EDGAR client — JSON discovery + HTML body fetch.
// Rate limit: 10 req/sec per IP. UA header required.

import { requireEnv } from './env.js';

const UA = process.env.USER_AGENT || 'PowerPlantIntel/0.1 (contact@example.com)';

const headers = {
  'User-Agent': UA,
  'Accept-Encoding': 'gzip, deflate',
  Host: 'data.sec.gov',
};

interface RecentFilings {
  accessionNumber: string[];
  filingDate: string[];
  reportDate: string[];
  form: string[];
  primaryDocument: string[];
  primaryDocDescription: string[];
  items?: string[];
}

export interface EdgarSubmission {
  cik: string;
  name: string;
  tickers: string[];
  filings: { recent: RecentFilings };
}

export async function fetchSubmissions(cik: string): Promise<EdgarSubmission> {
  const padded = cik.padStart(10, '0');
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`EDGAR submissions ${cik}: ${r.status}`);
  return (await r.json()) as EdgarSubmission;
}

export interface FilingMeta {
  cik: string;
  accession: string;        // 0001144879-26-000036
  accessionNoDash: string;  // 000114487926000036
  form: string;
  filingDate: string;
  primaryDocument: string;
  primaryDocDescription: string;
  items: string;
}

export function listRecent(sub: EdgarSubmission, opts?: { sinceDate?: string; forms?: string[] }): FilingMeta[] {
  const r = sub.filings.recent;
  const since = opts?.sinceDate;
  const formSet = opts?.forms ? new Set(opts.forms) : null;
  const out: FilingMeta[] = [];
  for (let i = 0; i < r.accessionNumber.length; i++) {
    const form = r.form[i] ?? '';
    if (formSet && !formSet.has(form)) continue;
    const filingDate = r.filingDate[i] ?? '';
    if (since && filingDate < since) continue;
    const accession = r.accessionNumber[i] ?? '';
    out.push({
      cik: sub.cik,
      accession,
      accessionNoDash: accession.replace(/-/g, ''),
      form,
      filingDate,
      primaryDocument: r.primaryDocument[i] ?? '',
      primaryDocDescription: r.primaryDocDescription[i] ?? '',
      items: r.items?.[i] ?? '',
    });
  }
  return out;
}

const wwwHeaders = {
  'User-Agent': UA,
  'Accept-Encoding': 'gzip, deflate',
  Host: 'www.sec.gov',
};

export async function fetchPrimaryDoc(meta: FilingMeta): Promise<string> {
  const cikInt = String(parseInt(meta.cik, 10));
  const url = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${meta.accessionNoDash}/${meta.primaryDocument}`;
  const r = await fetch(url, { headers: wwwHeaders });
  if (!r.ok) throw new Error(`EDGAR primary doc ${meta.accession}: ${r.status}`);
  return await r.text();
}

interface AccessionIndex {
  directory: { item: Array<{ name: string; type: string; size: string }> };
}

// Returns the list of .htm files in the accession directory, sorted so the
// primary doc comes first and EX-99.* attachments follow. Excludes XBRL
// supporting files (R\d+.htm), labels, and FilingSummary noise.
export async function listAccessionHtmFiles(meta: FilingMeta): Promise<string[]> {
  const cikInt = String(parseInt(meta.cik, 10));
  const url = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${meta.accessionNoDash}/index.json`;
  const r = await fetch(url, { headers: wwwHeaders });
  if (!r.ok) throw new Error(`EDGAR index.json ${meta.accession}: ${r.status}`);
  const j = (await r.json()) as AccessionIndex;
  const all = j.directory.item.map((i) => i.name);
  const htm = all.filter(
    (n) =>
      n.toLowerCase().endsWith('.htm') &&
      !/^R\d+\.htm$/i.test(n) &&            // XBRL viewer artifacts
      !n.toLowerCase().includes('filingsummary') &&
      !n.toLowerCase().endsWith('_lab.htm') &&
      !n.toLowerCase().endsWith('_pre.htm') &&
      !n.toLowerCase().endsWith('_def.htm') &&
      !n.toLowerCase().endsWith('_cal.htm')
  );
  // Primary first, then everything else alphabetically
  htm.sort((a, b) => {
    if (a === meta.primaryDocument) return -1;
    if (b === meta.primaryDocument) return 1;
    return a.localeCompare(b);
  });
  return htm;
}

// Fetches the primary doc + all exhibit .htm files in the accession.
// Returns one combined document with ===FILE: <name>=== separators so the
// extractor can see what it's reading. Caps at maxFiles + maxBytesEach
// to keep token costs sane on huge 10-Q packages.
export async function fetchAllAccessionHtm(
  meta: FilingMeta,
  opts?: { maxFiles?: number; maxBytesEach?: number }
): Promise<{ combined: string; files: Array<{ name: string; bytes: number }> }> {
  const maxFiles = opts?.maxFiles ?? 12;
  const maxBytesEach = opts?.maxBytesEach ?? 2_000_000;
  const cikInt = String(parseInt(meta.cik, 10));
  const baseUrl = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${meta.accessionNoDash}`;

  const names = (await listAccessionHtmFiles(meta)).slice(0, maxFiles);
  const parts: string[] = [];
  const stats: Array<{ name: string; bytes: number }> = [];

  for (const name of names) {
    await rateGate();
    const r = await fetch(`${baseUrl}/${name}`, { headers: wwwHeaders });
    if (!r.ok) {
      stats.push({ name, bytes: 0 });
      continue;
    }
    const t = (await r.text()).slice(0, maxBytesEach);
    parts.push(`===FILE: ${name}===\n${t}`);
    stats.push({ name, bytes: t.length });
  }
  return { combined: parts.join('\n\n'), files: stats };
}

// Polite-rate gate: max ~8 req/sec to leave headroom under SEC's 10/sec.
let lastTick = 0;
export async function rateGate(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastTick;
  const minGap = 130; // ms
  if (elapsed < minGap) await new Promise((r) => setTimeout(r, minGap - elapsed));
  lastTick = Date.now();
}

// Re-export so consumers don't have to import requireEnv separately.
export { requireEnv };
