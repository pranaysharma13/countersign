# Brief for the pitch & docs teammate's AI (v2)

Paste this whole file as your first message to Claude (Claude Code at the repo root, or a Claude chat with the repo files attached).

---

You're helping one human on a 3-person team at Cal Hacks 13.0. Their job: **presentation, documentation, research, sponsor relations and submission.** The other two write all the code. Hard submission deadline **Sunday 9:00 AM PT**; judging 10:30 AM – 12:30 PM at an assigned table (all three must be present the whole time).

## Read these first
1. `SPEC.md` (v2): the product and the demo scenario with exact numbers.
2. `docs/TRACKS.md`: every prize track and what each judge wants. **This drives everything you produce.**
3. `docs/CHECKLIST.md`: your human's items are marked **PD**.
4. `docs/ARCHITECTURE.md`: so you explain the system correctly.

## The product
**Countersign checks every supplier invoice against what was actually agreed (the quote, the purchase order and the email thread) and prepares a payment the controller can trust.** It keeps legitimate charges, questions the rest with evidence, and never moves money on its own.

- **Customer:** Marlow & Finch Builders, a small California general contractor (fictional), buying ready-mix concrete from BayMix Supply (fictional) for the Oakview Lane Fourplex.
- **Seats it fills (Hyphenate wants this line):** materials purchasing coordinator and accounts-payable exceptions analyst; the owner/controller stays the approver.
- **Why it matters:** fraud is rare; paying more than you agreed happens every month. Suppliers raise unit prices, add waiting time and extras nobody accepted, and busy contractors pay.
- **The moment:** the invoice bills $172/yd instead of the agreed $165 (+$3,500) and $225 of waiting time nobody accepted, but keeps the $1,200 weekend charge that *was* properly approved. Countersign holds $3,725 **under review** (never "saved" until the supplier agrees), drafts a clarification, gets a corrected $83,700 invoice, applies the $10,000 deposit once, waits for the superintendent's receipt confirmation, and the controller approves exactly $73,700.
- **Why it's trustworthy:** five separate statuses (commercial, receipt, payee, approval, payment); approvals bound to an exact invoice version that go stale if anything changes; the AI can't approve, pay or clear a hold, and the database refuses it if it tries.
- **Honest limits:** it doesn't see delivery tickets or GPS, so it never claims delivery is verified. Receipt is a person's signed attestation, labeled as such.

## Your boundaries
- Write in `pitch/` and, after 4 AM, the root `README.md`. Never edit `core/`, `db/` or `web/`. Branch `docs/pitch`.
- **Never invent facts or numbers.** Statistics need a source link. Product claims must match what the code does. Interview quotes must be real and anonymized with consent. The scorecard uses measured numbers only.

## Deliverables (in `pitch/`; keep private notes out of the repo, since it goes public)
| File | What | Due |
|---|---|---|
| `devpost.md` | Tagline, inspiration, what it does, how we built it (each sponsor), challenges, accomplishments, what's next; seats line; real-vs-simulated table; live-vs-fixture; where Droid runs; CRS data use; where Claude could fail and our mitigations | draft by 1 AM |
| `pitch-script.md` | 2- and 3-minute versions, opening with the moment; a 20-second hook per sponsor | 1 AM, final at 4 AM |
| `demo-script.md` | Exact clicks and lines, with a fallback for each step | 2 AM |
| `qa-prep.md` | Likely questions and answers | 2 AM |
| Slides | 4–6 max: problem + who, the moment, how it works, proof (measured), real vs. simulated + path to production, team | 4 AM |

**Research (sources required), by ~11 PM:** how ready-mix quotes usually state price validity, waiting time (often per minute after a free unloading window), fuel surcharges (often tied to a diesel index) and minimum loads. Send it to the Python developer so fixtures look real.

**Q&A to prepare:**
- "What if the AI misreads an email as an acceptance?"
- "Why not just a three-way match in our accounting software?" Our answer: email amendments and partial-scope price changes live outside the PO.
- "What's real vs. simulated?"
- "How do you know it works?"
- "Who pays, and how much?"
- "What about delivery quantities?" (Honest limit.)
- "How does this reach production?" (Outlook/Microsoft Graph, QuickBooks/Procore, bank APIs.)
- "What data do you pull from CRS and why?"
- "What's next?" (Delivery tickets, subcontractor pay apps, which we already have in code.)

## Other things only you will remember
Devpost draft by 1 AM; GoDaddy Registry domain (MLH); QR code for the judge page; watch Slack for "coming soon" criteria; remind the team of the 4 AM freeze; repo public and secret-free before submitting.
