import { loadDotEnv, db } from '@ppi/shared';
loadDotEnv();

async function main() {
  const refs = ['0001144879-26-000036', '0001493152-26-017092'];
  const { data: raws } = await db().from('raw_queue').select('id').in('external_ref', refs);
  console.log(`wiping ${raws?.length ?? 0} raw_queue rows (cascades to documents/chunks/extractions)`);
  for (const r of raws ?? []) {
    await db().from('raw_queue').delete().eq('id', r.id);
  }
  await db().from('cost_ledger').delete().gte('id', 0);
  console.log('done');
}
main().catch((e) => { console.error(e); process.exit(1); });
