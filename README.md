# Countersign

**The AI payables clerk for small general contractors.** It pays subcontractors on time, refuses to be scammed, and only the owner's tap moves money.

Built at Cal Hacks 13.0.

## The problem

Small general contractors pay subcontractors $20k–$80k at a time, usually with no finance team. Scammers send "we changed banks" emails that look exactly like a trusted sub. Once the wire goes out, the money is gone.

## What Countersign does

- **Learns each subcontract once:** line items, retainage, change orders, lien waiver rules, and the bank and phone on file. The owner confirms.
- **Picks up every bill** from the owner's inbox.
- **Checks each bill** against its contract, past bills, CRS (liens, judgments, identity) and the state license board.
- **Lines up the weekly payment run** against the bank balance.
- **Never moves money on its own.** The agent proposes, the owner approves on their phone, and only the gateway pays.
- **Holds firm on "just pay it"** when something is wrong, and explains why with evidence.
- **Logs everything,** so "why was this held?" is one query, months later.

## Repository layout

| Folder | What lives there | Language |
|---|---|---|
| `db/` | SpacetimeDB module: tables, roles, state changes, audit log | TypeScript |
| `core/` | Agent (Factory Droid + Claude), checks, gateway, integrations, inbox sync | Python |
| `web/` | Owner dashboard, approval screen, "scam us" page | TypeScript (Next.js) |
| `data/` | Seed company, subcontracts, bill history, scam scenarios, answer key | JSON / Python |
| `pitch/` | Pitch, research, Devpost text, demo script | Markdown |
| `docs/` | Interface contract, prize tracks, checklist, team briefs | Markdown |

See [SPEC.md](SPEC.md) for the design, [docs/CONTRACT.md](docs/CONTRACT.md) for the TypeScript–Python interface, and [CLAUDE.md](CLAUDE.md) for coding rules.

## Setup

1. Copy `.env.example` to `.env` and fill in your keys. Never commit `.env`.
2. Per-folder setup instructions live in each folder's README.

## Sponsors used

Hyphenate · SpacetimeDB · Factory · Anthropic · CRS · Capital One Nessie · Apify · Microsoft · Cartesia (stretch)
