// Inspect recent extractions in the DB.
// Usage: pnpm tsx scripts/inspect.ts [limit]

import { loadDotEnv, db } from '@ppi/shared';

loadDotEnv();

async function main() {
  const limit = Number(process.argv[2] ?? 30);
  const { data, error } = await db()
    .from('extractions')
    .select('id, kind, value_text, value_num, value_unit, source_snippet, confidence, document_id')
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;
  for (const r of data ?? []) {
    console.log(`#${r.id} doc=${r.document_id} [${r.kind}] ${r.value_text ?? r.value_num} ${r.value_unit ?? ''}  conf=${r.confidence}`);
    console.log(`   "${(r.source_snippet ?? '').slice(0, 220)}"`);
  }

  const docs = await db()
    .from('documents')
    .select('id, doc_type, title, filed_at, full_text')
    .order('id', { ascending: false })
    .limit(10);
  console.log(`\n=== recent documents ===`);
  for (const d of docs.data ?? []) {
    console.log(`  doc#${d.id}  ${d.doc_type}  ${d.filed_at?.slice(0, 10)}  chars=${(d.full_text ?? '').length}  ${d.title?.slice(0, 60)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
