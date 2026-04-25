// Project Tracking: resolve each document's extractions into canonical projects.
//
// Strategy:
//   1. For each document not yet linked in project_signals, group its extractions by
//      project_name (explicit mentions) into "candidates". If no project_name facts,
//      fall back to a single doc-wide candidate keyed on the filer party.
//   2. For each candidate, look up top-K existing projects by name/alias overlap.
//   3. Ask Sonnet TRACKING_SYSTEM to merge, create, or flag ambiguous.
//   4. Apply the verdict: insert into projects (create) and project_signals (link).
//
// Usage:
//   pnpm tsx scripts/run-tracking.ts                # all unlinked docs
//   ONLY_DOC=12 pnpm tsx scripts/run-tracking.ts    # one document
//   DRY_RUN=1 pnpm tsx scripts/run-tracking.ts      # log decisions, write nothing

import { z } from 'zod';
import { loadDotEnv, db, callJsonAgent } from '@ppi/shared';
import { v1 } from '@ppi/prompts';

loadDotEnv();

const ONLY_DOC = process.env.ONLY_DOC ? Number(process.env.ONLY_DOC) : null;
const DRY_RUN = process.env.DRY_RUN === '1';

const TopKExisting = 5;

const VerdictSchema = z.object({
  verdict: z.enum(['merge', 'create', 'ambiguous']),
  project_id: z.number().nullable().optional(),
  candidate_ids_for_review: z.array(z.number()).nullable().optional(),
  create: z
    .object({
      canonical_name: z.string(),
      primary_party: z.string().nullable().optional(),
      aliases: z.array(z.string()).default([]),
      county: z.string().nullable().optional(),
      mw_low: z.number().nullable().optional(),
      mw_high: z.number().nullable().optional(),
      status: z
        .enum(['rumored', 'filed', 'permitted', 'under_construction', 'energized', 'cancelled'])
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  reason: z.string(),
});

interface DocCandidate {
  documentId: number;
  filerParty: string;
  filerCounty: string | null;
  candidateName: string | null; // null = doc-wide candidate
  parties: string[];
  projects: string[];
  mwValues: number[];
  usdValues: number[];
  locations: string[];
  topQuotes: string[];
}

async function loadDocsToTrack(): Promise<Array<{ id: number; title: string; filerParty: string }>> {
  const linked = await db().from('project_signals').select('document_id');
  const linkedIds = new Set<number>((linked.data ?? []).map((r) => (r as any).document_id as number));

  let q = db()
    .from('documents')
    .select('id, title, raw_id, filed_at')
    .order('filed_at', { ascending: false });
  if (ONLY_DOC) q = q.eq('id', ONLY_DOC);

  const docs = await q;
  if (docs.error) throw docs.error;

  const rawIds = Array.from(new Set((docs.data ?? []).map((d) => (d as any).raw_id as number)));
  const raws = await db().from('raw_queue').select('id, source_id').in('id', rawIds);
  const rawById = new Map<number, number>((raws.data ?? []).map((r) => [(r as any).id as number, (r as any).source_id as number]));
  const srcIds = Array.from(new Set([...rawById.values()]));
  const srcs = await db().from('source_registry').select('id, display_name').in('id', srcIds);
  const srcById = new Map<number, string>((srcs.data ?? []).map((s) => [(s as any).id as number, (s as any).display_name as string]));

  const result: Array<{ id: number; title: string; filerParty: string }> = [];
  for (const d of docs.data ?? []) {
    const docId = (d as any).id as number;
    if (linkedIds.has(docId) && !ONLY_DOC) continue;
    const srcId = rawById.get((d as any).raw_id as number);
    const filer = (srcId && srcById.get(srcId)) || 'unknown filer';
    result.push({ id: docId, title: (d as any).title as string, filerParty: filer });
  }
  return result;
}

async function buildCandidatesForDoc(doc: { id: number; title: string; filerParty: string }): Promise<DocCandidate[]> {
  const ext = await db()
    .from('extractions')
    .select('kind, value_text, value_num, value_unit, source_snippet, confidence')
    .eq('document_id', doc.id);
  if (ext.error) throw ext.error;
  const facts = ext.data ?? [];

  const projectNames = new Set<string>();
  const parties = new Set<string>();
  const locations = new Set<string>();
  const mws: number[] = [];
  const usds: number[] = [];
  const quotes: string[] = [];

  for (const f of facts) {
    const k = (f as any).kind as string;
    const vt = (f as any).value_text as string | null;
    const vn = (f as any).value_num as number | null;
    const sn = (f as any).source_snippet as string | null;
    if (k === 'project_name' && vt) projectNames.add(vt);
    if (k === 'party' && vt) parties.add(vt);
    if (k === 'location' && vt) locations.add(vt);
    if (k === 'mw' && vn != null) mws.push(Number(vn));
    if (k === 'usd' && vn != null) usds.push(Number(vn));
    if (sn && quotes.length < 6) quotes.push(sn);
  }

  // County guess: pick the most TX-county-looking location string.
  const countyGuess = Array.from(locations).find((l) => /county/i.test(l)) ?? null;

  const partiesArr = Array.from(parties);
  const projectsArr = Array.from(projectNames);

  if (projectsArr.length === 0) {
    return [
      {
        documentId: doc.id,
        filerParty: doc.filerParty,
        filerCounty: countyGuess,
        candidateName: null,
        parties: partiesArr,
        projects: [],
        mwValues: mws,
        usdValues: usds,
        locations: Array.from(locations),
        topQuotes: quotes,
      },
    ];
  }

  // One candidate per distinct named project. Each shares all other facts.
  return projectsArr.map((p) => ({
    documentId: doc.id,
    filerParty: doc.filerParty,
    filerCounty: countyGuess,
    candidateName: p,
    parties: partiesArr,
    projects: projectsArr,
    mwValues: mws,
    usdValues: usds,
    locations: Array.from(locations),
    topQuotes: quotes,
  }));
}

async function findExistingCandidates(c: DocCandidate): Promise<Array<{ id: number; canonical_name: string; primary_party: string | null; aliases: string[]; county: string | null; mw_low: number | null; mw_high: number | null; status: string | null }>> {
  const matches = new Map<number, any>();

  async function add(rows: any[] | null | undefined) {
    for (const r of rows ?? []) matches.set(r.id, r);
  }

  // (a) Name match if candidateName present
  if (c.candidateName) {
    const n = c.candidateName.replace(/[%_]/g, '').trim();
    if (n.length >= 3) {
      const r = await db()
        .from('projects')
        .select('id, canonical_name, primary_party, aliases, county, mw_low, mw_high, status')
        .ilike('canonical_name', `%${n}%`)
        .limit(TopKExisting);
      await add(r.data);
    }
  }

  // (b) Primary-party match against filer
  const partyKeys = [c.filerParty, ...c.parties].filter(Boolean);
  for (const p of partyKeys.slice(0, 3)) {
    const clean = p.replace(/[%_]/g, '').trim();
    if (clean.length < 3) continue;
    const r = await db()
      .from('projects')
      .select('id, canonical_name, primary_party, aliases, county, mw_low, mw_high, status')
      .ilike('primary_party', `%${clean}%`)
      .limit(TopKExisting);
    await add(r.data);
  }

  // (c) Alias overlap
  for (const p of partyKeys.slice(0, 3)) {
    const clean = p.replace(/[%_]/g, '').trim();
    if (clean.length < 3) continue;
    const r = await db()
      .from('projects')
      .select('id, canonical_name, primary_party, aliases, county, mw_low, mw_high, status')
      .contains('aliases', [clean])
      .limit(TopKExisting);
    await add(r.data);
  }

  return Array.from(matches.values()).slice(0, TopKExisting);
}

function summarizeCandidate(c: DocCandidate): string {
  const lines: string[] = [];
  lines.push(`candidate_name: ${c.candidateName ?? '(no explicit project name)'}`);
  lines.push(`filer_party: ${c.filerParty}`);
  if (c.parties.length) lines.push(`parties_named: ${c.parties.join(' | ')}`);
  if (c.projects.length) lines.push(`other_projects_in_doc: ${c.projects.filter((p) => p !== c.candidateName).join(' | ')}`);
  if (c.mwValues.length) lines.push(`mw_values: ${c.mwValues.slice(0, 6).join(', ')}`);
  if (c.usdValues.length) lines.push(`usd_values: ${c.usdValues.slice(0, 6).map((v) => `$${(v / 1e9).toFixed(2)}B`).join(', ')}`);
  if (c.locations.length) lines.push(`locations: ${c.locations.slice(0, 4).join(' | ')}`);
  if (c.filerCounty) lines.push(`county_guess: ${c.filerCounty}`);
  if (c.topQuotes.length) {
    lines.push(`quotes:`);
    for (const q of c.topQuotes.slice(0, 3)) lines.push(`  > ${q.slice(0, 240)}`);
  }
  return lines.join('\n');
}

function summarizeExisting(rows: any[]): string {
  if (rows.length === 0) return '(no existing projects matched)';
  return rows
    .map(
      (r) =>
        `- id=${r.id} | name="${r.canonical_name}" | party="${r.primary_party ?? ''}" | aliases=[${(r.aliases ?? []).slice(0, 3).join(', ')}] | county=${r.county ?? '?'} | mw=${r.mw_low ?? '?'}-${r.mw_high ?? '?'} | status=${r.status ?? '?'}`
    )
    .join('\n');
}

async function decide(c: DocCandidate, existing: any[]): Promise<z.infer<typeof VerdictSchema>> {
  const userPayload = `NEW CANDIDATE\n${summarizeCandidate(c)}\n\nEXISTING TOP-${existing.length} CANDIDATES\n${summarizeExisting(existing)}\n\nUse the submit_decision tool to return your verdict.`;
  return await callJsonAgent({
    agent: 'tracking',
    model: 'claude-sonnet-4-6',
    systemPrompt: v1.TRACKING_SYSTEM,
    userPayload,
    schema: VerdictSchema,
    toolName: 'submit_decision',
    toolDescription: 'Submit the merge/create/ambiguous verdict for this project candidate.',
    maxTokens: 1500,
    cacheSystem: true,
  });
}

async function applyVerdict(doc: { id: number }, c: DocCandidate, v: z.infer<typeof VerdictSchema>): Promise<{ projectId: number | null; action: string }> {
  if (DRY_RUN) {
    console.log(`    DRY: ${v.verdict} :: ${v.reason}`);
    return { projectId: null, action: `dry-${v.verdict}` };
  }

  if (v.verdict === 'merge' && v.project_id) {
    const link = await db()
      .from('project_signals')
      .upsert(
        { project_id: v.project_id, document_id: doc.id, link_reason: v.reason, link_kind: 'auto' },
        { onConflict: 'project_id,document_id' }
      );
    if (link.error) throw link.error;
    await db().from('projects').update({ last_seen_at: new Date().toISOString() }).eq('id', v.project_id);
    return { projectId: v.project_id, action: 'merge' };
  }

  if (v.verdict === 'create' && v.create) {
    const create = v.create;
    const aliases = Array.from(new Set([...(create.aliases ?? []), ...(c.candidateName ? [c.candidateName] : [])]));
    const ins = await db()
      .from('projects')
      .insert({
        canonical_name: create.canonical_name,
        primary_party: create.primary_party ?? c.filerParty,
        aliases,
        county: create.county ?? c.filerCounty,
        state: 'TX',
        mw_low: create.mw_low ?? (c.mwValues.length ? Math.min(...c.mwValues) : null),
        mw_high: create.mw_high ?? (c.mwValues.length ? Math.max(...c.mwValues) : null),
        status: create.status ?? 'filed',
      })
      .select('id')
      .single();
    if (ins.error) throw ins.error;
    const projectId = (ins.data as any).id as number;
    const link = await db()
      .from('project_signals')
      .insert({ project_id: projectId, document_id: doc.id, link_reason: v.reason, link_kind: 'auto' });
    if (link.error) throw link.error;
    return { projectId, action: 'create' };
  }

  // ambiguous → no link, log via qa_flags so a human can review
  await db().from('qa_flags').insert({
    target_table: 'project_signals',
    target_id: doc.id,
    passed: false,
    issues: [{ kind: 'ambiguous_tracking', candidate: c.candidateName ?? '(doc-wide)', candidates: v.candidate_ids_for_review ?? [], reason: v.reason }],
    qa_model: 'tracking_v1.0',
  });
  return { projectId: null, action: 'ambiguous' };
}

async function main() {
  console.log(`\n=== Project Tracking ===\n`);
  const docs = await loadDocsToTrack();
  console.log(`${docs.length} document(s) to track${ONLY_DOC ? ` (forced)` : ''}\n`);

  let merges = 0,
    creates = 0,
    ambiguous = 0,
    candidates = 0;

  for (const doc of docs) {
    console.log(`[doc ${doc.id}] ${doc.title.slice(0, 80)}  filer=${doc.filerParty}`);
    const cands = await buildCandidatesForDoc(doc);
    if (cands.length === 0) {
      console.log(`  (no facts to track on)`);
      continue;
    }
    for (const c of cands) {
      candidates++;
      const existing = await findExistingCandidates(c);
      try {
        const v = await decide(c, existing);
        const r = await applyVerdict(doc, c, v);
        if (r.action === 'merge') merges++;
        else if (r.action === 'create') creates++;
        else if (r.action === 'ambiguous') ambiguous++;
        const tag = c.candidateName ? `"${c.candidateName.slice(0, 40)}"` : '(doc-wide)';
        console.log(`  → ${r.action.padEnd(9)} ${tag}  → project_id=${r.projectId ?? '-'}`);
      } catch (e) {
        console.warn(`  ! decide failed: ${(e as Error).message}`);
      }
    }
  }

  console.log(`\n=== summary === candidates=${candidates}  merges=${merges}  creates=${creates}  ambiguous=${ambiguous}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
