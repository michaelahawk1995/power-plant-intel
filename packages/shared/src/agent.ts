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

  // Cache breakpoint placement:
  //   - Render order is `tools` -> `system` -> `messages`.
  //   - `cache_control` on a content block marks the END of a prefix to cache. Everything
  //      before it (in render order) is part of the cached prefix.
  //   - We place cache_control on the LAST tool definition. This caches `tools` plus any
  //     system prompt that comes after gets re-cached on the next breakpoint, giving us
  //     two cached layers.
  //   - We also place cache_control on the system block so the prefix `tools + system` is
  //     cached as a single layer that subsequent calls can read fully.
  const tool: any = {
    name: opts.toolName,
    description: opts.toolDescription,
    input_schema: inputSchema,
  };
  if (opts.cacheSystem) tool.cache_control = { type: 'ephemeral' };

  const reqBody: Anthropic.MessageCreateParamsNonStreaming = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4000,
    system: opts.cacheSystem
      ? [{ type: 'text', text: opts.systemPrompt, cache_control: { type: 'ephemeral' } }]
      : opts.systemPrompt,
    tools: [tool],
    tool_choice: { type: 'tool', name: opts.toolName, disable_parallel_tool_use: true } as any,
    messages: [{ role: 'user', content: opts.userPayload }],
  };

  const resp = await client.messages.create(reqBody);
  if (process.env.PPI_DEBUG_CACHE === '1') {
    const u = resp.usage as any;
    console.log(`  [DEBUG ${opts.agent}/${opts.model}] in=${u.input_tokens} cR=${u.cache_read_input_tokens ?? 0} cW=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens}`);
  }
  await recordCost({ agent: opts.agent, model: opts.model, usage: resp.usage, request_id: resp.id });

  const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === opts.toolName);
  if (!toolUse) {
    const txt = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
    throw new Error(`agent ${opts.agent}: no tool_use returned. text=${txt.slice(0, 200)}`);
  }
  return opts.schema.parse(toolUse.input);
}
