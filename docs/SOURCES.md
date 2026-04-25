# Texas Power-Intel Source Inventory — verified Apr 24, 2026

Each source below was probed live in this session. URLs, response codes, and signal samples are real, not assumed.

| Source | Access pattern | Format | Cadence | Cost to poll | Difficulty | Live signal example |
|---|---|---|---|---|---|---|
| **SEC EDGAR** | `data.sec.gov/submissions/CIK*.json` (discovery) + `Archives/edgar/data/*/...htm` (body). Free, 10 req/s, requires UA header. | JSON + HTML | Real-time per filing | Free | **EASY** | APLD 8-K Apr 23 2026: "430 MW AI Factory Campus, Delta Forge 1 ... $7.5 billion in total contracted value over an estimated 15-year lease term" |
| **ERCOT** | Static file URLs on ercot.com/files/docs/YYYY/MM/DD/. Discoverable from `/gridinfo/resource`. No JS. | XLSX + PDF | Monthly (5th–9th) | Free | **EASY** | `Capacity-Changes-by-Fuel-Type-Charts_March_2026.xlsx` (Apr 7 2026), `MORA_June2026.xlsx` (Apr 2 2026) |
| **TCEQ NSR** | `/permitting/air/announcements/nsr-news` page. No RSS. Email-list signup is the only push channel. Central Registry search at `www15.tceq.texas.gov/crpub/` (form-based, no API). | HTML | Irregular (weekly-ish) | Free | **MEDIUM** (must poll-and-diff) | NSR news page returns clean HTML with dated headlines |
| **PUCT Interchange** | `interchange.puc.texas.gov/search/filings/` — form is GET but **results require JavaScript**. RSS exists for calendar only. Daily Filings page is a separate URL. | HTML (JS-rendered) | Daily | Free + Cloudflare Worker w/ headless browser ($0 if under quota, else ~$5/mo Browserless) | **HARD** | Form fields confirmed: `ControlNumber`, `UtilityType`, `DateFiledFrom`, `DateFiledTo`, `DocumentType`, `FilingParty`, etc. Item types include PROJECT, REGISTRATIONS, TARIFF, TESTIMONY |
| **TX Railroad Commission** | `rrc.texas.gov/resource-center/research/gis-viewer/` for pipelines (interactive map; no bulk download surfaced from homepage). | HTML/GIS | Slow | Free | **MEDIUM** | Confirmed GIS viewer exists; deeper probe needed for permit-application feed |
| **County agendas — CivicPlus** | `/AgendaCenter` with category subpaths e.g. `/AgendaCenter/Commissioners-Court-1`. RSS at `/rss.aspx#agendaCenter`. | HTML index + PDF agenda packets | Weekly | Free | **EASY** | Comal County confirmed CivicPlus + RSS; meets Thursdays 8:30 am |
| **County agendas — Granicus** | `*.granicus.com/ViewPublisher.php?view_id=N` exposes per-meeting RSS. PDF packets at stable `clip_id` URLs. | HTML + PDF | Weekly | Free | **EASY** | Common platform; pilot county TBD after a wider sweep |
| **County agendas — Destiny (CivicClerk)** | `public.destinyhosted.com/agenda_publish.cfm?id=N` — Hays County uses this. | HTML + PDF | Weekly | Free | **MEDIUM** (no native RSS, must poll-and-diff) | Hays County confirmed |
| **County agendas — custom** | Ector, Reeves and other West-TX counties tend to hand-post PDFs. | PDF only | Irregular | Free | **HARD** | Skip for v1; revisit after named-account watchlist forces it |

## Headline finding

The **highest-value, lowest-friction source is SEC EDGAR**. It is:
- Already JSON, no scraping;
- Already the place where multi-hundred-MW commitments get disclosed first when the counterparty is public;
- Already chunked by accession + item code, which maps cleanly onto the agent pipeline (8-K Item 1.01 = material agreement = candidate signal; 8.01 = Reg-FD = often a press release; 7.01 = Reg-FD; 9.01 = exhibits);
- Already produced a real Apr 23 2026 high-score signal in this scoping pass.

The **second-best source is ERCOT's `/files/docs/` static tree** — predictable URL pattern, monthly XLSX, no auth. Watchdog on the day-of-month publication is trivial.

The **hardest source is PUCT**. Its Interchange backend requires JS to render search results. It is also the most legally-loaded source (formal docket filings, often the EARLIEST regulatory disclosure of a large-load deal under SB 6). It deserves a real headless-browser scraper, but it is not the right place to start — it is the right place to add second.

## Recommended pilot order

1. **SEC EDGAR** (this session) — full Scout→Ingestion→Extraction→Score→Display→Brief slice on 23 ticker watchlist. Proves the eleven-agent pipeline end to end.
2. **ERCOT static files** — adds a non-EDGAR source family, exercises the XLSX parser, validates that two source families merge into one project record cleanly.
3. **CivicPlus county RSS** (Comal first) — adds a third source family with PDF packet ingestion, exercises OCR fallback if needed.
4. **PUCT** — last, with Playwright/Browserless or Cloudflare Browser Rendering. Highest engineering cost, save for after the rest is proven.
5. **TCEQ + RRC + Granicus counties + custom counties + news/RSS/X** — fan-out once the spine is solid.

## Things I am explicitly NOT doing in v1

- Hyperscaler 10-Q parsing — empirically those filings do not name Texas sites or MW. Confirmed on prior reads; deprioritized.
- Full-text search of all PUCT filings — too noisy without the docket-level filter; revisit after PUCT scraper exists.
- News/RSS/X ingestion — high-noise, save for after the regulatory spine produces clean signals to triangulate against.
