import Anthropic from '@anthropic-ai/sdk';
import { requireEnv } from './env.js';
import { db } from './supabase.js';

let _client: Anthropic | null = null;

export function ai(): Anthropic {
  if (_client) return _client;
  _client = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });
  return _client;
}

// Model rates per spec, USD per 1M tokens.
// Cache reads ~0.1x base, cache writes ~1.25x base (5-min TTL).
const RATES: Record<string, { in: number; out: number }> = {
  'claude-opus-4-7': { in: 5.0, out: 25.0 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
};

function costOf(
  model: string,
  u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
): number {
  const r = RATES[model];
  if (!r) return 0;
  const fresh = u.input_tokens / 1_000_000;
  const cacheRead = (u.cache_read_input_tokens ?? 0) / 1_000_000;
  const cacheWrite = (u.cache_creation_input_tokens ?? 0) / 1_000_000;
  const out = u.output_tokens / 1_000_000;
  return fresh * r.in + cacheRead * r.in * 0.1 + cacheWrite * r.in * 1.25 + out * r.out;
}

export interface LedgerEntry {
  agent: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  request_id?: string | null;
}

export async function recordCost(entry: LedgerEntry): Promise<void> {
  const usd = costOf(entry.model, entry.usage);
  await db().from('cost_ledger').insert({
    agent: entry.agent,
    model: entry.model,
    input_tokens: entry.usage.input_tokens,
    output_tokens: entry.usage.output_tokens,
    cache_read_tokens: entry.usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: entry.usage.cache_creation_input_tokens ?? 0,
    usd_cost: usd,
    request_id: entry.request_id ?? null,
  });
}
