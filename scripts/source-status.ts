// Quick: which sources have been processed vs untouched
import { loadDotEnv, db } from '@ppi/shared';
loadDotEnv();

async function main() {
  const all = await db().from('source_registry').select('id, source_key, display_name').eq('family', 'sec_edgar').order('source_key');
  const raws = await db().from('raw_queue').select('id, source_id');
  const docs = await db().from('documents').select('id, raw_id');
  const rawSrc = new Map<number, number>((raws.data ?? []).map((r: any) => [r.id, r.source_id]));
  const docCount = new Map<number, number>();
  for (const d of docs.data ?? []) {
    const src = rawSrc.get((d as any).raw_id);
    if (src) docCount.set(src, (docCount.get(src) ?? 0) + 1);
  }
  const rawCount = new Map<number, number>();
  for (const r of raws.data ?? []) {
    const src = (r as any).source_id;
    rawCount.set(src, (rawCount.get(src) ?? 0) + 1);
  }

  console.log(`source_key                      raw  docs`);
  for (const s of all.data ?? []) {
    const sid = (s as any).id;
    const rk = rawCount.get(sid) ?? 0;
    const dk = docCount.get(sid) ?? 0;
    console.log(`  ${(s as any).source_key.padEnd(30)} ${String(rk).padStart(3)}  ${String(dk).padStart(3)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
