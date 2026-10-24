# Master checklist

Owners: **PY** = Python developer (+ their AI) · **TS** = TypeScript developer · **PD** = pitch & docs teammate · **ALL** = everyone.
Tick items off in this file (small commits) or in team chat.

## Now → 3:30 PM
- [ ] **ALL** Every teammate is checked in and on Slack; PD creates the Devpost project and adds both teammates.
- [ ] **PY** Anthropic API key, Factory account + `droid` CLI + `FACTORY_API_KEY`, Nessie key, Apify token.
- [ ] **PY** CRS sandbox signup at calhacks.crscreditapi.com (credentials + Postman collection arrive by email).
- [ ] **TS** SpacetimeDB CLI installed, `spacetime login`, claim SpacetimeDB credits; Node 22+.
- [ ] **PD** Hyphenate mixer (Mixer Area, Gate 6, until 4 PM): pitch the moment, ask what AP clerks actually get wrong, ask what they've already seen a lot of.
- [ ] **PD** Booth round (notes to `pitch/booth-notes.md`):
  - CRS: which test identities/businesses have liens, judgments or fraud flags; is identity verification (OTP/KBA) in the sandbox; what "responsible" means to them.
  - Factory: credits; can the Python SDK turn off Droid's built-in file/shell tools?
  - SpacetimeDB: credits, prize criteria.
  - Anthropic, Microsoft, Armadin: criteria not yet published.
  - Apify: does a license-board Actor count; Best Actor rules.
- [ ] **PD** Find a real contractor to talk to for 10 minutes before 6 PM (family, friends, Slack, local GCs).

## By ~3:45 PM — SpacetimeDB check (go / no-go)
- [ ] **TS** Local module with one table and one reducer, published.
- [ ] **PY** Calls that reducer from Python over HTTP with a positional JSON array, reads it back with SQL.
- [ ] **TS** Next.js page shows the row live.
- [ ] If any of these fail by 3:45: switch to the SQLite fallback (decide together).

## By 5:30 PM
- [ ] **TS** All P0 tables and reducers from `docs/CONTRACT.md`, published locally; pushed to `main`.
- [ ] **PY** `scripts/setup_actors.py`, seed data loaded through reducers.
- [ ] **PD** Research pack to PY (sources required): California statutory lien waiver forms, typical retainage and pay-application format (schedule of values), how fake bank-change scams hit contractors, real loss figures.

## By 7:00 PM — one bill end to end
- [ ] **PY** Upload → extraction → core checks → proposal.
- [ ] **TS** Work item list, live investigation view, phone approval screen.
- [ ] **PY** Gateway pays an approved proposal (Nessie mock or real) and records it.
- [ ] **PD** Interview notes in `pitch/interview-notes.md`; pitch outline v1.

## By midnight
- [ ] **PY** Droid runs the investigation; real CRS, Nessie and Apify; scam generator; `scam_submit` jobs; compromised-agent demo; "why?" chat.
- [ ] **TS** "Scam us" page + live counter, payment-run view, audit log view, contracts view, chat; module P1 reducers; publish to Maincloud; web on Vercel.
- [ ] **PD** **Devpost draft submitted** (title, tagline, description, tracks, teammates, image, repo link).
- [ ] **PD** QR code for the "scam us" page once the Vercel URL exists.
- [ ] **PD** GoDaddy Registry domain registered and pointed at the web app.

## By 4:00 AM — feature freeze
- [ ] **PY** Scorecard run (~200 scams + ~50 real bills) finished, numbers locked.
- [ ] **PY** Should-haves as time allows: Gmail intake (30-min limit), policies from corrections, bank-change verification.
- [ ] **TS** Scorecard page, books view, demo control panel (compromised-agent button, reset).
- [ ] **PD** Slides updated with final scorecard numbers.
- [ ] **ALL** Nothing new after 4 AM, only fixes.

## 4:00 → 8:00 AM
- [ ] **ALL** Demo reset script works; full run-through on the demo laptop.
- [ ] **PD + ALL** 5+ timed pitch rehearsals (2-minute and 3-minute versions) and Q&A drill.
- [ ] **PD** Record the demo video (opens with the moment); upload; link on Devpost.
- [ ] **PD** README final: setup, architecture, **where Droid runs**, CRS data use, real vs. simulated, Cartesia section (if used), team.
- [ ] **PY** Apify Actor published (if built), link in README.

## By 8:30 AM — final submission (deadline 9:00 AM, hard)
- [ ] **PY** Repo made public; scan for secrets (`git log -p | grep -i key` and check `.env` never committed).
- [ ] **PD** Devpost final: every track selected, video, image, repo link, all teammates added.

## Judging (10:30 AM – 12:30 PM)
- [ ] **ALL** At the assigned table the whole time (all three, or we aren't judged).
- [ ] **ALL** Laptop charged, demo reset, backup video ready offline, QR code visible, phones logged in as owner.
