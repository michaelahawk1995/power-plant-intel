# Eleven-Agent Workforce — canonical spec

Owner-authored. Do not edit without the owner's sign-off. Implementation prompts in `packages/prompts/` must trace back to a clause here.

---

## 1. Source Collection (the scout)
**Why it exists:** Every signal in this business starts as a public document on a Texas government or news website. None of those sites offer a clean API. The whole pipeline depends on reliably pulling fresh content from a moving target — sites change layout, add rate limits, drop offline. This agent is the foundation; if it fails silently, the rest of the system produces nothing and we don't know it's broken.

**Role:** Visit a registry of source endpoints on a schedule and capture anything new since last run.

**Inputs:** A versioned source registry (URL, fetch method, parse hint, polling cadence) stored in the database. Last-seen timestamps and content hashes per source.

**Outputs:** Raw artifacts (HTML, PDFs, JSON, RSS items) written to object storage with metadata: source ID, fetched-at timestamp, content hash, original URL, HTTP status. A row in the `raw_queue` table per artifact.

**Tools:** Cloudflare Workers cron triggers, plain fetch for static pages, a headless rendering fallback (Browserless free tier or Cloudflare Browser Rendering) for JavaScript-heavy sites. **No LLM calls in the hot path** — keep this dumb and cheap.

**Handoff:** Drops items into `raw_queue` for Document Ingestion to pick up.

**What good looks like:** Every two hours, every source logs either "N new items captured" or "0 new (verified)." Sources never go silently empty.

**Failure risks:** Silent breakage when a county website redesigns and the scraper returns empty pages with HTTP 200. PDFs that 404 intermittently. Rate limits that look like success. **Mitigation:** per-source watchdog that alerts if any source goes 24 hours with zero captures, and a content-hash check that distinguishes "no new content" from "site returned a generic landing page."

---

## 2. Document Ingestion (the cleaner)
**Why it exists:** Raw artifacts are unusable. A county agenda PDF might be a scan with no embedded text. An ERCOT filing might be HTML wrapped in 4,000 lines of navigation chrome. Before any AI can reason about content, the content has to be readable text. This is the boring but critical pre-processing layer that makes everything downstream possible.

**Role:** Convert raw artifacts into clean, structured Markdown plus document-type metadata.

**Inputs:** Items from `raw_queue` plus the original artifact in storage.

**Outputs:** Clean Markdown text, a document type classification (filing, permit, agenda, news, release, SEC filing, other), and provenance metadata (source URL, page count, extraction method used). Written to a `documents` table with full-text search enabled.

**Tools:** `pdf-parse` or `pdfjs` for native PDFs, Mozilla Readability for HTML article extraction, Claude Haiku for document-type classification (cheap, high-volume), Claude vision (Sonnet) as the OCR fallback for scanned PDFs.

**Handoff:** Inserts into `documents` table; queues a job for Extraction.

**What good looks like:** Any document a human can read, the system can read. Scanned county agendas come through with text just like native filings.

**Failure risks:** Scanned PDFs without an OCR layer come through empty and look like successful captures. **Mitigation:** any document under 200 extracted characters auto-routes to Claude vision before being marked processed. HTML extraction can also strip too aggressively — if Readability returns nothing, fall back to raw text with chrome stripped via heuristics.

---

## 3. Extraction (the reader)
**Why it exists:** Clean text is still not a database. The whole product depends on querying by megawatts, county, parties, dollar amounts, and dates — none of which exist as fields until something extracts them. This is also the layer where hallucination is most expensive: a wrong MW figure published in a Briefing destroys trust permanently. Quote-anchoring (every number ships with the source snippet that justifies it) is what makes that risk manageable.

**Role:** Read each document and pull out structured fields with verifiable provenance.

**Inputs:** Clean Markdown plus document type from the `documents` table.

**Outputs:** A structured JSON record per document: parties (LLCs, parent companies, individuals), county, address or coordinates if present, megawatts, dollar amounts, key dates (filed, hearing, decision, energization target), action type (new filing, amendment, denial, approval, sale, MOU, withdrawal), and — for every numeric or named-entity field — the exact source text snippet that supports it. Written to an `extractions` table.

**Tools:** Claude Sonnet (Haiku is too prone to hallucinated entities on dense regulatory text). A strict JSON schema enforced via tool use or response format.

**Handoff:** Sends extraction records to Project Tracking.

**What good looks like:** Spot-check any field in the database, click through to the source quote, and the quote actually says what was extracted. Always.

**Failure risks:** Unit confusion ("$50,000 per MW" read as "$50,000 total," "75 MW or more" read as "750 MW"). Hallucinated parties when document text is ambiguous. Stale values reused from earlier filings. **Mitigation:** hard requirement that every numeric field carries its source snippet, and Internal QA validates a sample of these against the actual document text on every batch.

---

## 4. Project Tracking (the librarian)
**Why it exists:** The same real-world data center project shows up under different LLC names across PUCT, TCEQ, and county filings — sometimes deliberately, to obscure who's behind a deal. Without a layer that reconciles these into one project record, the database is just a pile of disconnected filings and pattern detection becomes impossible. This is the agent that turns "stuff happening" into "things we're tracking."

**Role:** Resolve new extraction records against the existing project graph; create new projects, update existing ones, or flag ambiguous matches for human review.

**Inputs:** New extraction records, the current `projects` table, vector embeddings of project names and addresses.

**Outputs:** A stable project ID assigned to every extraction, project records with canonical name, primary parties (with aliases), county, MW estimate, status, and a timeline of every signal that touched the project. Written to `projects` and `project_signals` tables.

**Tools:** Claude Sonnet for fuzzy entity reasoning, pgvector on Supabase for embedding-based similarity across LLC names and addresses, a deterministic merge log capturing the reasoning for every link decision.

**Handoff:** Writes to `project_signals`; triggers Change Detection.

**What good looks like:** Two filings six months apart from "Sandstone Holdings LLC" and "Sandstone Compute Texas LLC" at adjacent addresses in Hood County collapse into one project record without losing the trail.

**Failure risks:** False merges — linking two unrelated projects that share a county and MW range — quietly poison the database forever. False splits are recoverable; false merges are not. **Mitigation:** deliberately high merge threshold, every merge decision logged with the model's reasoning, weekly review of the last fifty decisions, and ambiguous matches routed to a human-review queue rather than auto-merged.

---

## 5. Change Detection (the watcher)
**Why it exists:** Most updates to a project are routine paperwork — a docket housekeeping entry, a re-filed exhibit, a procedural deadline extension. A few updates are genuinely material — capacity doubled, parties changed, deposit forfeited. The product fails if subscribers can't tell the difference, because either we drown them in noise or they miss the one thing that mattered. This agent is the difference between a useful feed and an unusable one.

**Role:** Compare each new extraction against the project's prior state and emit a typed change event with a materiality flag.

**Inputs:** New extraction records plus current project state.

**Outputs:** Change events with type (new project, status change, party change, MW change, date change, document added, withdrawal, deposit event), a one-line description, before/after values for changed fields, and a procedural-vs-substantive flag. Written to `change_events`.

**Tools:** SQL diff for structured field comparison, Claude Haiku for the description and the materiality flag, a versioned classifier prompt with hand-labeled examples.

**Handoff:** Sends events to Scoring.

**What good looks like:** When a docket gets a routine re-filing, the event is logged but flagged procedural. When the same docket has its requested capacity revised from 200 MW to 600 MW, it's flagged substantive within the hour.

**Failure risks:** Treating procedural noise as substantive drowns subscribers in alerts; treating substantive changes as procedural means they miss what matters. **Mitigation:** maintain a hand-labeled set of fifty historical events as few-shot examples in the prompt, refined as new edge cases appear, and let Internal QA sample the flag decisions weekly.

---

## 6. Scoring (the prioritizer)
**Why it exists:** Three different products — same-day Alerts, the Monday Briefing, the searchable Dashboard — need different signal thresholds. Without an explicit scoring layer, every signal looks equally important and the products blur together. Scoring is also where audience targeting happens: an OEM rep cares about a different signal than a hedge fund analyst, even when it's the same filing.

**Role:** Assign every change event a 1–10 significance score, an audience tag (developer, OEM, PE, hedge fund — possibly multiple), an urgency tag (alert-now or digest-only), and a one-paragraph "why it matters" written in the audience's language.

**Inputs:** Change events plus full project context (history, parties, prior signals).

**Outputs:** Scored signals written to `signals`, tagged with score, audiences, urgency, and the why-it-matters paragraph.

**Tools:** Claude Sonnet running a versioned scoring rubric stored in the database — for example, **9–10** for things that move a public stock or kill a $100M+ project, **7–8** for significant new data on an active deal, **5–6** for useful weekly context, **below 5** for database-only.

**Handoff:** **Score 8+ routes to Client Delivery for immediate alert.** Score 5–7 queues for Editorial Synthesis. Below 5 stays searchable but doesn't push.

**What good looks like:** The score distribution looks like a real distribution — a few 9s a month, more 7s, lots of 4s. Subscribers eventually tell you the alerts are always worth opening and the Briefing's lead story is always the right one.

**Failure risks:** Score inflation — the model wants to be helpful and rates everything 7+, the alert tier becomes spam. **Mitigation:** weekly calibration where a sample of ten signals per bucket gets re-rated manually and the rubric tuned. Also prompt the model with the running score distribution so it self-corrects against drift.

---

## 7. Editorial Synthesis (the writer)
**Why it exists:** A list of signals is not a product. Subscribers pay for a writer who reads everything, identifies what mattered this week, finds the connections across signals that no one else spotted, and tells them in clear prose what to do with it. This is the agent whose output most directly determines whether subscribers renew. It's also the most exposed to hallucination risk because it's writing prose, not extracting fields.

**Role:** Every Sunday night, generate the Monday Briefing draft.

**Inputs:** All signals from the past seven days scored 5+, the project graph for context, last week's Briefing for continuity callbacks, the running voice guide.

**Outputs:** A complete Briefing draft — top stories at 100–200 words each (cap at ten), a short patterns section, a "what to watch next week" closer, and footnoted source signal IDs for every claim. Written to a `briefings` table for QA review before publication.

**Tools:** Claude Sonnet with a strict voice guide in the system prompt (tight, plainspoken, Bloomberg-density, no consultant-speak, no padding, no hedging filler).

**Handoff:** Sends draft to Internal QA, which gates publication by Client Delivery.

**What good looks like:** A subscriber forwards the Briefing to a colleague within an hour of Monday morning. Each story tells them something they didn't know and tells them what it means.

**Failure risks:** Padding on slow weeks, manufactured "patterns" linking unrelated projects to fill space, tone drift toward generic newsletter prose, hallucinated facts not present in any source signal. **Mitigation:** hard cap of ten stories, every "pattern" claim must reference two or more source signals, every factual claim must be footnoted to a signal ID, and QA blocks publication on any unsupported claim.

---

## 8. Lead Generation (the recruiter)
**Why it exists:** The business model is cold outbound to a defined universe of buyers — maybe two thousand named decision-makers across developers, OEMs, PE/infra, and hedge funds. Without a clean, current prospect database, outreach personalization has nothing to personalize against and deliverability craters. This agent is what turns the abstract target list into a working pipeline.

**Role:** Build and maintain the prospect database.

**Inputs:** The target-company list, enrichment APIs, periodic LinkedIn lookups, news mentions of relevant titles changing roles.

**Outputs:** Prospect records with name, title, company, LinkedIn URL, verified work email, fit score, and recent activity signals (job changes, relevant posts, conference appearances). Written to `prospects` with a refresh-due timestamp.

**Tools:** Apollo free tier (50 contacts/month — supplement with manual lookups when exhausted), Hunter for email verification, Claude Haiku for fit scoring against a job-title and seniority rubric.

**Handoff:** Hands fit-scored, verified prospects to Outreach Personalization.

**What good looks like:** Outreach always has a queue of fresh, verified, well-targeted prospects. Bounce rates stay under two percent.

**Failure risks:** Stale data (the person left the company), wrong-target outreach (a junior associate when the partner is the buyer), unverified addresses tanking sender reputation. **Mitigation:** Hunter verification before any send, 60-day prospect refresh cycle, fit scoring tuned against actual reply rates.

---

## 9. Outreach Personalization (the salesperson)
**Why it exists:** Generic cold email is dead. The only outbound that works at this scale is highly specific, signal-led personalization — opening with one fresh thing the recipient's company should care about. Lucky for us, the database is full of fresh signals. This agent is what turns "we have data" into "we have a sales motion."

**Role:** For each prospect, find the most relevant recent signal in the database and draft a four-to-five-line cold email opening with that signal, followed by a one-line free-trial offer.

**Inputs:** A prospect record, the live signals database, a small library of templates by audience type, a voice guide.

**Outputs:** Drafted emails queued in Gmail Drafts via Mailmeteor for human review. Each draft logs which signal was used so we can A/B test.

**Tools:** Claude Sonnet for drafting, pgvector similarity search to match company-relevant signals to each prospect, Mailmeteor for Gmail send orchestration.

**Handoff:** Drafts queue in your Gmail. You review and send 30–50 per day.

**What good looks like:** Reply rates above two percent. Replies that say "how did you know we were looking at Hood County" rather than "please remove me."

**Failure risks:** Personalization that's actually generic ("I see you work in data centers!"), stale signals the prospect already knows, tone misfit on institutional contacts (sounding too startup-y to a Brookfield director). **Mitigation:** mandatory human review on the first two hundred sends, weekly A/B tests on opening-line variants, separate voice profiles per audience.

---

## 10. Client Delivery (the publisher)
**Why it exists:** Everything upstream is worthless if the right subscriber doesn't get the right thing at the right time. This is the operational layer that makes the system a product instead of a research project. It also closes the feedback loop — what subscribers click and search teaches Editorial what's actually working.

**Role:** Send the Briefing every Monday at 7am Central, fire alerts within minutes of high-score events, run the Dashboard, manage subscriber state.

**Inputs:** QA-approved Briefing drafts, score-8+ alerts, the subscriber list segmented by tier, Stripe webhook events.

**Outputs:** Delivered emails, Dashboard query responses (live against Supabase, with row-level security enforcing tier access), subscription state changes synced to the database, and engagement analytics flowing back to the database for Editorial.

**Tools:** Beehiiv for the Briefing, Resend for transactional alerts, Cloudflare Pages for the Dashboard front-end, Supabase Auth for subscriber login, Stripe webhooks landing in Supabase, row-level security policies enforcing tier access at the database level.

**Handoff:** Closes the loop — open rates, click-throughs, and Dashboard search queries flow back to the signals database for Editorial to learn from.

**What good looks like:** The Briefing lands in inboxes within five minutes of 7am Central every Monday. Alerts arrive within minutes of a high-score event. The Dashboard is up. Stripe upgrades reflect in tier access in under thirty seconds.

**Failure risks:** Mis-segmented sends (a Pro subscriber receives a Hedge-Fund-only alert), spam-folder delivery, Dashboard outages right when subscribers want to look something up. **Mitigation:** a pre-flight tier check on every send, daily delivery and bounce monitoring, uptime alerts on the Dashboard endpoint.

---

## 11. Internal QA (the auditor)
**Why it exists:** Every other agent in this system can be wrong in ways that aren't immediately obvious. Quote-anchored extractions can still be misread. Briefings can be confidently fluent and quietly wrong. The product trades on accuracy — one bad MW figure circulated by a subscriber and the brand is over. QA is the layer that exists specifically to catch the other agents before paying customers see anything. **It is the most important agent for long-term survival of the business.**

**Role:** Sample upstream output, validate it against source material, flag failures, write corrections back to the originating tables, and gate publication of anything subscriber-facing.

**Inputs:** A sample of extraction records, every score-8+ signal, every Briefing draft, every cold email batch above a sample threshold.

**Outputs:** Pass/fail flags with specific issues, corrections written back to upstream tables, and a weekly QA report summarizing failure modes and trend lines.

**Tools:** A Claude model from a different family or a different size from the upstream agent it's auditing — **shared blind spots are the failure mode this exists to prevent.** Strict validation prompts: "compare each extracted field to the source quote and flag any mismatch," and for the Briefing, "every claim must be traceable to a source signal — flag anything unsupported."

**Handoff:** Blocks Briefing publication and high-score alerts until pass; routes flagged extractions back to the originating queue with notes.

**What good looks like:** Subscribers never catch a factual error before QA does. The weekly QA report shows a clear trend of failure modes being identified and tuned out of the upstream prompts.

**Failure risks:** QA rubber-stamps everything because it shares biases with upstream models — the most dangerous failure mode in the entire system because nothing else catches it. **Mitigation:** deliberate model-family diversity between auditor and auditee, you spot-check ten random QA decisions weekly, and strictness is tuned based on what you catch that QA missed.
