# Power Plant Intel — Signals snapshot

Generated 2026-04-25 04:38:49 UTC from live SEC EDGAR ingestion. This is the slice-1 raw-signals view, before the full Editorial Synthesis agent ships.

**Pipeline run summary:** 7 documents ingested, 124 high-confidence facts extracted, **$2.2244** total Anthropic spend so far.

## Top signals (ranked by raw MW + $M)

### 1. NRG Energy (NRG) — 2026-04-14
- **Capacity:** 25,000 MW (peak)
- **Dollar amount:** $1.05B (peak)
- **Parties:** NRG Energy, Inc., Lightning Power, LLC, NRG
- **Source:** [0001104659-26-043327](https://www.sec.gov/Archives/edgar/data/1013871/000110465926043327/tm2611676d1_8k.htm)
- **Quotes:**
  > MW: safe, reliable operation of approximately 25 GW of power generation
  > MW: safe, reliable operation of approximately 25 GW of power generation
  > USD: $1,050 million aggregate principal amount of 6.125% senior unsecured notes due 2036

### 2. Applied Digital (APLD) — 2026-04-23
- **Capacity:** 2,000 MW (peak)
- **Dollar amount:** $23.00B (peak)
- **Parties:** Applied Digital Corporation, Wes Cummins, Saidal L. Mohmand, Applied Digital, JSA (Jaymie Scotto & Associates), Gateway Group, Inc.
- **Projects:** Delta Forge 1, Polaris Forge 1, Polaris Forge AI Factory, Polaris Forge 2
- **Source:** [0001144879-26-000036](https://www.sec.gov/Archives/edgar/data/1144879/000114487926000036/apld-20260423.htm)
- **Quotes:**
  > MW: funding of up to $5.0 billion that can support over 2 GW of AI Data Center development
  > MW: 1 GW of Critical IT load under construction, out of which 900 MW is fully contracted on long term leases
  > MW: 1 GW of Critical IT load under construction, out of which 900 MW is fully contracted on long term leases

### 3. Talen Energy (TLN) — 2026-04-17
- **Capacity:** 13,100 MW (peak)
- **Dollar amount:** $2.50B (peak)
- **Parties:** Talen Energy Corporation, Talen Energy Supply, LLC, Cornerstone Generation Holdings, LP, ECP Generation Holdings GP, Buckeye CG Holdings, LLC, Talen Energy
- **Projects:** Lawrenceburg Power Plant, Waterford Energy Center, Darby Generation Station
- **Source:** [0001622536-26-000030](https://www.sec.gov/Archives/edgar/data/1622536/000162253626000030/tln-20260417.htm)
- **Quotes:**
  > MW: We own and operate approximately 13.1 gigawatts of power infrastructure in the United States
  > MW: indirectly acquire 2,451 megawatts of capacity consisting of the Lawrenceburg Power Plant (1,120 megawatts), the Waterford Energy Center (875 megawatts) and the Darby Generation Station (456 megawatts)
  > MW: including 2.2 gigawatts of nuclear power and a significant dispatchable fossil fleet

### 4. Digital Realty (DLR) — 2026-04-23
- **Capacity:** 9,000 MW (peak)
- **Dollar amount:** $3.50B (peak)
- **Parties:** Digital Realty Trust, Inc., Digital Realty Trust, L.P., Digital Realty
- **Source:** [0001104659-26-047702](https://www.sec.gov/Archives/edgar/data/1297996/000110465926047702/dlr-20260423x8k.htm)
- **Quotes:**
  > MW: ~9 GW
Total Data Center IT Capacity
Note: As of March 31, 2026.
  > MW: approximately 6.3 gigawatts of buildable IT capacity under active development and held for future development
  > MW: ~6 GW
Future Development IT Capacity

### 5. Core Scientific (CORZ) — 2026-04-21
- **Dollar amount:** $7.79B (peak)
- **Parties:** Core Scientific, Inc., Core Scientific Finance I LLC, Core Scientific Austin LLC, Core Scientific Denton LLC, Morgan Stanley Senior Funding, Inc., Core Scientific
- **Source:** [0001193125-26-165121](https://www.sec.gov/Archives/edgar/data/1839341/000119312526165121/d149019d8k.htm)
- **Quotes:**
  > USD: Total Revenue (2)
$
7,793
737
1,346
1,396
1,420
1,447
1,448
  > USD: proposed offering of $3.3 billion aggregate principal amount of senior secured notes due 2031
  > USD: Funding
3,300
3,300
—
—
—
—
—

### 6. Core Scientific (CORZ) — 2026-04-21
- **Dollar amount:** $3.30B (peak)
- **Parties:** Core Scientific, Inc., Core Scientific Finance I LLC, Core Scientific Austin LLC, Core Scientific Denton LLC, Morgan Stanley Senior Funding, Inc., CoreWeave
- **Projects:** Marble Campus, Muskogee Campus
- **Source:** [0001193125-26-165121](https://www.sec.gov/Archives/edgar/data/1839341/000119312526165121/d149019d8k.htm)
- **Quotes:**
  > USD: announced a proposed offering of $3.3 billion aggregate principal amount of senior secured notes due 2031

### 7. TeraWulf (WULF) — 2026-04-15
- **Dollar amount:** $0.90B (peak)
- **Parties:** TeraWulf Inc., Morgan Stanley, Cantor Fitzgerald
- **Source:** [0001104659-26-043402](https://www.sec.gov/Archives/edgar/data/1083301/000110465926043402/tm2611661d5_8k.htm)
- **Quotes:**
  > USD: priced 47,400,000 shares at $19.00 per share, for gross proceeds of approximately $900 million, upsized from $800 million

## Per-agent cost

| Agent | Calls | Input toks | Cache reads | Output toks | USD |
|---|---:|---:|---:|---:|---:|
| triage | 107 | 233,821 | 0 | 7,277 | $0.2702 |
| extraction | 36 | 84,009 | 0 | 104,277 | $1.9542 |
| **TOTAL** | | | | | **$2.2244** |

## What's not here yet (slice 2+)

- Project Tracking (dedup across documents into one canonical project per real-world site)
- Change Detection (procedural vs substantive flag)
- Real Scoring agent (1-10 + audience tag + why-it-matters)
- Editorial Synthesis (Monday Briefing prose)
- QA cross-check (different model family verifying source_snippet adherence)
- Live Dashboard URL
- Other source families: ERCOT, PUCT, TCEQ, county agendas