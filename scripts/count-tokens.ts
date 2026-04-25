import { loadDotEnv, ai } from '@ppi/shared';
import { v1 } from '@ppi/prompts';

loadDotEnv();

async function count(model: string, system: string) {
  const r = await (ai() as any).messages.countTokens({
    model,
    system,
    messages: [{ role: 'user', content: 'x' }],
  });
  return r.input_tokens as number;
}

async function main() {
  const t = await count('claude-haiku-4-5', v1.TRIAGE_SYSTEM);
  console.log(`triage system tokens (claude-haiku-4-5): ${t}`);
  const e = await count('claude-sonnet-4-6', `${v1.EXTRACTOR_SYSTEM}\n\n--- WORKED EXAMPLES ---\n\n${v1.EXTRACTOR_FEW_SHOT}`);
  console.log(`extraction system tokens (claude-sonnet-4-6): ${e}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
