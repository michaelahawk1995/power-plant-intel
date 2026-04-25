// Shared helper: call Claude with a Zod schema, get back a parsed object.
// Uses tool_choice forcing so the model emits a structured tool_use block instead of
// free-form JSON-in-text. This is dramatically more reliable than "return only JSON"
// in the prompt — adaptive thinking truncation, code-fence wrapping, and trailing
// prose all disappear.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ai, recordCost } from './anthropic.js';

export interface CallJsonAgentOptions<T> {
  agent: string; // for cost ledger ('tracking', 'change', etc.)
  model: string;
  systemPrompt: string;
  userPayload: string;
  schema: z.ZodType<T>;
  toolName: string;
  toolDescription: string;
  maxTokens?: number;
  thinking?: 'adaptive' | 'disabled';
  cacheSystem?: boolean;
}

/**
 * Call a Claude model and force it to emit a tool_use call matching the supplied Zod schema.
 *
 * Returns the parsed result. Throws on tool failure or schema mismatch (caller should
 * wrap in try/catch and continue the loop).
 */
export async function callJsonAgent<T>(opts: CallJsonAgentOptions<T>): Promise<T> {
  const client = ai();
  const jsonSchema = zodToJsonSchema(opts.schema, { name: opts.toolName, target: 'jsonSchema7' }) as any;
  // zod-to-json-schema wraps in $ref + definitions when given a name; unwrap to a plain object schema
  const inputSchema = jsonSchema?.definitions?.[opts.toolName] ?? jsonSchema;

  const useThinking = opts.thinking ?? 'adaptive';
  const reqBody: Anthropic.MessageCreateParamsNonStreaming = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4000,
    system: opts.cacheSystem
      ? [{ type: 'text', text: opts.systemPrompt, cache_control: { type: 'ephemeral' } }]
      : opts.systemPrompt,
    tools: [
      {
        name: opts.toolName,
        description: opts.toolDescription,
        input_schema: inputSchema as any,
      },
    ],
    tool_choice: { type: 'tool', name: opts.toolName } as any,
    messages: [{ role: 'user', content: opts.userPayload }],
  };

  // Adaptive thinking is unsupported in conjunction with forced tool_choice on some models;
  // omit thinking when forcing a tool. Sonnet 4.6 still produces good output without it
  // because the schema constrains structure.
  if (useThinking === 'adaptive') {
    // intentionally omit `thinking` — forced tool_choice + adaptive thinking can conflict
  }

  const resp = await client.messages.create(reqBody);
  await recordCost({ agent: opts.agent, model: opts.model, usage: resp.usage, request_id: resp.id });

  const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === opts.toolName);
  if (!toolUse) {
    const txt = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    throw new Error(`agent ${opts.agent}: no tool_use returned. text=${txt.slice(0, 200)}`);
  }
  return opts.schema.parse(toolUse.input);
}
