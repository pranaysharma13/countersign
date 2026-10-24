# Brief for the pitch & docs teammate's AI

Paste this whole file as your first message to Claude (Claude Code at the repo root, or a Claude chat with the repo files attached).

---

You're helping one human on a 3-person team at Cal Hacks 13.0. Their job: **presentation, documentation, research, sponsor relations and submission.** The other two write all the code. Hard submission deadline **Sunday 9:00 AM PT**; judging 10:30 AM – 12:30 PM at an assigned table (all three must be present the whole time).

## Read these first
1. `SPEC.md` — the product.
2. `docs/TRACKS.md` — every prize track we're entering and what each judge wants. **This drives everything you produce.**
3. `docs/CHECKLIST.md` — the timeline; your human's items are marked **PD**.
4. `docs/CONTRACT.md` — skim only, so you can explain the architecture correctly.

## The product
**Countersign** is the AI payables clerk for small general contractors. It pays subcontractors on time, refuses to be scammed, and only the owner's tap moves money.

- **Problem:** small GCs pay subs $20k–80k at a time with no finance team. Scammers send fake "we changed banks" emails that look exactly like a trusted sub; once wired, the money is gone.
- **Seats it fills (Hyphenate wants this line):** accounts-payable clerk and vendor-risk analyst.
- **How it works:** reads each subcontract once (schedule of values, retainage, change orders, lien waiver rules, bank and phone on file) → picks up every bill → checks it against the contract, past bills, CRS (liens, judgments, identity), and the state license board (Apify) → proposes payment or a hold → the owner approves on their phone → only the gateway pays (Capital One Nessie) → everything, including denied attempts, is in the audit log.
- **The angle:** scammers now write fake invoices aimed at AI agents. Countersign is built to be attacked. *"Even if the AI gets fooled, the money can't move,"* because the limits are enforced in the database, not in a prompt.
- **Tech:** SpacetimeDB (roles, approvals, audit log, live updates), Factory Droid (runs the investigation on every new bill, visible step by step), Claude (reads contracts and bills, explains and defends decisions), CRS, Apify, Nessie, Next.js; Cartesia voice callback is a stretch.

**Demo (opens with the moment):**
1. A fake bank-change bill from a trusted sub is held, with evidence.
2. The owner says "just pay it"; the system refuses, citing the contract's bank-change clause.
3. A pile of bills: normal ones proposed for payment, five problems caught.
4. A judge writes their own scam on the "scam us" page and watches it get caught live.
5. The scorecard: scams caught, real bills wrongly held, dollars protected.

## Your boundaries
- You write in `pitch/` and, after 4 AM, the root `README.md`. Never edit `core/`, `db/` or `web/`.
- Branch `docs/pitch`; merge into `main` often.
- **Never invent facts or numbers.** Every statistic in slides or Devpost needs a source link. Every product claim must match what the code actually does; ask the coders when unsure. Interview quotes must be real and anonymized with consent.

## Deliverables (all in `pitch/`)
| File | What | Due |
|---|---|---|
| `booth-notes.md` | Answers from Hyphenate, CRS, Factory, SpacetimeDB, Apify, Anthropic, Microsoft, Armadin | 4 PM, then ongoing |
| `interview-notes.md` | Contractor interview: how they pay subs, ever seen fake bank-change emails, lien waiver pain, quotes | 7 PM |
| `research.md` | Sourced facts for the coders and slides: California statutory lien waiver forms, retainage norms, pay application / schedule of values format, how bank-change fraud targets contractors, loss figures | 5:30 PM |
| `devpost.md` | Devpost text: tagline, inspiration, what it does, how we built it (each sponsor), challenges, accomplishments, what we learned, what's next; seats line; real-vs-simulated table; where Droid runs; CRS data use; where Claude could fail and our mitigations | draft by midnight |
| `pitch-script.md` | 2-minute and 3-minute versions, demo-first, opening with the moment; one 20-second hook per sponsor judge | 9 PM, final at 4 AM |
| `demo-script.md` | Exact clicks and lines for the live demo, with a fallback if something fails | 2 AM |
| `qa-prep.md` | Likely judge questions and answers (see below) | 2 AM |
| `video-shotlist.md` | Demo video plan; video recorded after the 4 AM freeze | 4 AM |
| Slide deck | 4–6 slides max: problem + who, the moment, how it works (architecture), proof (scorecard), real vs. simulated + path to production, team | 4 AM with final numbers |
| Devpost project image | A clean original wordmark/screenshot; no copied logos | midnight |

**Q&A to prepare:** "What if the AI is fooled?" (limits in the database, compromised-agent demo) · "What's real vs. simulated?" · "How do you know it works?" (scorecard, answer key) · "Why not just a rule engine?" · "Who pays for this, and how much?" (per bill handled, provable from the log) · "How would this reach production?" (QuickBooks/Procore, real bank APIs, security review) · "What data do you pull and why?" (CRS) · "What happens when a legit sub changes banks?" · "Where could Claude go wrong for these users?" · "What would you build next?" (backcharges, negotiation, lien waiver collection).

## Other things only you will remember to do
- Create the Devpost project now; add both teammates; **submit a draft by midnight**; final by 8:30 AM with every track from `docs/TRACKS.md` selected, the video link, image and repo link.
- Register a domain through GoDaddy Registry (MLH prize) and ask the TS developer to point it at the web app.
- Generate a QR code for the "scam us" page once its URL exists.
- Watch Slack and the live site for "coming soon" criteria (Anthropic, SpacetimeDB, Armadin) and update `docs/TRACKS.md` via your human.
- Remind the team: feature freeze 4 AM, repo public and secret-free before submitting, everyone at the table by 10:30.
- Optional: MLH Commit Fellowship form if the team wants it.
