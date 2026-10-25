# Countersign

**Countersign checks every supplier invoice against what was actually agreed (the quote, the purchase order and the email thread) and prepares a payment the controller can trust.** It keeps legitimate charges, questions the rest with evidence, and never moves money on its own.

Built at Cal Hacks 13.0.

## The problem

Small general contractors buy materials on quotes, purchase orders and a trail of emails. Weeks later the invoice arrives with a higher unit price, waiting time and extras, some agreed and some only proposed. Busy teams pay it. Fraud is rare; paying more than you agreed happens every month.

## What Countersign does

- **Reads the agreement:** the quote and its terms, the purchase order, and email threads. It tells proposed changes from accepted ones, and checks who approved them, within what limit, and for which deliveries.
- **Checks every invoice** line by line: claimed vs. accepted vs. pending, with each figure tied to the exact sentence or page it came from.
- **Keeps five separate statuses** (commercial, receipt, payee, approval, payment) and independent holds; one green light never hides another red one.
- **Asks instead of short-paying:** drafts a clarification to the supplier and processes the corrected invoice when it arrives.
- **Never moves money on its own.** The controller approves a payment bound to the exact invoice version; any change makes the approval stale. Only the gateway pays, exactly once.

## Repository layout

| Folder | What lives there | Language |
|---|---|---|
| `db/` | SpacetimeDB module: tables, roles, statuses, holds, approvals, audit log, job bus | TypeScript |
| `core/` | Worker, Claude extraction, Factory Droid agent, checks, gateway, integrations | Python |
| `web/` | Work queue, purchase record, invoice case, approval review, judge page | TypeScript (Next.js) |
| `data/` | Fictional company, documents, answer key | JSON / Python |
| `docs/` | Interface contract, architecture, detailed spec, prize tracks, checklist, team briefs | Markdown |

Start with [SPEC.md](SPEC.md), then [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/CONTRACT.md](docs/CONTRACT.md).

## Setup

1. Copy `.env.example` to `.env` and fill in your keys. Never commit `.env`.
2. Per-folder setup lives in each folder's README (`core/README.md` for the Python side).

## Sponsors used

Hyphenate · SpacetimeDB · Factory · Anthropic · CRS · Capital One Nessie · Apify · Microsoft
