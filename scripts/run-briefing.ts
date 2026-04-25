// Editorial Synthesis: draft the Monday Briefing from this week's score-5+ signals.
// Output: docs/BRIEFING_LATEST.md + a row in briefings table.
//
// Usage:
//   pnpm tsx scripts/run-briefing.ts
//   WEEK_OF=2026-04-20 pnpm tsx scripts/run-briefing.ts
//   LOOKBACK_DAYS=14 pnpm tsx scripts/run-briefing.ts   # if running mid-week on a backlog
//   MIN_SCORE=4 pnpm tsx scripts/run-briefing.ts        # broaden the pool

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { loadDotEnv, db, ai, recordCost } from '@ppi/shared';
import { v1 } from '@ppi/prompts';

loadDotEnv();

const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 7);
const MIN_SCORE = Number(process.env.MIN_SCORE ?? 5);

function mondayOfWeek(d: Date): string {
  const day = d.getUTCDay(); // 0 sun..6 sat
  const offset = day === 0 ? -6 : 1 - day;
  const m = new Date(d);
  m.setUTCDate(d.getUTCDate() + offset);
  return m.toISOString().slice(0, 10);
}

const WEEK_OF = process.env.WEEK_OF ?? mondayOfWeek(new Date());

interface SignalRow {
  id: number;
  score: number;
  audiences: string[];
  urgency: string;
  why_it_matters: string;
  project_id: number;
  change_event_id: number;
  ts_scored: string;
  // joined
  project_name: string;
  primary_party: string | null;
  county: string | null;
  status: string | null;
  project_first_seen_at: string | null;
  project_last_seen_at: string | null;
  project_mw_low: number | null;
  project_mw_high: number | null;
  event_type: string;
  event_description: string;
  before_value: any;
  after_value: any;
  doc_title: string;
  doc_filed_at: string;
  doc_src: string;
  doc_url: string;
}

async function loadSignals(): Promise<SignalRow[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const sigs = await db()
    .from('signals')
    .select('id, score, audiences, urgency, why_it_matters, project_id, change_event_id, ts_scored')
    .gte('score', MIN_SCORE)
    .gte('ts_scored', since)
    .order('score', { ascending: false })
    .order('ts_scored', { ascending: false });
  if (sigs.error) throw sigs.error;
  if (!sigs.data?.length) return [];

  const eventIds = (sigs.data as any[]).map((s) => s.change_event_id);
  const projIds = Array.from(new Set((sigs.data as any[]).map((s) => s.project_id)));

  const events = await db().from('change_events').select('id, document_id, event_type, description, before_value, after_value').in('id', eventIds);
  const eventById = new Map<number, any>((events.data ?? []).map((e) => [(e as any).id, e]));

  const projects = await db().from('projects').select('id, canonical_name, primary_party, county, status, first_seen_at, last_seen_at, mw_low, mw_high').in('id', projIds);
  const projById = new Map<number, any>((projects.data ?? []).map((p) => [(p as any).id, p]));

  const docIds = Array.from(new Set((events.data ?? []).map((e) => (e as any).document_id)));
  const docs = await db().from('documents').select('id, title, filed_at, raw_id').in('id', docIds);
  const docById = new Map<number, any>((docs.data ?? []).map((d) => [(d as any).id, d]));

  const rawIds = Array.from(new Set((docs.data ?? []).map((d) => (d as any).raw_id)));
  const raws = await db().from('raw_queue').select('id, url, source_id').in('id', rawIds);
  const rawById = new Map<number, any>((raws.data ?? []).map((r) => [(r as any).id, r]));

  const srcIds = Array.from(new Set((raws.data ?? []).map((r) => (r as any).source_id)));
  const srcs = await db().from('source_registry').select('id, display_name').in('id', srcIds);
  const srcById = new Map<number, string>((srcs.data ?? []).map((s) => [(s as any).id, (s as any).display_name as string]));

  const out: SignalRow[] = [];
  for (const s of sigs.data as any[]) {
    const ev = eventById.get(s.change_event_id);
    const pj = projById.get(s.project_id);
    const dc = ev ? docById.get(ev.document_id) : null;
    const rw = dc ? rawById.get(dc.raw_id) : null;
    const sr = rw ? srcById.get(rw.source_id) : '?';
    out.push({
      id: s.id,
      score: s.score,
      audiences: s.audiences,
      urgency: s.urgency,
      why_it_matters: s.why_it_matters,
      project_id: s.project_id,
      change_event_id: s.change_event_id,
      ts_scored: s.ts_scored,
      project_name: pj?.canonical_name ?? '?',
      primary_party: pj?.primary_party ?? null,
      county: pj?.county ?? null,
      status: pj?.status ?? null,
      project_first_seen_at: pj?.first_seen_at ?? null,
      project_last_seen_at: pj?.last_seen_at ?? null,
      project_mw_low: pj?.mw_low ?? null,
      project_mw_high: pj?.mw_high ?? null,
      event_type: ev?.event_type ?? '?',
      event_description: ev?.description ?? '?',
      before_value: ev?.before_value ?? null,
      after_value: ev?.after_value ?? null,
      doc_title: dc?.title ?? '?',
      doc_filed_at: (dc?.filed_at as string)?.slice(0, 10) ?? '?',
      doc_src: sr ?? '?',
      doc_url: rw?.url ?? '#',
    });
  }
  return out;
}

function packSignals(rows: SignalRow[]): string {
  const lines: string[] = [];
  for (const s of rows) {
    const mwBand = s.project_mw_low != null || s.project_mw_high != null ? `${s.project_mw_low ?? '?'}–${s.project_mw_high ?? '?'} MW` : 'no MW band';
    const mwSpan = s.project_mw_low && s.project_mw_high ? s.project_mw_high / Math.max(1, s.project_mw_low) : null;
    const mwSpanFlag = mwSpan && mwSpan > 3 ? `  ⚠ WIDE_BAND (${mwSpan.toFixed(1)}× span — RULE 1: do NOT print this band as a real figure)` : '';
    const firstSeen = s.project_first_seen_at?.slice(0, 10) ?? '?';
    const docFiled = s.doc_filed_at;
    const ageInDb = s.project_first_seen_at ? Math.floor((Date.now() - new Date(s.project_first_seen_at).getTime()) / (24 * 60 * 60 * 1000)) : null;
    const newVsExisting = (() => {
      if (s.status === 'energized' || s.status === 'under_construction') return 'EXISTING_ASSET (apply RULE 2: do not call "new")';
      if (ageInDb != null && ageInDb <= 14 && (s.status === 'rumored' || s.status === 'filed')) return 'GENUINELY_NEW';
      return 'AMBIGUOUS — read source quote in why_it_matters before framing';
    })();

    lines.push(`### sig-${s.id}  score=${s.score}  urgency=${s.urgency}  audiences=[${s.audiences.join(',')}]`);
    lines.push(`project: ${s.project_name} (id=${s.project_id})  party=${s.primary_party ?? '?'}  county=${s.county ?? '?'}  status=${s.status ?? '?'}`);
    lines.push(`project_mw_band: ${mwBand}${mwSpanFlag}`);
    lines.push(`first_observed_by_us: ${firstSeen}  (project age in our DB: ${ageInDb ?? '?'} days)`);
    lines.push(`framing_hint: ${newVsExisting}`);
    lines.push(`event: ${s.event_type} — ${s.event_description}`);
    if (s.before_value) lines.push(`before: ${JSON.stringify(s.before_value).slice(0, 280)}`);
    if (s.after_value) lines.push(`after:  ${JSON.stringify(s.after_value).slice(0, 280)}`);
    lines.push(`why_it_matters: ${s.why_it_matters}`);
    lines.push(`source: ${s.doc_src} — ${s.doc_title} (filed ${docFiled})`);
    lines.push(`url: ${s.doc_url}`);
    lines.push(``);
  }
  return lines.join('\n');
}

async function main() {
  console.log(`\n=== Editorial Synthesis ===`);
  console.log(`week_of=${WEEK_OF}  lookback=${LOOKBACK_DAYS}d  min_score=${MIN_SCORE}\n`);

  const signals = await loadSignals();
  if (signals.length === 0) {
    console.log(`No signals at score ${MIN_SCORE}+ in last ${LOOKBACK_DAYS}d. Nothing to synthesize.`);
    return;
  }
  console.log(`${signals.length} signals in pool (top score ${signals[0]?.score})\n`);

  const userPayload = `WEEK_OF: ${WEEK_OF}\nMIN_SCORE_INCLUDED: ${MIN_SCORE}\n\nSIGNALS (sorted by score desc):\n\n${packSignals(signals)}\n\nDraft the Monday Briefing now. Cite every numeric claim with [#sig-N].`;

  const client = ai();
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: v1.EDITORIAL_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPayload }],
  });
  await recordCost({ agent: 'editorial', model: 'claude-sonnet-4-6', usage: resp.usage, request_id: resp.id });

  // Concatenate any text blocks (adaptive thinking can interleave thinking and text)
  const draft = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  console.log(`response stop_reason=${resp.stop_reason}  output_tokens=${resp.usage.output_tokens}  text_blocks=${resp.content.filter((b) => b.type === 'text').length}  thinking_blocks=${resp.content.filter((b) => b.type === 'thinking').length}`);
  if (!draft) {
    console.warn('Editorial returned empty draft');
    return;
  }

  // Insert briefing
  const sigIds = signals.map((s) => s.id);
  const ins = await db()
    .from('briefings')
    .upsert(
      { week_of: WEEK_OF, draft_md: draft, source_signal_ids: sigIds, qa_passed: false },
      { onConflict: 'week_of' }
    )
    .select('id')
    .single();
  if (ins.error) {
    console.warn(`briefings insert: ${ins.error.message}`);
  } else {
    console.log(`briefings row id=${(ins.data as any).id}  week_of=${WEEK_OF}  signals=${sigIds.length}`);
  }

  // Write to docs/
  const outPath = resolve('docs/BRIEFING_LATEST.md');
  writeFileSync(outPath, draft, 'utf8');
  console.log(`wrote ${outPath} (${draft.length} chars)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
