# Devpost draft: Countersign

> Draft for the pitch teammate. Every claim here was checked against the code and the measured scorecard on 2026-10-25. Lines marked **[ADD]** need a real fact from you; don't invent them. Don't upgrade "rehearsed" or "simulated" to "live" unless you've seen it live.

## Tagline

Countersign checks every supplier invoice against what was actually agreed, and prepares a payment the owner can trust. It never moves money on its own.

## Seats it fills

Materials purchasing coordinator and accounts-payable exceptions analyst. The owner stays the one who approves payments.

## Inspiration

Small general contractors buy materials on a quote, a purchase order and a trail of emails. Weeks later the invoice arrives with a higher unit price, waiting time and extras, some agreed by email and some only proposed. Fraud is rare; paying more than you agreed happens every month, because nobody has time to reread the email thread against every line.

**[ADD]** One real, anonymized line from a contractor you talked to (with consent), or cut this paragraph.

## What it does

Marlow & Finch Builders (fictional) buys ready-mix concrete from BayMix Supply (fictional) at a quoted $165 per cubic yard. Invoice BM-23104 bills 500 cy at **$172**, adds **$225** of truck waiting time nobody agreed to, and includes a $1,200 Saturday delivery charge that purchasing *did* approve.

Countersign:

- **reads the agreement**: the quote and its terms, the PO, and the emails. It tells a proposed change from an accepted one, and checks who approved it, within what limit, and for which deliveries;
- **checks the invoice line by line**: it keeps the $1,200, holds **$3,725 under review** (never "saved" until the supplier agrees), and ties every figure to the exact line of the quote, PO or email it came from;
- **asks instead of short-paying**: it drafts a clarification for purchasing to send, then reads BayMix's reply and the corrected $83,700 invoice;
- **waits for people**: the superintendent confirms what arrived; the owner approves exactly **$73,700** after the $10,000 deposit. The gateway pays once: AP ends at $0, cash out $83,700 (simulated bank);
- **if the supplier won't correct**: the owner decides each disputed line in the app ("Accept as billed", or "Pay agreed, dispute the rest" with a required note). The notice to the supplier must go out before anything is paid, and the original claim stays on record;
- **explains itself**: a "Why?" button on each line gives a cited explanation from that line's own documents. It's a separate call that can't change an amount, a hold or an approval.

Five statuses stay separate (commercial, receipt, payee, approval, payment), and every hold is independent: clearing one never clears another. Approvals are bound to the exact revision, amount, deposit, payee and assessment. If any of those change, the approval goes stale.

**Try to sneak a charge past it.** The judge page lets you submit your own invoice to a fictional sandbox supplier: a higher price, an extra, waiting time, a fuel surcharge, a bank change, or text that tries to instruct the system. It's read and checked like any other invoice, the real checks decide the holds, and BM-23104 is never touched. It needs the live worker; offline, the page says so.

## How we built it

- **SpacetimeDB** is the system of work. Every table, role, status, hold, approval, the job bus between the web app and the agent, and the audit log live in a TypeScript module. Every reducer checks the caller's role and limits, and logs every change and every refused attempt in the same transaction. The web app subscribes, so every screen updates live.
- **Anthropic Claude** reads quotes, POs, emails and invoices into a strict schema in which every value must cite a fragment we validate (`claude-opus-5-5`). Because citations can't be combined with strict JSON output, the "Why?" explanation is a separate call with native citations, mapped back to our fragment ids.
- **Factory Droid** runs one session per invoice revision, with only our nine tools. Its built-in file and shell tools are removed. Code records the numbers before Droid starts; Droid can open amountless holds, draft the clarification (validated by code) and propose a payment without an amount. **Built and tested with a fake; not yet run with a real key.**
- **Capital One Nessie** is behind the gateway: the deposit and the settlement, paid exactly once. **Simulated in the demo** (mock bank, labelled).
- **CRS**: business public records on the supplier's provided test identity; liens, judgments or bankruptcies open `SUPPLIER_RISK` for the owner. **Mock test data in the demo**: the sandbox credentials and endpoint collection haven't arrived.
- **Python** worker, extraction, checks, gateway and scorecard; **Next.js** web app.

## Real vs. simulated

| Part | In the demo |
|---|---|
| Module rules: roles, limits, holds, approvals, audit log | Real code (in-process offline; same code when published) |
| Claude extraction | Fixture by default, labelled on screen; live measured once (below) |
| "Why?" explanation | Fixture template, labelled; live call built and tested with a fake client |
| Droid agent | Scripted agent with the same tools; Droid not yet run for real |
| Bank (Nessie) | Simulated |
| CRS | Mock test identities |
| Supplier emails | Simulated sends |
| Receipt | A person's signed attestation (we don't see delivery tickets or GPS) |

## How we know it works

- **Scorecard v2**: 18 scenarios run offline through the real pipeline and graded by a hand-written answer key. The scenarios: BM-23104 both revisions through payment, two scoped price amendments, a bank-change email, a prompt injection, a PO overrun, an unagreed fuel charge, a supplier with a CRS judgment, a clean invoice, and every judge-page kind plus two clean controls.
  - Hold precision and recall: **28/28**.
  - Exact amounts: **73/73**.
  - Authorised changes paid or accepted: **2/2**.
  - False holds on clean documents: **0**.
  - Judge submissions that touched BM-23104: **0 of 8**.
- **Its first runs caught two of our own bugs**, fixed before those numbers:
  - CRS wasn't consulted when an invoice arrived;
  - a payment could be proposed while a prompt-injection hold was open.
- **Live extraction, measured once** (`claude-opus-5-5`, 9 documents): 27/27 labelled fields correct, and every scenario value reproduced.
- **Tests** cover the module's permissions and money rules (Vitest) and the Python rules, money math and gateway (pytest).
- **Live path rehearsed** end to end against a stand-in that runs the module's code behind SpacetimeDB's HTTP API. It covers publish and reset, the seed check, the worker, the web app in live mode, BM-23104 to $73,700 with AP $0, every judge kind, and the won't-correct path.
  - **[ADD only if you've done it]**: "and on Maincloud", once it's deployed and you've clicked through it.

## Where Claude could fail, and what we did

| Failure | Mitigation |
|---|---|
| Reads a proposal as an acceptance | Acceptance is a separate cited field; an internal approval only counts when made in the app by an authorized person within their limit |
| Misreads a price or quantity | Every value cites a fragment that must exist and match; arithmetic is code; a failed validation goes to review |
| Follows instructions in a document | Document text is data. Pattern scan plus Claude's own flag. An invoice gets `PROMPT_INJECTION`, any other document goes to review. Never followed |
| Rejects a legitimate charge | Accepted changes are paid (the $1,200 weekend charge); a scoped price applies exactly to its scope (120 cy) |
| Guesses a missing fact | Missing rate, date or quantity is null with a reason; a date-scoped price without delivery dates waits for tickets |
| An explanation changes the outcome | "Why?" is a separate read-only call; it can't call a reducer |

## Challenges

- An invalid reducer result doesn't roll back earlier writes, so every rule validates before the first write.
- Keeping a Python reference module and the TypeScript module identical. A seed check replays every seed on both and compares the module's rows column by column.
- Approvals that stay honest: the gateway re-checks eligibility inside the module at payment time, and any changed input makes the approval stale.

## Accomplishments

The measured numbers above, and a system where the agent provably can't approve, pay, verify a payee or clear a hold: the module refuses and logs it.

## What's next

- Run Droid, live "Why?" and CRS with real keys, and deploy to Maincloud.
- Delivery tickets for receipt.
- A diesel index for fuel surcharges.
- Email intake from Outlook (Microsoft Graph); QuickBooks and Procore for the books and the PO.
