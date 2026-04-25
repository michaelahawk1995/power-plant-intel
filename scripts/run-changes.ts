// Change Detection: for each (project, document) link without a change_event, emit
// one typed event describing what (if anything) materially changed vs prior state.
//
// First link on a project → automatic "new_project" event (no LLM call).
// Subsequent links → Sonnet CHANGE_SYSTEM with prior state vs new doc.
//
// Usage:
//   pnpm tsx scripts/run-changes.ts
//   ONLY_PROJECT=12 pnpm tsx scripts/run-changes.ts

import { z } from 'zod';
import { loadDotEnv, db, callJsonAgent } from '@ppi/shared';
import { v1 } from '@ppi/prompts';

loadDotEnv();

const ONLY_PROJECT = process.env.ONLY_PROJECT ? Number(process.env.ONLY_PROJECT) : null;

const ChangeSchema = z.object({
  event_type: z.enum([
    'new_project',
    'mw_change',
    'party_change',
    'status_change',
    'date_change',
    'document_added',
    'withdrawal',
    'deposit_event',
    'cancelled',
  ]),
  description: z.string(),
  before_value: z.unknown().nullable().optional(),
  after_value: z.unknown().nullable().optional(),
  is_substantive: z.boolean(),
  reason: z.string(),
});

interface PriorState {
  canonical_name: string;
  primary_party: string | null;
  county: string | null;
  mw_low: number | null;
  mw_high: number | null;
  status: string | null;
  last_doc_filed_at: string | null;
  parties: string[];
  docCount: number;
}

async function loadProjectsToProcess(): Promise<number[]> {
  let q = db().from('projects').select('id');
  if (ONLY_PROJECT) q = q.eq('id', ONLY_PROJECT);
  const r = await q;
  if (r.error) throw r.error;
  return (r.data ?? []).map((p) => (p as any).id as number);
}

async function loadProjectLinks(projectId: number): Promise<Array<{ document_id: number; ts_linked: string }>> {
  const r = await db()
    .from('project_signals')
    .select('document_id, ts_linked')
    .eq('project_id', projectId)
    .order('ts_linked', { ascending: true });
  if (r.error) throw r.error;
  return (r.data ?? []) as any[];
}

async function loadExistingChanges(projectId: number): Promise<Set<number>> {
  const r = await db().from('change_events').select('document_id').eq('project_id', projectId);
  if (r.error) throw r.error;
  return new Set<number>((r.data ?? []).map((x) => (x as any).document_id as number));
}

async function loadDocSummary(docId: number): Promise<{ title: string; filed_at: string; meta: any; parties: string[]; mws: number[]; status_hints: string[]; quotes: string[] }> {
  const d = await db().from('documents').select('title, filed_at, raw_id').eq('id', docId).single();
  if (d.error) throw d.error;
  const r = await db().from('raw_queue').select('meta').eq('id', (d.data as any).raw_id).single();
  const ext = await db()
    .from('extractions')
    .select('kind, value_text, value_num, source_snippet, confidence')
    .eq('document_id', docId);
  const parties = new Set<string>();
  const mws: number[] = [];
  const status_hints: string[] = [];
  const quotes: string[] = [];
  for (const f of ext.data ?? []) {
    const k = (f as any).kind as string;
    const vt = (f as any).value_text as string | null;
    const vn = (f as any).value_num as number | null;
    const sn = (f as any).source_snippet as string | null;
    if (k === 'party' && vt) parties.add(vt);
    if (k === 'mw' && vn != null) mws.push(Number(vn));
    if (k === 'action' && vt) status_hints.push(vt);
    if (sn && quotes.length < 6) quotes.push(sn);
  }
  return {
    title: (d.data as any).title as string,
    filed_at: (d.data as any).filed_at as string,
    meta: (r.data as any)?.meta ?? {},
    parties: Array.from(parties),
    mws,
    status_hints,
    quotes,
  };
}

async function buildPriorState(projectId: number, beforeDocIds: number[]): Promise<PriorState> {
  const proj = await db()
    .from('projects')
    .select('canonical_name, primary_party, county, mw_low, mw_high, status')
    .eq('id', projectId)
    .single();
  if (proj.error) throw proj.error;

  let lastFiled: string | null = null;
  const partySet = new Set<string>();
  if (beforeDocIds.length) {
    const docs = await db().from('documents').select('id, filed_at').in('id', beforeDocIds);
    for (const d of docs.data ?? []) {
      const f = (d as any).filed_at as string | null;
      if (f && (!lastFiled || f > lastFiled)) lastFiled = f;
    }
    const ext = await db().from('extractions').select('value_text').eq('kind', 'party').in('document_id', beforeDocIds);
    for (const e of ext.data ?? []) {
      const v = (e as any).value_text as string | null;
      if (v) partySet.add(v);
    }
  }

  return {
    canonical_name: (proj.data as any).canonical_name as string,
    primary_party: (proj.data as any).primary_party as string | null,
    county: (proj.data as any).county as string | null,
    mw_low: (proj.data as any).mw_low as number | null,
    mw_high: (proj.data as any).mw_high as number | null,
    status: (proj.data as any).status as string | null,
    last_doc_filed_at: lastFiled,
    parties: Array.from(partySet),
    docCount: beforeDocIds.length,
  };
}

async function decide(prior: PriorState, doc: Awaited<ReturnType<typeof loadDocSummary>>): Promise<z.infer<typeof ChangeSchema>> {
  const lines: string[] = [];
  lines.push(`PRIOR PROJECT STATE`);
  lines.push(`canonical_name: ${prior.canonical_name}`);
  lines.push(`primary_party: ${prior.primary_party ?? '?'}`);
  lines.push(`county: ${prior.county ?? '?'}`);
  lines.push(`mw_band: ${prior.mw_low ?? '?'}-${prior.mw_high ?? '?'}`);
  lines.push(`status: ${prior.status ?? '?'}`);
  lines.push(`prior_parties_seen: ${prior.parties.join(' | ') || '(none)'}`);
  lines.push(`last_doc_filed_at: ${prior.last_doc_filed_at ?? '(none)'}`);
  lines.push(`prior_doc_count: ${prior.docCount}`);
  lines.push(``);
  lines.push(`NEW DOCUMENT`);
  lines.push(`title: ${doc.title}`);
  lines.push(`filed_at: ${doc.filed_at}`);
  if (doc.meta?.form) lines.push(`form: ${doc.meta.form}`);
  if (doc.meta?.items) lines.push(`items: ${Array.isArray(doc.meta.items) ? doc.meta.items.join(',') : doc.meta.items}`);
  if (doc.parties.length) lines.push(`new_doc_parties: ${doc.parties.join(' | ')}`);
  if (doc.mws.length) lines.push(`new_doc_mw_values: ${doc.mws.join(', ')}`);
  if (doc.status_hints.length) lines.push(`action_signals: ${doc.status_hints.slice(0, 5).join(' | ')}`);
  if (doc.quotes.length) {
    lines.push(`representative_quotes:`);
    for (const q of doc.quotes.slice(0, 3)) lines.push(`  > ${q.slice(0, 240)}`);
  }
  lines.push(``);
  lines.push(`Use the submit_change tool to return your typed event.`);

  return await callJsonAgent({
    agent: 'change',
    model: 'claude-sonnet-4-6',
    systemPrompt: v1.CHANGE_SYSTEM,
    userPayload: lines.join('\n'),
    schema: ChangeSchema,
    toolName: 'submit_change',
    toolDescription: 'Submit the typed change event with materiality flag.',
    maxTokens: 1500,
    cacheSystem: true,
  });
}

async function main() {
  console.log(`\n=== Change Detection ===\n`);
  const projectIds = await loadProjectsToProcess();
  console.log(`${projectIds.length} project(s) to scan\n`);

  let newProjects = 0,
    substantive = 0,
    procedural = 0,
    skipped = 0;

  for (const pid of projectIds) {
    const links = await loadProjectLinks(pid);
    const done = await loadExistingChanges(pid);

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      if (!link) continue;
      if (done.has(link.document_id)) {
        skipped++;
        continue;
      }

      // First link → auto new_project event
      if (i === 0) {
        const proj = await db().from('projects').select('canonical_name, primary_party, mw_low, mw_high, county, status').eq('id', pid).single();
        const ins = await db().from('change_events').insert({
          project_id: pid,
          document_id: link.document_id,
          event_type: 'new_project',
          description: `Project first observed: ${(proj.data as any)?.canonical_name ?? '(unnamed)'}`,
          before_value: null,
          after_value: proj.data,
          is_substantive: true,
          ts_event: new Date().toISOString(),
        });
        if (ins.error) console.warn(`  ! ${ins.error.message}`);
        newProjects++;
        console.log(`  [proj ${pid}] new_project (doc ${link.document_id})`);
        continue;
      }

      const beforeDocs = links.slice(0, i).map((l) => l.document_id);
      const prior = await buildPriorState(pid, beforeDocs);
      const docSummary = await loadDocSummary(link.document_id);

      try {
        const v = await decide(prior, docSummary);
        const ins = await db().from('change_events').insert({
          project_id: pid,
          document_id: link.document_id,
          event_type: v.event_type,
          description: v.description,
          before_value: (v.before_value as any) ?? null,
          after_value: (v.after_value as any) ?? null,
          is_substantive: v.is_substantive,
          ts_event: new Date().toISOString(),
        });
        if (ins.error) {
          console.warn(`  ! insert: ${ins.error.message}`);
          continue;
        }
        if (v.is_substantive) substantive++;
        else procedural++;
        console.log(`  [proj ${pid}] ${v.event_type.padEnd(15)} sub=${v.is_substantive ? 'Y' : 'n'}  ${v.description.slice(0, 80)}`);
      } catch (e) {
        console.warn(`  ! decide failed: ${(e as Error).message}`);
      }
    }
  }

  console.log(`\n=== summary === new_project=${newProjects}  substantive=${substantive}  procedural=${procedural}  already_done=${skipped}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
