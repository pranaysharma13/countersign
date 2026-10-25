# Demo script: Countersign

Exact clicks and lines. Every step has a fallback. Numbers are the answer key's; if the screen shows anything else, stop and say what you see.

## Before you start

- **Offline (default, no keys):** `cd web && npm run dev`, open `http://localhost:3001`. Optional: the Python API on :8000 for PDF preview, "Download audit" and "Why?".
- **Live (only if it's been rehearsed that day):** the worker, the API and `DATA_SOURCE=live`. See the README. The judge page needs live mode; offline it says "not run".
- Signed in as **Dana Marlow, owner**. If BM-23104 isn't at revision 1, click **Start over** (top bar, owner, offline).
- Person switcher: the **I am** menu in the top bar.
- Tabs ready: `/invoices/inv_bm23104`, `/invoices/inv_bm23104/approve`, `/receive/inv_bm23104`, `/sneak`, and `data/scorecard_v2.md` (the slide).

## 2-minute version

| Time | Do | Say |
|---|---|---|
| 0:00 | Invoice tab, BM-23104 | "BayMix quoted concrete at $165 a yard. This invoice bills $172, adds $225 of waiting time nobody agreed to, and a $1,200 Saturday delivery our buyer *did* approve. That's how contractors overpay every month: not fraud, just charges nobody checks against the email thread." |
| 0:20 | Point at the reconciliation: $87,425 claimed, $3,725 under review | "Countersign keeps the $1,200 and holds $3,725 *under review*. Not 'saved': it's only money back if BayMix agrees." |
| 0:35 | Click an evidence chip on the concrete line | "Every number points to the exact line it came from: here's the quote at $165." *(The chip shows the fragment's text from the module; no API needed.)* |
| 0:50 | Approve tab: "Nothing is ready to pay yet" | "Can the owner just pay? No. Countersign proposed nothing, and the open holds on the bill say why: price and waiting time disputed, nobody has confirmed delivery. Approval is checked by the database itself, not by a prompt." |
| 1:05 | I am → Buyer; Invoice tab → **Send to supplier** | "The buyer sends the clarification it drafted. BayMix replies and sends a corrected invoice for $83,700." *(Offline the reply and correction are simulated; the timeline says so.)* |
| 1:20 | I am → Site; Receive tab → 500 cy, note → **Confirm what arrived** | "The superintendent confirms what arrived. We don't see delivery tickets, so receipt is a person's signature, labelled as such." |
| 1:35 | I am → Owner; Approve tab → **Approve $73,700.00** | "$83,700 less the $10,000 deposit, applied once. The owner approves exactly $73,700; the gateway pays once (simulated bank); accounts payable ends at zero." |
| 1:50 | Scorecard slide | "Measured, not claimed: 18 scenarios through the real pipeline. Every expected hold caught, no false holds, all 73 amounts exact." |

## 3-minute version

The 2-minute version with two additions: "Why?" while revision 1 is still on screen, and the judge page at the end.

| Time | Do | Say |
|---|---|---|
| 0:00–0:35 | As in the 2-minute version | |
| 0:40 | Invoice tab → **Why?** on the concrete line (revision 1) | "Ask why: a separate Claude call with citations, from that line's own documents. It explains; it can't change an amount or an approval." *Needs the Python API on :8000. With `AI_MODE=fixture` it's a labelled template citing the same fragments: say so. No API: skip this beat.* |
| 0:55–1:55 | 0:50 to 1:50 of the 2-minute version | |
| 2:10 | Judge tab (live only) → Kind of charge: price, $172 → **Submit as a judge** | "Try to sneak one past it. Your invoice goes to a fictional sandbox supplier, it's read like any other, and the real checks open the hold: price variance, plus receipt, because nobody's confirmed delivery. BM-23104 is untouched." *Fallback offline: show the eight judge rows on the scorecard slide.* |
| 2:35 | Scorecard slide, "found and fixed" lines | "The scorecard found two of our own bugs before these numbers. CRS wasn't asked when an invoice arrived, and a payment could be proposed with a prompt-injection hold open. Both are fixed, with tests." |
| 2:50 | Back to the invoice | "Countersign does the purchasing coordinator's and the AP exceptions analyst's checking. The owner still signs." |

## If something breaks

- **A number on screen differs from the script:** say "that's not what the answer key says", open the Record panel (the audit trail), and continue on the scorecard slide.
- **The page won't load:** offline mode needs no network. Restart `npm run dev`. If it's still down, use the screenshots and the scorecard slide.
- **A button is disabled, or "You cannot pay yet" appears:** read the listed reasons aloud. That's the product working.

## Q&A

**What if the AI misreads an email as an acceptance?**
An acceptance is its own field and must cite the exact sentence. The rules treat "proposed" and "accepted" differently. An internal approval only counts when an authorized person makes it in the app, within their limit. The waiting-time charge stays a proposed charge until it's agreed.

**Why not a three-way match in our accounting software?**
A three-way match compares the PO, the receipt and the invoice. Price changes agreed by email, extras proposed but never accepted, and a new price that only covers some deliveries all live outside the PO. That's where the money goes.

**What's real and what's simulated?**
- Real: the module's rules, the checks and the pipeline.
- Simulated: the bank and the supplier emails.
- Mock: CRS.
- Fixture by default, labelled on screen: Claude's extraction. It was measured live once: 27 of 27 fields.
- Built but not yet run with a real key: Droid and the live "Why?".

**How do you know it works?**
A hand-written answer key, and a scorecard that runs 18 scenarios through the real pipeline and grades every hold and amount. Plus unit tests on the module's permissions and the money rules.

**What about delivery quantities?**
We don't see tickets or GPS, so we never claim delivery is verified: the superintendent attests it. A price that only covers deliveries from a certain date waits for the delivery tickets instead of guessing.

**Can the agent pay or approve?**
No. The database refuses approve, pay, payee verification and hold clearing from the agent's identity, and logs the attempt. The agent can open holds and propose.

**What if the supplier won't correct the invoice?**
The owner decides each disputed line: accept as billed (within their limit) or pay the agreed part and dispute the rest. The notice to the supplier has to be sent before anything is paid. We never silently pay less.

**What do you pull from CRS, and why?**
Business public records (liens, judgments, bankruptcies) on the supplier's provided test identity. Any record holds payment for the owner. Today it's mock test data; the live endpoint mapping is waiting on the sandbox collection.

**Where does Droid run?**
One session per invoice revision, inside the document job, with only our nine tools and built-in file and shell tools removed. The numbers are recorded before Droid starts. Built and tested; not yet run with a real key. Don't claim it ran.

**How does this reach production?**
Email intake from Outlook (Microsoft Graph), QuickBooks or Procore for the books and POs, a real bank API behind the same gateway, and delivery tickets for receipt.

**Who pays, and how much?**
**[ADD]** your pricing answer. Don't invent customer numbers.
