# Power Plant Intel

AI-native intelligence on Texas data centers and behind-the-meter power.

Eleven-agent pipeline that watches public Texas regulators (ERCOT, PUCT, TCEQ, RRC, county commissioners) plus SEC EDGAR, turns filings into scored signals, and ships a Monday Briefing, same-day Alerts, and a searchable Dashboard.

## Where things are

| Path | What |
|---|---|
| [docs/AGENT_SPEC.md](docs/AGENT_SPEC.md) | Owner-authored spec for the 11 agents — source of truth |
| [docs/SOURCES.md](docs/SOURCES.md) | Live-probed Texas data sources, with format/cadence/difficulty |
| [docs/VERTICAL_SLICE_1.md](docs/VERTICAL_SLICE_1.md) | Slice 1 plan: SEC EDGAR end-to-end through all 11 agents |
| `packages/db/` | Supabase schema, migrations, typed client |
| `packages/shared/` | Env, Anthropic + Supabase clients, shared types |
| `packages/prompts/` | Versioned agent prompts (one folder per major version) |
| `apps/worker/` | Cloudflare Worker hosting the backend agents on cron triggers |
| `apps/dashboard/` | Cloudflare Pages frontend |
| `scripts/` | One-shot runners (apply schema, seed watchlist, run a manual EDGAR cycle) |

## Daily operation (you, the owner)

Once slice 1 is deployed:

1. **Monday 7am Central** — the Briefing lands in your Beehiiv subscriber list automatically. Skim the dashboard at the URL printed in `docs/RUNBOOK.md`. If a story looks wrong, click through to the source quote — every fact links back.
2. **During the day** — alerts fire to your inbox via Resend whenever a score-8+ signal hits. Each alert links to the dashboard page for the project.
3. **Cold outbound** — open Gmail Drafts, review the 30–50 personalized drafts the Outreach agent has staged, hit send on the ones that look right, edit or trash the rest.
4. **Watchdog** — if any source goes 24h without a capture, you get an email. Open the dashboard `/health` page to see which scraper failed and why.

## What you have to do manually (for now)

- Review and send cold-email drafts (the Outreach agent stages them; you ship them).
- Rotate API keys quarterly.
- Top up Anthropic credit when the dashboard shows < $5 balance remaining.

Everything else runs on its own.

## Cost ceiling

Under $20/mo in steady state. See [docs/VERTICAL_SLICE_1.md](docs/VERTICAL_SLICE_1.md) for the model. If costs trend over, the dashboard's `/cost` page shows where the burn is.

## Security

- `.env` is gitignored. Never commit credentials.
- All Supabase access goes through Row Level Security; the anon key is read-only against public tables.
- Cloudflare Worker secrets are bound at deploy time, not in code.
