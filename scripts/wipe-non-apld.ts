import { loadDotEnv, db } from '@ppi/shared';
loadDotEnv();
async function main() {
  const { data: srcs } = await db().from('source_registry').select('id, source_key').neq('source_key', 'sec_edgar:apld').eq('family', 'sec_edgar');
  const ids = (srcs ?? []).map(s => s.id);
  console.log(`wiping raw_queue for ${ids.length} non-APLD sources`);
  const { count } = await db().from('raw_queue').delete({ count: 'exact' }).in('source_id', ids);
  console.log(`deleted ${count} raw rows`);
  await db().from('cost_ledger').delete().gte('id', 0);
}
main().catch(e => { console.error(e); process.exit(1); });
