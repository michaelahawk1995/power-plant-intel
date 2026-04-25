import { loadDotEnv, db } from '@ppi/shared';
loadDotEnv();
async function main() {
  const r = await db().from('cost_ledger').select('agent, usd_cost, ts').order('ts', { ascending: true });
  let total = 0;
  const byAgent: Record<string, number> = {};
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  for (const row of r.data ?? []) {
    const x = row as any;
    total += Number(x.usd_cost);
    byAgent[x.agent] = (byAgent[x.agent] ?? 0) + Number(x.usd_cost);
    if (!firstTs) firstTs = x.ts;
    lastTs = x.ts;
  }
  console.log(`total cumulative spend: $${total.toFixed(4)} across ${(r.data ?? []).length} API calls`);
  console.log(`window: ${firstTs} → ${lastTs}`);
  console.log(`by agent:`);
  for (const [a, v] of Object.entries(byAgent).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${a.padEnd(12)} $${v.toFixed(4)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
