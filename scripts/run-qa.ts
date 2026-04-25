// Internal QA: cross-check upstream output.
// Runs two checks:
//   1. Briefing QA: validate the latest briefing draft against its source signals.
//   2. Extraction QA: sample N recent extractions, verify source_snippet ⊂ chunk text + value consistency.
//
// IMPORTANT — per spec the QA agent must run on a DIFFERENT model family from the one
// being audited. Slice 1 uses Anthropic Sonnet for upstream work. Without a Gemini key
// (see RUNBOOK open task), we use Haiku as a same-family proxy. This is a known
// weakness — different model size catches some failure modes (verbatim quote check,
// JSON-shape sanity) but won't catch shared training-distribution biases. Swap to
// Gemini Flash by changing QA_MODEL when GEMINI_API_KEY is provided.
//
// Usage:
//   pnpm tsx scripts/run-qa.ts                  # both checks
//   QA_TARGET=briefing pnpm tsx scripts/run-qa.ts
//   QA_TARGET=extraction QA_SAMPLE=20 pnpm tsx scripts/run-qa.ts

import { z } from 'zod';
import { loadDotEnv, db, callJsonAgent } from '@ppi/shared';
import { v1 } from '@ppi/prompts';

loadDotEnv();

const QA_TARGET = process.env.QA_TARGET ?? 'all';
const QA_SAMPLE = Number(process.env.QA_SAMPLE ?? 12);
const QA_MODEL = 'claude-haiku-4-5'; // same-family proxy for Gemini Flash; swap when key present

const BriefingQASchema = z.object({
  passed: z.boolean(),
  issues: z.array(z.object({ section: z.string(), issue: z.string() })).default([]),
  summary: z.string(),
});

const ExtractionQASchema = z.object({
  passed: z.boolean(),
  fact_results: z.array(z.object({ fact_id_index: z.number().int(), ok: z.boolean(), issue: z.string() })).default([]),
  summary: z.string(),
});

async function qaBriefing() {
  console.log(`\n--- QA: latest briefing ---`);
  const b = await db().from('briefings').select('id, week_of, draft_md, source_signal_ids, qa_passed').order('week_of', { ascending: false }).limit(1).maybeSingle();
  if (b.error) throw b.error;
  if (!b.data) {
    console.log(`(no briefing in db)`);
    return;
  }
  const briefing = b.data as any;
  const sigIds: number[] = briefing.source_signal_ids ?? [];
  if (sigIds.length === 0) {
    console.log(`briefing ${briefing.id} has no source_signal_ids; skipping`);
    return;
  }

  const sigs = await db()
    .from('signals')
    .select('id, score, audiences, urgency, why_it_matters, project_id, change_event_id')
    .in('id', sigIds);
  const events = await db().from('change_events').select('id, document_id, event_type, description, before_value, after_value').in('id', (sigs.data ?? []).map((s) => (s as any).change_event_id));
  const eventById = new Map<number, any>((events.data ?? []).map((e) => [(e as any).id, e]));
  const projects = await db().from('projects').select('id, canonical_name, primary_party').in('id', (sigs.data ?? []).map((s) => (s as any).project_id));
  const projById = new Map<number, any>((projects.data ?? []).map((p) => [(p as any).id, p]));
  const docs = await db().from('documents').select('id, title, raw_id').in('id', (events.data ?? []).map((e) => (e as any).document_id));
  const docById = new Map<number, any>((docs.data ?? []).map((d) => [(d as any).id, d]));
  const raws = await db().from('raw_queue').select('id, url').in('id', (docs.data ?? []).map((d) => (d as any).raw_id));
  const rawById = new Map<number, any>((raws.data ?? []).map((r) => [(r as any).id, r]));

  const sigLines: string[] = [];
  for (const s of sigs.data ?? []) {
    const sig = s as any;
    const ev = eventById.get(sig.change_event_id);
    const pj = projById.get(sig.project_id);
    const dc = ev ? docById.get(ev.document_id) : null;
    const rw = dc ? rawById.get(dc.raw_id) : null;
    sigLines.push(`#sig-${sig.id} [score=${sig.score}] project="${pj?.canonical_name}" event=${ev?.event_type}: ${ev?.description}`);
    if (ev?.before_value) sigLines.push(`  before: ${JSON.stringify(ev.before_value).slice(0, 200)}`);
    if (ev?.after_value) sigLines.push(`  after:  ${JSON.stringify(ev.after_value).slice(0, 200)}`);
    sigLines.push(`  why: ${sig.why_it_matters}`);
    sigLines.push(`  source: ${dc?.title} :: ${rw?.url}`);
  }

  const userPayload = `BRIEFING DRAFT:\n\n${briefing.draft_md}\n\n---\n\nSOURCE SIGNALS:\n\n${sigLines.join('\n')}\n\nUse the submit_qa tool.`;

  let parsed: z.infer<typeof BriefingQASchema>;
  try {
    parsed = await callJsonAgent({
      agent: 'qa',
      model: QA_MODEL,
      systemPrompt: v1.QA_BRIEFING_SYSTEM,
      userPayload,
      schema: BriefingQASchema,
      toolName: 'submit_qa',
      toolDescription: 'Submit the briefing QA verdict (passed + issues list).',
      maxTokens: 2000,
      cacheSystem: true,
    });
  } catch (e) {
    console.warn(`  briefing QA error: ${(e as Error).message}`);
    return;
  }

  await db().from('qa_flags').insert({
    target_table: 'briefings',
    target_id: briefing.id,
    passed: parsed.passed,
    issues: parsed.issues,
    qa_model: QA_MODEL,
  });
  await db().from('briefings').update({ qa_passed: parsed.passed }).eq('id', briefing.id);
  console.log(`briefing ${briefing.id} (${briefing.week_of}): passed=${parsed.passed}  issues=${parsed.issues.length}  — ${parsed.summary}`);
  for (const iss of parsed.issues.slice(0, 5)) {
    console.log(`  · [${iss.section}] ${iss.issue}`);
  }
}

async function qaExtractions() {
  console.log(`\n--- QA: extraction sample (n=${QA_SAMPLE}) ---`);
  // Pull N most recent unique chunks that produced extractions; group facts by chunk.
  const recent = await db()
    .from('extractions')
    .select('id, chunk_id, kind, value_text, value_num, value_unit, source_snippet, confidence')
    .order('ts_inserted', { ascending: false })
    .limit(QA_SAMPLE * 8); // overfetch then group
  if (recent.error) throw recent.error;

  const factsByChunk = new Map<number, any[]>();
  for (const f of recent.data ?? []) {
    const c = (f as any).chunk_id as number;
    if (!factsByChunk.has(c)) factsByChunk.set(c, []);
    factsByChunk.get(c)!.push(f);
    if (factsByChunk.size >= QA_SAMPLE) break;
  }
  const chunkIds = Array.from(factsByChunk.keys()).slice(0, QA_SAMPLE);
  const chunks = await db().from('document_chunks').select('id, text').in('id', chunkIds);
  const textByChunk = new Map<number, string>((chunks.data ?? []).map((c) => [(c as any).id, (c as any).text as string]));

  let totalChecked = 0;
  let failedChunks = 0;
  let failedFacts = 0;

  for (const cid of chunkIds) {
    const facts = factsByChunk.get(cid) ?? [];
    const text = textByChunk.get(cid);
    if (!text) continue;

    const factPayload = facts
      .map((f, idx) => `${idx}: kind=${f.kind} value_text=${JSON.stringify(f.value_text)} value_num=${f.value_num} unit=${f.value_unit} confidence=${f.confidence}\n   snippet=${JSON.stringify(f.source_snippet)}`)
      .join('\n');

    const userPayload = `FACTS:\n${factPayload}\n\nCHUNK TEXT:\n${text.slice(0, 6000)}\n\nUse the submit_qa tool.`;

    try {
      const parsed = await callJsonAgent({
        agent: 'qa',
        model: QA_MODEL,
        systemPrompt: v1.QA_EXTRACTION_SYSTEM,
        userPayload,
        schema: ExtractionQASchema,
        toolName: 'submit_qa',
        toolDescription: 'Submit the per-fact QA verdicts.',
        maxTokens: 2000,
        cacheSystem: true,
      });
      totalChecked += facts.length;
      if (!parsed.passed) failedChunks++;

      for (const fr of parsed.fact_results) {
        if (!fr.ok) {
          failedFacts++;
          const f = facts[fr.fact_id_index];
          if (f) {
            await db().from('qa_flags').insert({
              target_table: 'extractions',
              target_id: f.id,
              passed: false,
              issues: [{ kind: 'extraction_qa', issue: fr.issue }],
              qa_model: QA_MODEL,
            });
          }
        }
      }
      console.log(`  chunk ${cid}: ${parsed.passed ? 'PASS' : 'FAIL'}  ${facts.length} facts  ${parsed.summary.slice(0, 80)}`);
    } catch (e) {
      console.warn(`  chunk ${cid}: QA error ${(e as Error).message}`);
    }
  }

  console.log(`Extraction QA done: ${totalChecked} facts checked  ${failedFacts} flagged  ${failedChunks}/${chunkIds.length} chunks failed`);
}

async function main() {
  console.log(`\n=== Internal QA ===`);
  console.log(`qa_model=${QA_MODEL} (NOTE: same-family proxy; spec calls for cross-family)`);

  if (QA_TARGET === 'all' || QA_TARGET === 'briefing') {
    await qaBriefing();
  }
  if (QA_TARGET === 'all' || QA_TARGET === 'extraction') {
    await qaExtractions();
  }

  console.log(`\n=== QA done ===`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
