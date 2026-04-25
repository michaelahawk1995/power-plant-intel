// Diagnose Haiku 4.5 caching: try several combinations.
import { loadDotEnv, ai } from '@ppi/shared';
import { v1 } from '@ppi/prompts';

loadDotEnv();

async function callOnce(label: string, model: string, useTools: boolean, useCache: boolean) {
  const client = ai();
  const sysParam: any = useCache
    ? [{ type: 'text', text: v1.TRIAGE_SYSTEM, cache_control: { type: 'ephemeral' } }]
    : v1.TRIAGE_SYSTEM;
  const params: any = {
    model,
    max_tokens: 200,
    system: sysParam,
    messages: [{ role: 'user', content: 'CHUNK: Vistra Corp announced a 200 MW Texas data center deal. Decide.' }],
  };
  if (useTools) {
    const tool: any = {
      name: 'submit',
      description: 'submit',
      input_schema: { type: 'object', properties: { keep: { type: 'boolean' }, reason: { type: 'string' } }, required: ['keep', 'reason'] },
    };
    if (useCache) tool.cache_control = { type: 'ephemeral' };
    params.tools = [tool];
    params.tool_choice = { type: 'tool', name: 'submit' };
  }
  const r = await client.messages.create(params);
  const u = r.usage as any;
  console.log(`${label.padEnd(40)} in=${u.input_tokens} cR=${u.cache_read_input_tokens ?? 0} cW=${u.cache_creation_input_tokens ?? 0}`);
}

async function main() {
  // Two-call sequences. Second call should show cR > 0 if cache works.
  console.log(`\n--- A: Haiku 4.5, no tools, system cache ---`);
  await callOnce('A1 (warm)', 'claude-haiku-4-5', false, true);
  await callOnce('A2 (read)', 'claude-haiku-4-5', false, true);

  console.log(`\n--- B: Haiku 4.5, with tools, system+tool cache ---`);
  await callOnce('B1 (warm)', 'claude-haiku-4-5', true, true);
  await callOnce('B2 (read)', 'claude-haiku-4-5', true, true);

  console.log(`\n--- C: Sonnet 4.6, no tools, system cache (control) ---`);
  await callOnce('C1 (warm)', 'claude-sonnet-4-6', false, true);
  await callOnce('C2 (read)', 'claude-sonnet-4-6', false, true);
}

main().catch((e) => { console.error(e); process.exit(1); });
