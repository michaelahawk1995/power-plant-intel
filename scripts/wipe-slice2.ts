// Wipe slice-2 derived tables so the tracking → changes → scoring → briefing chain
// can be re-run cleanly. Leaves raw_queue, documents, document_chunks, extractions
// intact (those are slice-1 ground truth).

import { loadDotEnv, db } from '@ppi/shared';

loadDotEnv();

async function main() {
  const tables = ['qa_flags', 'briefings', 'signals', 'change_events', 'project_signals', 'projects'];
  for (const t of tables) {
    const r = await db().from(t).delete().gt('id', 0);
    if (r.error) console.warn(`${t}: ${r.error.message}`);
    else console.log(`wiped ${t}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
