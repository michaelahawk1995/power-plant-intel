// End-to-end EDGAR pipeline: scout -> ingest -> triage -> extract.
// Run locally. Designed to be ported to a Cloudflare Worker once stable.
//
// Usage:
//   pnpm tsx scripts/run-edgar-cycle.ts                 # 30-day lookback, all enabled sources
//   LOOKBACK_DAYS=90 pnpm tsx scripts/run-edgar-cycle.ts
//   ONLY=apld pnpm tsx scripts/run-edgar-cycle.ts       # only one ticker
//   MAX_FILINGS=5 pnpm tsx scripts/run-edgar-cycle.ts   # cap filings per source

import { z } from 'zod';
import { loadDotEnv, db, htmlToText, chunkText, edgar, callJsonAgent } from '@ppi/shared';
import { v1 } from '@ppi/prompts';

loadDotEnv();

const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 30);
const MAX_FILINGS_PER_SOURCE = Number(process.env.MAX_FILINGS ?? 8);
const ONLY = process.env.ONLY?.toLowerCase();

// Skip 10-K and DEF 14A by default — huge low-signal-density. Override via FORMS env.
const FORMS_OF_INTEREST = (process.env.FORMS ?? '8-K,10-Q,S-1,425').split(',').map((s) => s.trim());

// Cap chunks per document so a 10-Q doesn't blow the budget on boilerplate.
const MAX_CHUNKS_PER_DOC = Number(process.env.MAX_CHUNKS ?? 25);

// ---------- types ----------
const TriageSchema = z.object({
  keep: z.boolean(),
  reason: z.string(),
});

const FactSchema = z.object({
  kind: z.enum(['mw', 'usd', 'date', 'party', 'location', 'project_name', 'action']),
  value_text: z.string().nullable(),
  value_num: z.number().nullable(),
  value_unit: z.enum(['MW', 'USD']).nullable(),
  source_snippet: z.string().min(10),
  confidence: z.number().min(0).max(1),
});
const ExtractionSchema = z.object({
  facts: z.array(FactSchema),
  summary: z.string(),
});
type Extraction = z.infer<typeof ExtractionSchema>;

// ---------- helpers ----------
function sinceDateISO(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function sha256Hex(s: string): string {
  // simple stable hash (FNV-1a 64) — full crypto not needed; we only dedupe content
  let h1 = 2166136261, h2 = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 16777619);
    h2 ^= s.charCodeAt(s.length - 1 - i);
    h2 = Math.imul(h2, 16777619);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

// ---------- triage ----------
// NOTE on model choice: we originally used Haiku 4.5 here. Repro testing showed
// Haiku 4.5 silently ignores cache_control (cR=0/cW=0 across consecutive calls
// even at 3000+ token prefixes), while Sonnet 4.6 caches reliably. With caching,
// Sonnet's effective cost per cached call ($3/M × 0.1 = $0.30/M reads) beats
// uncached Haiku ($1/M fresh) at scale. Until Haiku caching is fixed in our
// account / SDK / model, Sonnet is the cheaper option for warm cycles.
async function triageChunk(text: string): Promise<{ keep: boolean; reason: string }> {
  try {
    return await callJsonAgent({
      agent: 'triage',
      model: 'claude-sonnet-4-6',
      systemPrompt: v1.TRIAGE_SYSTEM,
      userPayload: `CHUNK:\n${text}\n\nUse the submit_triage tool.`,
      schema: TriageSchema,
      toolName: 'submit_triage',
      toolDescription: 'Submit the triage decision: keep or drop, with a one-sentence reason.',
      maxTokens: 400,
      cacheSystem: true,
    });
  } catch (e) {
    return { keep: true, reason: `triage error (${(e as Error).message.slice(0, 80)}); defaulting to keep` };
  }
}

// ---------- extraction (Sonnet) ----------
async function extractChunk(text: string): Promise<Extraction> {
  const systemBlock = `${v1.EXTRACTOR_SYSTEM}\n\n--- WORKED EXAMPLES ---\n\n${v1.EXTRACTOR_FEW_SHOT}`;
  try {
    return await callJsonAgent({
      agent: 'extraction',
      model: 'claude-sonnet-4-6',
      systemPrompt: systemBlock,
      userPayload: `CHUNK:\n${text}\n\nUse the submit_extraction tool.`,
      schema: ExtractionSchema,
      toolName: 'submit_extraction',
      toolDescription: 'Submit the list of quote-anchored facts plus a one-sentence summary.',
      maxTokens: 6000,
      cacheSystem: true,
    });
  } catch (e) {
    console.warn(`  extractor failed: ${(e as Error).message.slice(0, 120)}`);
    return { facts: [], summary: 'extractor failed' };
  }
}

// ---------- per-filing pipeline ----------
async function processFiling(sourceId: number, meta: edgar.FilingMeta): Promise<{
  status: 'new' | 'skip-existing' | 'error';
  facts: number;
  chunks_kept: number;
}> {
  // 1. Insert into raw_queue (idempotent on (source_id, external_ref))
  const url = `https://www.sec.gov/Archives/edgar/data/${parseInt(meta.cik, 10)}/${meta.accessionNoDash}/${meta.primaryDocument}`;
  const existing = await db()
    .from('raw_queue')
    .select('id, state')
    .eq('source_id', sourceId)
    .eq('external_ref', meta.accession)
    .maybeSingle();
  if (existing.data && existing.data.state === 'ingested') {
    return { status: 'skip-existing', facts: 0, chunks_kept: 0 };
  }

  await edgar.rateGate();
  const { combined: html, files } = await edgar.fetchAllAccessionHtm(meta, { maxFiles: 10, maxBytesEach: 1_500_000 });
  const text = htmlToText(html);
  const contentHash = sha256Hex(text);
  const fileSummary = files.map((f) => `${f.name}(${f.bytes})`).join(',');

  let rawId = existing.data?.id as number | undefined;
  if (!rawId) {
    const ins = await db()
      .from('raw_queue')
      .insert({
        source_id: sourceId,
        external_ref: meta.accession,
        url,
        http_status: 200,
        content_hash: contentHash,
        bytes: text.length,
        meta: {
          form: meta.form,
          filing_date: meta.filingDate,
          items: meta.items,
          primary_doc: meta.primaryDocument,
          description: meta.primaryDocDescription,
          files_fetched: fileSummary,
        },
        state: 'pending',
      })
      .select('id')
      .single();
    if (ins.error) throw ins.error;
    rawId = ins.data.id;
  }

  // 2. Document
  const docTypeMap: Record<string, string> = {
    '8-K': 'sec_8k',
    '10-Q': 'sec_10q',
    '10-K': 'sec_10k',
    'S-1': 'sec_s1',
    '425': 'sec_425',
  };
  const docType = docTypeMap[meta.form] ?? 'sec_other';
  const docIns = await db()
    .from('documents')
    .insert({
      raw_id: rawId,
      doc_type: docType,
      title: `${meta.form}: ${meta.primaryDocDescription || meta.primaryDocument}`,
      filed_at: `${meta.filingDate}T00:00:00Z`,
      page_count: null,
      extraction_method: 'native_html',
      full_text: text.slice(0, 5_000_000),
    })
    .select('id')
    .single();
  if (docIns.error) throw docIns.error;
  const documentId = docIns.data.id;

  // 3. Chunk (cap to MAX_CHUNKS_PER_DOC — drop the tail, which is usually exhibits' boilerplate)
  const allChunks = chunkText(text, 1800, 100);
  const chunks = allChunks.slice(0, MAX_CHUNKS_PER_DOC);
  const chunkRows = chunks.map((c, i) => ({ document_id: documentId, idx: i, text: c }));
  const chunkIns = await db().from('document_chunks').insert(chunkRows).select('id, idx, text');
  if (chunkIns.error) throw chunkIns.error;

  // 4. Triage + extract
  let kept = 0;
  let totalFacts = 0;
  for (const ch of chunkIns.data ?? []) {
    const tri = await triageChunk(ch.text);
    await db().from('document_chunks').update({ triage_flag: tri.keep, triage_reason: tri.reason }).eq('id', ch.id);
    if (!tri.keep) continue;
    kept++;
    const ext = await extractChunk(ch.text);
    if (ext.facts.length === 0) continue;
    const factRows = ext.facts.map((f) => ({
      chunk_id: ch.id,
      document_id: documentId,
      kind: f.kind,
      value_text: f.value_text,
      value_num: f.value_num,
      value_unit: f.value_unit,
      source_snippet: f.source_snippet,
      confidence: f.confidence,
    }));
    const fIns = await db().from('extractions').insert(factRows);
    if (fIns.error) {
      console.warn(`  extractions insert error: ${fIns.error.message}`);
      continue;
    }
    totalFacts += factRows.length;
  }

  // 5. Mark raw_queue ingested
  await db().from('raw_queue').update({ state: 'ingested', ingested_at: new Date().toISOString() }).eq('id', rawId);

  return { status: 'new', facts: totalFacts, chunks_kept: kept };
}

// ---------- main ----------
async function main() {
  const since = sinceDateISO(LOOKBACK_DAYS);
  console.log(`\n=== EDGAR cycle :: lookback ${LOOKBACK_DAYS}d (since ${since}) ===\n`);

  const srcQuery = db()
    .from('source_registry')
    .select('id, source_key, display_name, parse_hint')
    .eq('family', 'sec_edgar')
    .eq('enabled', true);
  const srcs = await srcQuery;
  if (srcs.error) throw srcs.error;
  let sources = srcs.data ?? [];
  if (ONLY) {
    const tickers = ONLY.split(/[,|]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    sources = sources.filter((s) => tickers.some((t) => s.source_key.toLowerCase().endsWith(`:${t}`)));
  }
  console.log(`processing ${sources.length} source(s)\n`);

  const summary: Array<{ source: string; filings: number; new: number; facts: number; chunks_kept: number; errors: number }> = [];

  for (const src of sources) {
    const startedAt = Date.now();
    const cik = (src.parse_hint as { cik?: string } | null)?.cik;
    if (!cik) {
      console.log(`  [${src.source_key}] missing cik in parse_hint; skipping`);
      continue;
    }

    let row = { source: src.source_key, filings: 0, new: 0, facts: 0, chunks_kept: 0, errors: 0 };
    let httpStatus = 200;
    let runErr: string | null = null;

    try {
      await edgar.rateGate();
      const sub = await edgar.fetchSubmissions(cik);
      const recents = edgar.listRecent(sub, { sinceDate: since, forms: FORMS_OF_INTEREST }).slice(0, MAX_FILINGS_PER_SOURCE);
      row.filings = recents.length;
      console.log(`[${src.source_key}] ${recents.length} filing(s) since ${since}`);

      for (const meta of recents) {
        try {
          const r = await processFiling(src.id, meta);
          if (r.status === 'new') {
            row.new++;
            row.facts += r.facts;
            row.chunks_kept += r.chunks_kept;
            console.log(`  + ${meta.form} ${meta.filingDate} ${meta.accession}  facts=${r.facts} kept_chunks=${r.chunks_kept}`);
          } else {
            console.log(`  · ${meta.form} ${meta.filingDate} ${meta.accession}  (already ingested)`);
          }
        } catch (e) {
          row.errors++;
          console.warn(`  ! ${meta.accession}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      httpStatus = 0;
      runErr = (e as Error).message;
      row.errors++;
      console.warn(`  fatal: ${runErr}`);
    }

    await db().from('scout_runs').insert({
      source_id: src.id,
      duration_ms: Date.now() - startedAt,
      http_status: httpStatus,
      items_new: row.new,
      items_skipped: row.filings - row.new,
      ok: row.errors === 0,
      error: runErr,
    });
    summary.push(row);
  }

  // Cost roll-up for this run
  const costSel = await db()
    .from('cost_ledger')
    .select('agent, usd_cost, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens')
    .gte('ts', new Date(Date.now() - 30 * 60 * 1000).toISOString());
  const byAgent = new Map<string, { usd: number; calls: number; in: number; cR: number; cW: number; out: number }>();
  for (const r of costSel.data ?? []) {
    const k = (r as any).agent as string;
    const cur = byAgent.get(k) ?? { usd: 0, calls: 0, in: 0, cR: 0, cW: 0, out: 0 };
    cur.usd += Number((r as any).usd_cost);
    cur.calls += 1;
    cur.in += (r as any).input_tokens ?? 0;
    cur.cR += (r as any).cache_read_tokens ?? 0;
    cur.cW += (r as any).cache_write_tokens ?? 0;
    cur.out += (r as any).output_tokens ?? 0;
    byAgent.set(k, cur);
  }

  console.log(`\n=== summary ===`);
  for (const s of summary) {
    console.log(`  ${s.source.padEnd(22)} filings=${s.filings} new=${s.new} facts=${s.facts} kept=${s.chunks_kept} err=${s.errors}`);
  }
  console.log(`\n=== cost (last 30 min) ===`);
  let totalUsd = 0;
  for (const [k, v] of byAgent) {
    totalUsd += v.usd;
    const cacheHit = v.cR + v.in > 0 ? ((100 * v.cR) / (v.cR + v.in)).toFixed(0) : '0';
    console.log(`  ${k.padEnd(12)} calls=${v.calls.toString().padStart(4)}  in=${v.in.toString().padStart(7)}  cacheR=${v.cR.toString().padStart(7)} (${cacheHit}%)  out=${v.out.toString().padStart(6)}  $${v.usd.toFixed(4)}`);
  }
  console.log(`  TOTAL: $${totalUsd.toFixed(4)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
