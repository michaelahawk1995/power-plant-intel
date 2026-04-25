import { loadDotEnv, db } from '@ppi/shared';
loadDotEnv();
async function main() {
  const docs = await db().from('documents').select('id', { count: 'exact', head: true });
  const facts = await db().from('extractions').select('id', { count: 'exact', head: true });
  const chunks = await db().from('document_chunks').select('id', { count: 'exact', head: true });
  const kept = await db().from('document_chunks').select('id', { count: 'exact', head: true }).eq('triage_flag', true);
  const cost = await db().from('cost_ledger').select('usd_cost');
  const totalUsd = (cost.data ?? []).reduce((a, r: any) => a + Number(r.usd_cost ?? 0), 0);
  console.log(`docs=${docs.count}  chunks=${chunks.count}  kept=${kept.count}  facts=${facts.count}  cost=$${totalUsd.toFixed(4)}`);
  // top facts by MW
  const top = await db().from('extractions').select('value_num, value_text, source_snippet, document_id, kind').eq('kind','mw').not('value_num','is',null).order('value_num',{ascending:false}).limit(8);
  console.log(`\ntop MW facts:`);
  for (const r of top.data ?? []) console.log(`  ${r.value_num} MW  doc#${r.document_id}  "${r.source_snippet?.slice(0,140)}"`);
}
main().catch(e => { console.error(e); process.exit(1); });
