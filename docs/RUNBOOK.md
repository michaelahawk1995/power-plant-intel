# Runbook — Power Plant Intel (slice 1)

Operational reference for running the system day-to-day. Updated as new pieces ship.

## Daily checks (5 minutes)

1. **Open the latest signal report:** `docs/SIGNALS_LATEST.md` (regenerated every cycle).
2. **Check the cost row at the bottom.** If today's run > $1, look at the per-agent breakdown and check the `cost_ledger` table for the offender.
3. **Scout health:** open Supabase → `scout_runs` table → filter `ok = false` and `ran_at > now() - 1 day`. Any rows mean a source broke.

## Manual run commands

All run from the repo root after `pnpm install`.

| What | Command |
|---|---|
| Apply or update DB schema (idempotent) | `pnpm tsx scripts/apply-schema.ts` |
| Seed/refresh the SEC EDGAR watchlist | `pnpm tsx scripts/seed-watchlist.ts` |
| Run the EDGAR pipeline once (default 30-day lookback, all sources) | `pnpm tsx scripts/run-edgar-cycle.ts` |
| Run for a single ticker | `ONLY=apld pnpm tsx scripts/run-edgar-cycle.ts` |
| Run for a comma-separated set | `ONLY="vst,nrg,ceg,tln" pnpm tsx scripts/run-edgar-cycle.ts` |
| Cap filings per source (default 8) | `MAX_FILINGS=2 pnpm tsx scripts/run-edgar-cycle.ts` |
| Cap chunks per filing (default 25) | `MAX_CHUNKS=15 pnpm tsx scripts/run-edgar-cycle.ts` |
| Restrict forms (default `8-K,10-Q,S-1,425`) | `FORMS="8-K" pnpm tsx scripts/run-edgar-cycle.ts` |
| Print recent extractions | `pnpm tsx scripts/inspect.ts 30` |
| Print DB stats + top MW signals | `pnpm tsx scripts/db-stats.ts` |
| Generate the signals snapshot Markdown | `pnpm tsx scripts/report-top-signals.ts` |
| Wipe APLD test data | `pnpm tsx scripts/wipe-apld.ts` |
| Wipe everything except APLD | `pnpm tsx scripts/wipe-non-apld.ts` |
| **Slice 2:** resolve extractions to canonical projects | `pnpm tsx scripts/run-tracking.ts` |
| Slice 2: emit typed change events | `pnpm tsx scripts/run-changes.ts` |
| Slice 2: score change events 1–10 | `pnpm tsx scripts/run-scoring.ts` |
| Slice 2: draft Monday Briefing → `docs/BRIEFING_LATEST.md` | `pnpm tsx scripts/run-briefing.ts` |
| Slice 2: QA briefing + extraction sample (Haiku proxy) | `pnpm tsx scripts/run-qa.ts` |
| Slice 2: wipe derived tables (keeps extractions) | `pnpm tsx scripts/wipe-slice2.ts` |

## How a filing flows through the slice-1 pipeline

```
SEC EDGAR JSON (data.sec.gov)
         │  scout: poll, diff against raw_queue.external_ref
         ▼
raw_queue (one row per accession)
         │  fetch primary doc + every .htm exhibit (FilingSummary index)
         │  htmlToText → normalize → store full_text on documents
         ▼
documents
         │  chunkText(~1800 tokens, 100-token overlap)
         ▼
document_chunks
         │  Haiku triage: keep only chunks with MW/$/Texas/party signal
         ▼
document_chunks (triage_flag=true)
         │  Sonnet extract: quote-anchored facts (kind, value, source_snippet, confidence)
         ▼
extractions
```

**Slice 2 (shipped):** extractions → `projects` (Sonnet tracker decides merge/create/ambiguous) → `change_events` (typed diffs vs prior state, with `is_substantive` flag) → `signals` (1–10 score + audience + urgency + why-it-matters, calibrated against the rolling distribution) → `briefings` (Editorial Synthesis writes a quote-cited Markdown draft per week) → `qa_flags` (Haiku 4.5 cross-checks the briefing against its source signals AND samples extractions for source_snippet adherence). All structured-output agents use Anthropic tool-use forcing via `callJsonAgent` (`packages/shared/src/agent.ts`) — no more loose JSON parsing.

Slices 3–4 will add: alert/dashboard delivery (Resend + Cloudflare Pages), additional source families (ERCOT, PUCT, TCEQ, county agendas), and the cold-email outreach chain.

## Cost guardrails

- Triage is Haiku 4.5 — cheap. Even at 1000 chunks/day, this is < $1/mo.
- Extraction is Sonnet 4.6 — the hot spot. The triage pre-pass typically drops 70%+ of chunks. Cache hits on the system+schema+few-shot block bring effective per-chunk input cost down ~10×.
- If the cost ledger shows a single agent > $1/day in steady state, investigate before letting it run for a week.

Levers (in order to try):
1. Tighten the triage rubric to drop more chunks (`packages/prompts/src/v1/triage.ts`).
2. Lower `MAX_CHUNKS` for the cycle.
3. Drop `10-Q` from `FORMS` (huge, low signal density on power names).
4. Skip hyperscaler tickers (GOOG/MSFT/META/AMZN/ORCL) — empirically their 10-Qs do not name Texas sites or MW.

## Known gaps in slice 1

- Loose JSON parsing on the extractor (regex match, not `messages.parse()` with strict schema). One in ~20 chunks fails to parse and is dropped. Acceptable for now; planned upgrade is to switch to `messages.parse()` with a Zod schema in slice 1.1.
- Embeddings column on `projects` is unused — vector index deferred until first source family produces enough records to train an HNSW index.
- No watchdog cron yet — `scout_runs` rows are written, but no email alert fires on `ok = false`. Add to slice 2.

## Credentials

All keys live in `.env` (gitignored). Rotate after slice 1 verification — they were pasted in chat. The `.env.example` shows the required variables.

| Service | Used by | What it needs |
|---|---|---|
| Anthropic | extractor + triage | API key |
| Supabase Management API | schema apply, project lifecycle | Personal access token (sbp_*) |
| Supabase project | runtime DB writes | URL + service_role key |
| Cloudflare | Workers + Pages deploy (slice 2+) | Account ID + API token |
| Resend | alerts (slice 2+) | API key |
| GitHub | code hosting | PAT (currently fine-grained, lacks repo-create scope) |

## Open setup tasks for the owner

1. **Create the GitHub repo manually.** The fine-grained PAT shipped lacks `Administration: write` on user account. Two options:
   - Create `power-plant-intel` (private) at https://github.com/new, then run:
     ```
     git remote add origin https://github.com/<user>/power-plant-intel.git
     git push -u origin main
     ```
   - Or generate a classic PAT with `repo` scope, drop into `.env`, and re-run repo creation.
2. **(Optional) Gemini API key** for QA in slice 2. Without it, QA falls back to Haiku self-check (less robust per the spec's model-family-diversity rule).
3. **Pricing decision before slice 4** (outreach). Need: tier names, monthly prices, what each tier includes.
4. **Voice sample before slice 3** (Editorial Synthesis). Drop a 200-word sample of how you want the brand to sound, or point at writing you admire.
