# Prize tracks we're entering

What each judge looks for, and the evidence we must show them. Criteria are quoted or paraphrased from the Cal Hacks 13.0 hacker guide, Devpost, and sponsor starter packs. "Coming soon" tracks: check the live site and Slack for updates.

## Hyphenate — The Hyphenated Enterprise (main target)
**Prize:** $8,000 / $5,000 / $3,000, fast-track interviews for the top 5.
**They ask four questions:**
1. *Is it real enough?* Realistic data, a messy problem, proof it works.
2. *Would you hire it?* For which seats; limited access, a clean record of its work, knowing when to ask.
3. *Did we see something new?*
4. *The moment:* catches what others missed, recovers from something going wrong, or defends a decision when questioned.

**Submit:** a video that **opens with the moment**, a live demo (they may ask us to try their own scenario), **one line on the seats**, and **proof: what's real, what's simulated, how we know** (answer key / scorecard).

**From their workshop deck:** build a "system of work" on top of systems of record; one gateway checks every write; limits enforced in code, not prompts; memory beyond the context window; learns policies, turns corrections into precedent, answers "why?" months later. Weak: one-shot extractor, clean data, all-powerful key, "the prompt tells it not to".

**Our evidence (v2):** seats line (materials purchasing coordinator + AP exceptions analyst) · invoice checked against quote + PO + email thread, with amendments scoped to their deliveries · five separate statuses and independent holds · purchasing authority limits and separation of duties enforced in SpacetimeDB · approvals bound to an exact invoice version that go stale on change · clarification loop with the supplier and a corrected invoice · denied attempts in the audit log · answer key with exact values ($87,425 → $73,700) · "under review", never fake "savings" · real-vs-simulated table.

## CRS — Financial Intelligence Challenge
**Prizes:** Best Overall ($1,000) · Best Financial AI Agent ($500) · Best Identity/Fraud Innovation (interviews) · Most Unexpected Use (interviews).
**Criteria:** CRS central (not a bolt-on) · runs live against the sandbox · useful · creative. Also responsible about data. **Use the provided test identities only.**
**Our evidence (v2):** before any deposit or prepayment, CRS business credit and public records (liens, judgments, bankruptcy) on the supplier open `SUPPLIER_RISK` if needed; identity verification backs payee (bank) changes; live sandbox calls in the demo; a short "what CRS data we use and why" note.

## Factory — Best Use of the Factory Droid SDK
**Prize:** $2,000 + credits.
**Scores well:** Droid runs on a trigger we designed · thoughtful control over what Droid can touch · Droid's work visible (plans, steps, diffs, results). **Scores poorly:** chatbot wrapper, slide-only demos, can't tell what the agent did. **README must explain where and how Droid is used.**
**Our evidence:** Droid starts on every new bill job; only our tools, built-in file/shell tools off; every step streamed to `agent_step` and shown live.

## SpacetimeDB
**Prize:** coming soon. **They want** SpacetimeDB as the core real-time backend (AI agent coordination, live dashboards and financial-style apps are named), meaningfully used, not on the side.
**Our evidence:** roles, approvals and audit log enforced in reducers; the job bus between web and agents; live updates on every screen and every judge's phone.

## Microsoft — Built for the Real World (+ Customer Impact Award)
**Prize:** Surface laptop each, tech talk, mentorship.
**Criteria:** customer understanding · measurable usefulness · path from prototype to production · responsible design · end-to-end functionality.
**Our evidence (v2):** contractor interview quotes · measured scorecard (extraction accuracy, exception precision/recall) and dollars under review · production slide (Outlook/Microsoft Graph email intake, QuickBooks/Procore, real bank APIs) · human approval on every payment · full flow working live.

## Anthropic
**Prize:** coming soon. **Criteria:** a named community (not "students") · a real problem you lived or heard firsthand · it works (one thing done well) · thoughtful use of Claude, knowing where it could go wrong for users.
**Our evidence (v2):** "purchasing and AP at small California general contractors" · interview with a real contractor · Claude reads quotes and email threads and tells proposed from accepted, citing exact fragments · a "where Claude could fail" list (treating a proposal as an acceptance, misreading a price, prompt injection, rejecting a legitimate charge) and what we did about each.

## Capital One — Best Use of Nessie
**Prize:** $300 per person. **Criteria:** completeness, creativity, complexity.
**Our evidence (v2):** the supplier deposit, settlement of the corrected balance exactly once, payee account checks, transfers through the gateway.

## Apify — Best use of Apify (+ Best Actor)
**Prizes:** $2,000 / $1,000 / $800 / $400 / $400, plus $400 Best Actor for building an Actor at this event.
**Our evidence (v2):** an Actor that scrapes the public weekly diesel price index so the fuel-surcharge check recomputes what the contract allows; contractor license-board lookup for subs. Publish our own Actor for the Best Actor prize.

## Armadin — Best Security Hack
**Criteria:** coming soon. **Our evidence (v2):** the "sneak a charge past it" page, prompt-injection defense, payee-change hold that only a pre-established contact can clear, limits in code, compromised-agent switch.

## MLH — Best Domain Name from GoDaddy Registry
Register a domain through GoDaddy Registry and point it at the web app.

## Cartesia — Best Use of Cartesia (only if built)
Voice must be **core, not a demo add-on**; 2-minute demo-first presentation; README with Cartesia features used and limitations. Enter only if the verification call to the sub's number on file works well.

## Cal Hacks overall
Judged on impact, quality, technical complexity and creativity, with a live demo. Also consider **Most Technically Advanced**. Hacker's Choice needs no action.
