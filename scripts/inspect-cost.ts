import { loadDotEnv, db } from '@ppi/shared';
loadDotEnv();

async function main() {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const r = await db()
    .from('cost_ledger')
    .select('agent, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, usd_cost, ts')
    .gte('ts', since)
    .order('ts', { ascending: true });
  console.log(`agent       model               input  cR   cW    out  $`);
  for (const row of r.data ?? []) {
    const x = row as any;
    console.log(`${x.agent.padEnd(11)} ${x.model.padEnd(20)} ${String(x.input_tokens).padStart(5)} ${String(x.cache_read_tokens).padStart(5)} ${String(x.cache_write_tokens).padStart(5)} ${String(x.output_tokens).padStart(5)} $${Number(x.usd_cost).toFixed(4)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
