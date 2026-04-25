// Apply packages/db/schema.sql to Supabase via the Management API.
// Idempotent: schema uses `create ... if not exists`.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function loadEnv() {
  const t = readFileSync(resolve(root, '.env'), 'utf8');
  for (const rawLine of t.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq);
    let v = line.slice(eq + 1);
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}

async function main() {
  loadEnv();
  const PAT = process.env.SUPABASE_PAT;
  const REF = process.env.SUPABASE_PROJECT_REF;
  if (!PAT || !REF) throw new Error('missing SUPABASE_PAT or SUPABASE_PROJECT_REF');

  // Wait for project ACTIVE_HEALTHY
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`https://api.supabase.com/v1/projects/${REF}`, {
      headers: { Authorization: `Bearer ${PAT}` },
    });
    const j: any = await r.json();
    console.log(`  status=${j.status}`);
    if (j.status === 'ACTIVE_HEALTHY') break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  const sql = readFileSync(resolve(root, 'packages/db/schema.sql'), 'utf8');
  const r = await fetch(
    `https://api.supabase.com/v1/projects/${REF}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    }
  );
  const text = await r.text();
  console.log(`apply: HTTP ${r.status}`);
  console.log(text.slice(0, 1500));
  if (!r.ok) process.exit(1);

  // List tables to verify
  const list = await fetch(
    `https://api.supabase.com/v1/projects/${REF}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query:
          "select table_name from information_schema.tables where table_schema='public' order by table_name;",
      }),
    }
  );
  const tables = (await list.json()) as Array<{ table_name: string }>;
  console.log('\nTables in public schema:');
  for (const t of tables) console.log('  ', t.table_name);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
