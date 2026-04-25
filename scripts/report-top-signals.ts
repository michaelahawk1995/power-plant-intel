// Generate a Markdown report of the top extracted signals.
// This is the slice-1 stand-in for the full Editorial Synthesis + Dashboard chain.
// Output: docs/SIGNALS_LATEST.md

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDotEnv, db } from '@ppi/shared';

loadDotEnv();

interface Doc {
  id: number;
  doc_type: string;
  title: string;
  filed_at: string;
  raw_id: number;
}
interface RawRow { id: number; url: string; external_ref: string; meta: Record<string, unknown> | null; source_id: number; }
interface SrcRow { id: number; display_name: string; }

async function main() {
  // Top MW by document, deduped on document_id (best MW per doc)
  const mwAll = await db()
    .from('extractions')
    .select('value_num, value_text, source_snippet, document_id, confidence')
    .eq('kind', 'mw')
    .not('value_num', 'is', null)
    .gte('confidence', 0.85)
    .order('value_num', { ascending: false });

  const usdAll = await db()
    .from('extractions')
    .select('value_num, value_text, source_snippet, document_id, confidence')
    .eq('kind', 'usd')
    .not('value_num', 'is', null)
    .gte('confidence', 0.85)
    .order('value_num', { ascending: false });

  const partyAll = await db()
    .from('extractions')
    .select('value_text, source_snippet, document_id, confidence')
    .eq('kind', 'party')
    .gte('confidence', 0.85);

  const projAll = await db()
    .from('extractions')
    .select('value_text, source_snippet, document_id, confidence')
    .eq('kind', 'project_name');

  // Index docs/raws/sources
  const allDocIds = new Set<number>();
  for (const arr of [mwAll.data, usdAll.data, partyAll.data, projAll.data]) {
    for (const r of arr ?? []) allDocIds.add((r as any).document_id);
  }
  const docsRes = await db()
    .from('documents')
    .select('id, doc_type, title, filed_at, raw_id')
    .in('id', Array.from(allDocIds));
  const docs = new Map<number, Doc>((docsRes.data ?? []).map((d) => [d.id as number, d as Doc]));

  const rawIds = Array.from(new Set([...docs.values()].map((d) => d.raw_id)));
  const rawsRes = await db()
    .from('raw_queue')
    .select('id, url, external_ref, meta, source_id')
    .in('id', rawIds);
  const raws = new Map<number, RawRow>((rawsRes.data ?? []).map((r) => [r.id as number, r as RawRow]));

  const srcIds = Array.from(new Set([...raws.values()].map((r) => r.source_id)));
  const srcsRes = await db().from('source_registry').select('id, display_name').in('id', srcIds);
  const srcs = new Map<number, SrcRow>((srcsRes.data ?? []).map((s) => [s.id as number, s as SrcRow]));

  function linkFor(docId: number): { url: string; src: string; date: string; ref: string } {
    const d = docs.get(docId);
    if (!d) return { url: '?', src: '?', date: '?', ref: '?' };
    const r = raws.get(d.raw_id);
    if (!r) return { url: '?', src: '?', date: d.filed_at?.slice(0, 10) ?? '?', ref: '?' };
    const s = srcs.get(r.source_id);
    return {
      url: r.url,
      src: s?.display_name ?? '?',
      date: d.filed_at?.slice(0, 10) ?? '?',
      ref: r.external_ref,
    };
  }

  // Group facts by document for "top signals"
  const byDoc = new Map<number, { mw: number; usd: number; parties: Set<string>; projects: Set<string>; quotes: string[] }>();
  for (const r of mwAll.data ?? []) {
    const d = byDoc.get((r as any).document_id) ?? { mw: 0, usd: 0, parties: new Set(), projects: new Set(), quotes: [] };
    d.mw = Math.max(d.mw, Number((r as any).value_num));
    if ((r as any).source_snippet) d.quotes.push(`MW: ${(r as any).source_snippet}`);
    byDoc.set((r as any).document_id, d);
  }
  for (const r of usdAll.data ?? []) {
    const d = byDoc.get((r as any).document_id) ?? { mw: 0, usd: 0, parties: new Set(), projects: new Set(), quotes: [] };
    d.usd = Math.max(d.usd, Number((r as any).value_num));
    if ((r as any).source_snippet) d.quotes.push(`USD: ${(r as any).source_snippet}`);
    byDoc.set((r as any).document_id, d);
  }
  for (const r of partyAll.data ?? []) {
    const d = byDoc.get((r as any).document_id) ?? { mw: 0, usd: 0, parties: new Set(), projects: new Set(), quotes: [] };
    if ((r as any).value_text) d.parties.add((r as any).value_text);
    byDoc.set((r as any).document_id, d);
  }
  for (const r of projAll.data ?? []) {
    const d = byDoc.get((r as any).document_id) ?? { mw: 0, usd: 0, parties: new Set(), projects: new Set(), quotes: [] };
    if ((r as any).value_text) d.projects.add((r as any).value_text);
    byDoc.set((r as any).document_id, d);
  }

  // Score = MW + USD/1e6 (rough significance proxy until real Scoring agent ships)
  const ranked = Array.from(byDoc.entries())
    .map(([docId, d]) => ({ docId, ...d, score: d.mw + d.usd / 1_000_000 }))
    .sort((a, b) => b.score - a.score);

  // Cost rollup
  const cost = await db().from('cost_ledger').select('agent, usd_cost, input_tokens, cache_read_tokens, output_tokens');
  const byAgent = new Map<string, { usd: number; calls: number; in: number; cR: number; out: number }>();
  for (const r of cost.data ?? []) {
    const k = (r as any).agent as string;
    const cur = byAgent.get(k) ?? { usd: 0, calls: 0, in: 0, cR: 0, out: 0 };
    cur.usd += Number((r as any).usd_cost);
    cur.calls += 1;
    cur.in += (r as any).input_tokens ?? 0;
    cur.cR += (r as any).cache_read_tokens ?? 0;
    cur.out += (r as any).output_tokens ?? 0;
    byAgent.set(k, cur);
  }
  const totalUsd = Array.from(byAgent.values()).reduce((s, v) => s + v.usd, 0);

  // Build markdown
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  const lines: string[] = [];
  lines.push(`# Power Plant Intel — Signals snapshot`);
  lines.push(``);
  lines.push(`Generated ${now} from live SEC EDGAR ingestion. This is the slice-1 raw-signals view, before the full Editorial Synthesis agent ships.`);
  lines.push(``);
  lines.push(`**Pipeline run summary:** ${docs.size} documents ingested, ${(mwAll.data ?? []).length + (usdAll.data ?? []).length + (partyAll.data ?? []).length + (projAll.data ?? []).length} high-confidence facts extracted, **$${totalUsd.toFixed(4)}** total Anthropic spend so far.`);
  lines.push(``);
  lines.push(`## Top signals (ranked by raw MW + $M)`);
  lines.push(``);

  for (let i = 0; i < Math.min(ranked.length, 10); i++) {
    const r = ranked[i];
    if (!r) continue;
    const link = linkFor(r.docId);
    lines.push(`### ${i + 1}. ${link.src} — ${link.date}`);
    if (r.mw > 0) lines.push(`- **Capacity:** ${r.mw.toLocaleString()} MW (peak)`);
    if (r.usd > 0) lines.push(`- **Dollar amount:** $${(r.usd / 1_000_000_000).toFixed(2)}B (peak)`);
    if (r.parties.size) lines.push(`- **Parties:** ${Array.from(r.parties).slice(0, 6).join(', ')}`);
    if (r.projects.size) lines.push(`- **Projects:** ${Array.from(r.projects).slice(0, 4).join(', ')}`);
    lines.push(`- **Source:** [${link.ref}](${link.url})`);
    if (r.quotes.length) {
      lines.push(`- **Quotes:**`);
      for (const q of r.quotes.slice(0, 3)) {
        lines.push(`  > ${q.slice(0, 280)}`);
      }
    }
    lines.push(``);
  }

  lines.push(`## Per-agent cost`);
  lines.push(``);
  lines.push(`| Agent | Calls | Input toks | Cache reads | Output toks | USD |`);
  lines.push(`|---|---:|---:|---:|---:|---:|`);
  for (const [k, v] of byAgent) {
    lines.push(`| ${k} | ${v.calls} | ${v.in.toLocaleString()} | ${v.cR.toLocaleString()} | ${v.out.toLocaleString()} | $${v.usd.toFixed(4)} |`);
  }
  lines.push(`| **TOTAL** | | | | | **$${totalUsd.toFixed(4)}** |`);
  lines.push(``);
  lines.push(`## What's not here yet (slice 2+)`);
  lines.push(``);
  lines.push(`- Project Tracking (dedup across documents into one canonical project per real-world site)`);
  lines.push(`- Change Detection (procedural vs substantive flag)`);
  lines.push(`- Real Scoring agent (1-10 + audience tag + why-it-matters)`);
  lines.push(`- Editorial Synthesis (Monday Briefing prose)`);
  lines.push(`- QA cross-check (different model family verifying source_snippet adherence)`);
  lines.push(`- Live Dashboard URL`);
  lines.push(`- Other source families: ERCOT, PUCT, TCEQ, county agendas`);

  const outPath = resolve('docs/SIGNALS_LATEST.md');
  writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`wrote ${outPath} (${lines.length} lines)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
