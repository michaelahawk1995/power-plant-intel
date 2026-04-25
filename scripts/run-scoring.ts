// Scoring: assign 1-10 significance, audience tags, urgency, why-it-matters to each
// substantive change_event without an existing signals row.
//
// Usage:
//   pnpm tsx scripts/run-scoring.ts
//   ONLY_EVENT=12 pnpm tsx scripts/run-scoring.ts
//   INCLUDE_PROCEDURAL=1 pnpm tsx scripts/run-scoring.ts   # also score is_substantive=false events
//
// Per-spec: substantive only by default (procedural events stay db-only).

import { z } from 'zod';
import { loadDotEnv, db, callJsonAgent } from '@ppi/shared';
import { v1 } from '@ppi/prompts';

loadDotEnv();

const ONLY_EVENT = process.env.ONLY_EVENT ? Number(process.env.ONLY_EVENT) : null;
const INCLUDE_PROCEDURAL = process.env.INCLUDE_PROCEDURAL === '1';

const SignalSchema = z.object({
  score: z.number().int().min(1).max(10),
  audiences: z.array(z.enum(['developer', 'oem', 'pe', 'hedge_fund'])).min(1),
  urgency: z.enum(['alert_now', 'digest_only']),
  why_it_matters: z.string().min(20),
  rubric_notes: z.string(),
});

interface Distribution {
  total: number;
  byScore: Map<number, number>;
}

async function loadDistribution(): Promise<Distribution> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const r = await db().from('signals').select('score').gte('ts_scored', sevenDaysAgo);
  const byScore = new Map<number, number>();
  for (const s of r.data ?? []) {
    const sc = (s as any).score as number;
    byScore.set(sc, (byScore.get(sc) ?? 0) + 1);
  }
  const total = (r.data ?? []).length;
  return { total, byScore };
}

function distSummary(d: Distribution): string {
  if (d.total === 0) return 'no signals scored yet this week (cold start)';
  const parts: string[] = [];
  for (let s = 10; s >= 1; s--) {
    const c = d.byScore.get(s) ?? 0;
    if (c) parts.push(`${s}=${c}`);
  }
  const pct7plus = (100 * Array.from(d.byScore.entries()).filter(([s]) => s >= 7).reduce((a, [, c]) => a + c, 0)) / Math.max(1, d.total);
  return `total=${d.total} :: ${parts.join(' ')} :: ${pct7plus.toFixed(0)}% are 7+`;
}

async function loadEventsToScore(): Promise<Array<{ id: number; project_id: number; document_id: number; event_type: string; description: string; before_value: any; after_value: any; is_substantive: boolean; ts_event: string }>> {
  const scored = await db().from('signals').select('change_event_id');
  const scoredIds = new Set<number>((scored.data ?? []).map((s) => (s as any).change_event_id as number));

  let q = db()
    .from('change_events')
    .select('id, project_id, document_id, event_type, description, before_value, after_value, is_substantive, ts_event')
    .order('ts_event', { ascending: true });
  if (ONLY_EVENT) q = q.eq('id', ONLY_EVENT);
  const r = await q;
  if (r.error) throw r.error;
  return ((r.data ?? []) as any[]).filter((e) => !scoredIds.has(e.id) && (INCLUDE_PROCEDURAL || e.is_substantive));
}

async function loadProjectContext(projectId: number): Promise<string> {
  const proj = await db()
    .from('projects')
    .select('canonical_name, primary_party, county, mw_low, mw_high, status, aliases, first_seen_at, last_seen_at')
    .eq('id', projectId)
    .single();
  if (proj.error) throw proj.error;
  const p = proj.data as any;

  const history = await db()
    .from('change_events')
    .select('event_type, description, is_substantive, ts_event')
    .eq('project_id', projectId)
    .order('ts_event', { ascending: true });
  const lines: string[] = [];
  lines.push(`PROJECT CONTEXT`);
  lines.push(`canonical_name: ${p.canonical_name}`);
  lines.push(`primary_party: ${p.primary_party ?? '?'}`);
  lines.push(`county: ${p.county ?? '?'}  status: ${p.status ?? '?'}  mw_band: ${p.mw_low ?? '?'}-${p.mw_high ?? '?'}`);
  if (p.aliases?.length) lines.push(`aliases: ${p.aliases.slice(0, 5).join(' | ')}`);
  lines.push(`first_seen: ${p.first_seen_at?.slice(0, 10)}  last_seen: ${p.last_seen_at?.slice(0, 10)}`);
  lines.push(`history (${(history.data ?? []).length} prior events):`);
  for (const h of history.data ?? []) {
    const x = h as any;
    lines.push(`  - ${x.ts_event?.slice(0, 10)} ${x.event_type} ${x.is_substantive ? '(sub)' : ''}: ${x.description?.slice(0, 100)}`);
  }
  return lines.join('\n');
}

async function loadDocCitation(docId: number): Promise<{ title: string; filed_at: string; src: string; url: string }> {
  const d = await db().from('documents').select('title, filed_at, raw_id').eq('id', docId).single();
  const r = await db().from('raw_queue').select('url, source_id').eq('id', (d.data as any).raw_id).single();
  const s = await db().from('source_registry').select('display_name').eq('id', (r.data as any).source_id).single();
  return {
    title: (d.data as any).title as string,
    filed_at: ((d.data as any).filed_at as string)?.slice(0, 10),
    src: (s.data as any)?.display_name ?? '?',
    url: (r.data as any).url as string,
  };
}

async function score(event: any, projectCtx: string, docInfo: any, distSummaryText: string): Promise<z.infer<typeof SignalSchema>> {
  const lines: string[] = [];
  lines.push(`CHANGE EVENT TO SCORE`);
  lines.push(`type: ${event.event_type}`);
  lines.push(`description: ${event.description}`);
  lines.push(`is_substantive: ${event.is_substantive}`);
  if (event.before_value) lines.push(`before: ${JSON.stringify(event.before_value).slice(0, 400)}`);
  if (event.after_value) lines.push(`after:  ${JSON.stringify(event.after_value).slice(0, 400)}`);
  lines.push(``);
  lines.push(projectCtx);
  lines.push(``);
  lines.push(`SOURCE`);
  lines.push(`document_title: ${docInfo.title}`);
  lines.push(`source: ${docInfo.src}`);
  lines.push(`filed_at: ${docInfo.filed_at}`);
  lines.push(``);
  lines.push(`THIS WEEK'S RUNNING DISTRIBUTION (calibration check)`);
  lines.push(distSummaryText);
  lines.push(``);
  lines.push(`Use the submit_score tool to return your scored signal.`);

  return await callJsonAgent({
    agent: 'scoring',
    model: 'claude-sonnet-4-6',
    systemPrompt: v1.SCORING_SYSTEM,
    userPayload: lines.join('\n'),
    schema: SignalSchema,
    toolName: 'submit_score',
    toolDescription: 'Submit the scored signal: 1-10 score, audiences, urgency, and why-it-matters.',
    maxTokens: 1500,
    cacheSystem: true,
  });
}

async function main() {
  console.log(`\n=== Scoring ===\n`);
  const events = await loadEventsToScore();
  console.log(`${events.length} change_event(s) to score${INCLUDE_PROCEDURAL ? ' (incl. procedural)' : ''}\n`);

  let dist = await loadDistribution();
  console.log(`Distribution: ${distSummary(dist)}\n`);

  const projectCtxCache = new Map<number, string>();
  let scoredCount = 0;

  for (const e of events) {
    let ctx = projectCtxCache.get(e.project_id);
    if (!ctx) {
      ctx = await loadProjectContext(e.project_id);
      projectCtxCache.set(e.project_id, ctx);
    }
    const docInfo = await loadDocCitation(e.document_id);
    try {
      const s = await score(e, ctx, docInfo, distSummary(dist));
      const ins = await db().from('signals').insert({
        change_event_id: e.id,
        project_id: e.project_id,
        score: s.score,
        audiences: s.audiences,
        urgency: s.urgency,
        why_it_matters: s.why_it_matters,
        rubric_version: v1.SCORING_VERSION,
      });
      if (ins.error) {
        console.warn(`  ! insert: ${ins.error.message}`);
        continue;
      }
      scoredCount++;
      // refresh distribution incrementally
      dist.total++;
      dist.byScore.set(s.score, (dist.byScore.get(s.score) ?? 0) + 1);

      const tag = s.urgency === 'alert_now' ? '⚡' : ' ';
      console.log(`  [event ${e.id}] ${tag} score=${s.score}  audiences=${s.audiences.join(',')}  ${e.description.slice(0, 70)}`);
    } catch (err) {
      console.warn(`  ! score failed: ${(err as Error).message}`);
    }
  }

  console.log(`\n=== summary === scored=${scoredCount}  ${distSummary(dist)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
