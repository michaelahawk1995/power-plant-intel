# Vertical Slice 1 — SEC EDGAR pipeline, end to end

## Why this slice first

Picking the slice that:
- has the **highest signal density** (8-Ks routinely disclose MW, dollar, counterparty in 1–3 sentences);
- has the **cleanest fetch surface** (free JSON discovery API, free HTML body fetch, no JS, no auth, 10 req/s rate limit);
- **already produced a real signal** in scoping (APLD 8-K Apr 23 2026, $7.5B / 430 MW / 15-yr hyperscaler lease at Delta Forge 1);
- **exercises every one of the 11 agents** so we shake out the entire pipeline before adding a second source;
- **costs zero dollars** to run continuously.

Anything PUCT/TCEQ/county can wait. They expand the surface; they don't validate the spine.

## What "done" looks like for slice 1

- Scout job runs on Cloudflare Cron every 30 min.
- For 23 watchlist CIKs, polls `data.sec.gov/submissions/CIK*.json`, diffs against last seen accession.
- New filings of form ∈ {8-K, 10-Q, 10-K, S-1, 425, DEF 14A} get queued for ingestion.
- Ingestion fetches primary doc, normalizes HTML→text, splits into chunks, persists raw + chunks to Supabase + R2.
- Extraction runs Haiku per chunk to pull `(MW, $, date, counterparty, location, project_name, action_type)` tuples — every numeric value carries the verbatim source snippet.
- Project Tracking dedupes against existing project records (vector match on (counterparty, location, MW band)).
- Change Detection diffs new vs. last-known on the project record.
- Scoring rubric assigns **1–10** per the spec (9–10 stock-moving, 7–8 significant, 5–6 weekly-context, <5 db-only).
- Editorial Synthesis pulls the past 7 days of signals scored 5+ and writes the Sunday-night Monday Briefing draft.
- Internal QA runs a different model family on extractions, scoring, and the Briefing — gates publication.
- Client Delivery renders the dashboard at a public URL and queues alerts (Resend) for **score ≥ 8**.
- Lead Gen + Outreach Personalization pull the counterparty into the prospect graph (skeleton only in slice 1; real contacts in slice 4 with Apollo/Hunter).
- README documents how to run, how to read, what's broken.

## Concrete output to show at end of slice 1

Three real, dated signals from EDGAR over the last 30 days, each with:
- the source URL on sec.gov,
- the verbatim quote that justified the MW/$ extraction,
- the score and the rubric breakdown,
- the project record it was merged into.

If fewer than three real signals exist in the last 30 days at score ≥ 60, expand the lookback to 90 days rather than fabricate.

## Architecture for slice 1

```
Cloudflare Worker (cron *)
      |
      v
[1] Source Collection: poll 23 EDGAR CIK JSONs, diff accession lists
      |
      v
Supabase: filings_raw  (cik, accession, form, items, filed_at, url)
      |
      v
[2] Document Ingestion: fetch primary HTML, strip, chunk by ~2000 tokens
      |
      v
Supabase: filing_chunks (filing_id, idx, text, embedding)
R2:       raw filing HTMLs (cold storage)
      |
      v
[3] Extraction: Haiku per chunk -> JSON tuples with source_snippet
      |
      v
Supabase: extractions (chunk_id, kind, value, unit, snippet, confidence)
      |
      v
[4] Project Tracking: dedupe via pgvector + rule match into projects
      |
      v
Supabase: projects (id, name, counterparty, location, mw_low, mw_high, status, sources[])
      |
      v
[5] Change Detection: diff projects vs. snapshot, emit project_events
      |
      v
[6] Scoring: rubric -> events.score
      |
      v
[7] Editorial Synthesis: Sonnet -> events.headline + events.body (60 words)
      |
      v
[11] Internal QA: GPT-OSS or Gemini Flash -> qa_flags
      |
      v
[10] Client Delivery: dashboard (Cloudflare Pages) + alerts (Resend) + Beehiiv weekly
[8/9] Lead Gen + Outreach: skeleton only in slice 1
```

## Stack for slice 1

- **Cloudflare Workers** for cron + scrapers + API
- **Cloudflare R2** for cold-storage of raw filings
- **Cloudflare Pages** for dashboard frontend
- **Supabase** for Postgres + pgvector + auth
- **Model assignment per spec:**
  - **Sonnet 4.6** — Extraction, Project Tracking (entity reasoning), Scoring, Editorial Synthesis, Outreach Personalization
  - **Haiku 4.5** — Document Ingestion classification, Change Detection materiality, Lead Gen fit scoring, **plus a triage pre-pass before Extraction** (see cost note below)
  - **Sonnet 4.6 vision** — OCR fallback for scanned PDFs (Doc Ingestion)
  - **Different family for QA** — Gemini 2.5 Flash via free tier (1500 req/day); fall back to GPT-OSS on Groq free tier if Gemini quota exhausts
- **Prompt caching is mandatory** on every Sonnet call. The system prompt + JSON schema + few-shot examples get marked `cache_control: ephemeral` so only the chunk text counts as fresh input. Without caching, Sonnet-for-extraction breaks the $20/mo budget.
- **Resend** for transactional alerts
- **Beehiiv** for weekly briefing
- **GitHub** repo, structure: `apps/scout-edgar`, `apps/dashboard`, `packages/agents`, `packages/db`, `packages/prompts`, `docs/`
- **Stripe** + **Apollo/Hunter** + **Mailmeteor** + **Porkbun** — none needed for slice 1

## Cost ceiling for slice 1

- Cloudflare Workers free: 100k req/day → fine
- Cloudflare R2 free: 10 GB + 10M Class A reads → fine
- Cloudflare Pages free: unlimited
- Supabase free: 500 MB DB, 1 GB file, 50k MAU → fine
- Anthropic, **revised after spec lock-in to Sonnet for Extraction:**
  - Naive cost: 50 filings/day × 5 chunks × 3k input + 500 output × Sonnet rates ≈ **$120/mo** — breaks the budget.
  - With 90% prompt-cache hit rate on the system prompt + schema + few-shot block (cached input is ~10% the price), and a **Haiku triage pre-pass** that drops chunks with no MW/$/Texas/ERCOT/party signal before they hit Sonnet (typically 70%+ of 10-Q chunks are MD&A boilerplate): expected ~**$8–12/mo** for slice 1.
  - QA on Gemini Flash is free under quota.
  - **If costs trend over budget after one week of real running, the next lever is reducing Sonnet's output cap and tightening the triage rubric — not switching Extraction to Haiku.** Spec is non-negotiable on Extraction model family.
- Gemini Flash QA: free tier 1500 req/day → fine
- Resend free: 100 emails/day, 3000/mo → fine
- Beehiiv free: up to 2,500 subscribers
- **Estimated total: under $10/mo for slice 1.** Headroom for slices 2–4.

## What I need from you before I start writing code

These are the only things that need your hand or your wallet. I'll batch them so you click once, not five times.

1. **Anthropic API key** — paste into a `.env` I'll create.
2. **Supabase project URL + service role key** — create a free project at supabase.com (I'll give you the exact "New project" form values to use), paste back URL + service-role key.
3. **Cloudflare account email + API token** — `Edit Cloudflare Workers` permission token, plus the account ID. Workers and Pages will both deploy with this.
4. **Resend API key** — free signup at resend.com.
5. **GitHub repo decision** — should I init a new `power-plant-intel` repo under your account, or stay local-only until later? If new repo, paste a GitHub PAT with `repo` scope OR I'll give you the exact `gh repo create` command.
6. **Optional: Gemini API key** — for QA. If skipped I'll use Haiku self-QA with a different system prompt and rubric (worse but workable).
7. **The eleven-role definitions you said you'd paste next** — without those I'll write them based on the names alone and you can correct me, but having your version is cheaper.

Two real-world business decisions I need from you before slice 4 (outreach), not before slice 1:
- **Pricing**: e.g. $499/mo individual, $1,999/mo team, custom enterprise — or your numbers.
- **Voice/positioning** for the cold email + the Monday Briefing tone — drop a 200-word sample of how you want the brand to sound, or point me at writing you admire.

I will not stop and ask about anything else. If I need a library, a schema decision, a cron interval, a scoring weight, a prompt phrasing, a UI choice — I'll pick, document the choice, and move on.

## What happens if you say "go"

In order:
1. Init git repo, README, monorepo skeleton (pnpm workspaces).
2. Wire Supabase schema for slice 1 tables.
3. Write the 11 agent prompts in `packages/prompts/v1/` with input/output schemas + 3 good/bad examples each.
4. Write the EDGAR Scout worker, deploy to Cloudflare with cron.
5. Run one full cycle on the 23-CIK watchlist over a 30-day lookback. Fix what breaks.
6. Stand up the dashboard at a `*.pages.dev` URL.
7. Generate the first Monday Briefing draft from real signals.
8. Report back with the three real signals, the dashboard URL, the brief draft, and a punch list of what's weak before slice 2.
