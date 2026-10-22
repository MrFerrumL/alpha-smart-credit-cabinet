# Engineering worklog — «Поток», online stage

Branch: `feat/e2e-completion`, cut from `main` @ `8f358fa`. Upstream is deliberately not set to `main`, so a
bare `git push` cannot land there. Code freeze: **26.10.2026 10:00 MSK** (submission hour not confirmed).
Scope decision and its rationale: [DECISION_MEMO.md](DECISION_MEMO.md).

## How to pick up the work

1. Read this file and the decision memo.
2. `git log --oneline -15`, `git status`.
3. Continue from "Next step" at the bottom.

## Task checklist

Order agreed on 22.10 (memo §9). P0 must be done by the end of 24.10; 25.10 is reserved for end-to-end
verification, docs, a full review of the branch against the case and the release candidate.

| # | Item | Status |
|---|---|---|
| — | Analysis: case, code, runtime checks, gap list, decision memo | done |
| P0.3 | SSE session (B3), idempotency (B4), token `sub` (B14), company ownership on link (N1) | next |
| CI | GitHub Actions: pytest on PostgreSQL, frontend build, OpenAPI drift, compose smoke | pending |
| P0.1 | Accept offer → sign with in-app code → issue with repayment schedule (B1) | pending |
| P0.2 | Analyst card and decision (B2, B9) | pending |
| P1.8 | Demo resilience: live queue (N2), per-tab token (N4), worker (N5), ports (B12) | pending |
| P1.5 | Credit policy: coverage by profit (N6), current overdue (N7), statement-only revenue (B8), one rate in DSR (N8), other-product counter-offer (N3) | pending |
| P1.6 | Offer expiry (B7) | pending |
| B | Accountant prepares → director signs, authority checked against ЕГРЮЛ | pending |
| G | Risk profiles in the mock generator (N10) together with B5 | pending |
| News | Feed from `news.json`, tagged by OKVED, product, status | pending |
| A | Decision rule trace, policy version, replay | pending |
| C | Policy impact simulator | pending |
| E | Product-dependent conditions before issue | pending |
| Rel | 25.10: e2e verification, full review, `rc` tag | pending |

Every P0 item and every differentiator gets a code review of its diff before the next item starts.

## Environment

- Windows 11, 16 GB RAM, Intel Core Ultra 7 155H; Git Bash and PowerShell 5.1.
- Python 3.12.10 and Node.js 22 installed via winget on 22.10 (Node 22 matches `node:22.16.0` in
  `frontend/Dockerfile`; Node 20 is end-of-life). No local Docker: compose is verified in CI.
- Team research materials (case PDF, market analysis, earlier code review, submission checklist, draft
  request collection, `news.json`) are kept outside the repository.
- No browser automation in this environment; UI checks are manual.

## Case requirements (16 pages)

- p.6: client cabinet (choose a product, go through every stage to the result), bank-side stages and a
  decision model, one working business logic; data persists, the system reacts, state updates live.
- p.7: GitHub with a hash or tag at the deadline; one-command Docker start; lock files; README (purpose,
  architecture, environment, launch, configuration and env vars, components, step-by-step check);
  synthetic data and test accounts; THIRD_PARTY_NOTICES including simulated integrations; **architecture
  diagram, API description, OpenAPI/Swagger, request collection, state diagram, data model, test
  scenarios**. Free external server recommended. "Show how the news feed changes for the client and what
  the news contains" — the only mention of a feed in the case. Interactive prototype, not static screens.
- p.9 criteria: integrity; readiness for verification; UX for client and bank; module consistency;
  enterprise orientation; development potential.
- p.10–11 constraints: client path + credit logic + enterprise practices; no paid dependencies;
  synthetic data; mocks instead of bank systems; the scenario stays in the product (no email, SMS,
  calls, messengers); simplifications allowed if described; web only; open-weight LLMs only.
- p.13–15 minimal path: need → product → application → check and normalise → clarify → enrichment
  (credit bureau, ЕГРЮЛ/ЕГРИП, ФНС «Прозрачный бизнес») → scoring ≠ decision → non-binary outcome
  (other amount, term or product; request for information) → documents and funding (may be simulated);
  intermediate stages depend on the product and the client.

## Process as implemented at `8f358fa`

Statuses (14, `backend/app/domain/statuses.py:11-25`): draft, submitted, validation, needs_info,
enrichment, scoring, manual_review, approved, counter_offer, rejected, signing, issued, cancelled,
expired. Actors: client, analyst, system. Transitions `statuses.py:133-158`, plus client cancel from every
non-terminal status (`:161-167`).

| Step | Who | Code | Data written |
|---|---|---|---|
| Draft create/edit | client (owner or accountant) | `services/applications.py:189-235` | `applications.form` JSON, `created`/`updated` events |
| Submit | client | `services/applications.py:238-250` | status submitted, `submit_key`, job `pipeline.start` in the same transaction |
| Validation | system | `pipeline/steps.py:79-91` | completeness → `client_tasks` (revenue, collateral) → needs_info, else enrichment |
| Enrichment | system | `pipeline/steps.py:99-128` | `check_results` per source, retry events; retries exhausted → manual_review (`:131-136`) |
| Scoring | system | `pipeline/steps.py:185-217`, `scoring/rules.py` | `scoring_results` (score, grade, factors, feature snapshot) |
| Decision | system | `scoring/decision.py:116-174` | `applications.decision` JSON (outcome, reasons, tips, stop factors, recommendation, grade, score), `offers` |
| Answer to bank request | client | `services/tasks.py:75-124` | form field or document; last task closed → validation + job |
| Manual decision | analyst | **missing** (B2) | — |
| Accept / sign / issue | client / system | **missing** (B1) | `offers.status`, `accepted_at` unused |
| Expiry | system | **missing** (B7) | `offers.valid_until` written, never read |

Live status: SSE `api/applications.py:184-217` polls the DB every second; the frontend (`api/stream.ts`)
reads it with fetch, reconnects and falls back to polling. The stream stays open for every non-terminal
status, so a client waiting in manual_review will see the analyst's decision live once it exists.

## Findings

Numbering is shared with the decision memo. B-numbers come from the earlier external code review;
N-numbers are new.

### B — earlier review, re-checked

| ID | Verdict | Evidence |
|---|---|---|
| B1 no accept/sign/issue | confirmed at runtime | no routes; `allowed_actions` emits them (`services/applications.py:61-64`); `POST …/offer/accept` → 404 |
| B2 no analyst decision | confirmed at runtime | `decide` emitted (`services/applications.py:67-68`); `POST …/decision` → 404; analyst opens the client page read-only (`ApplicationPage.tsx:196`) |
| B3 SSE holds a DB session | confirmed at runtime | `application_stream` depends on `get_current_user` → `get_db` (`api/applications.py:189-190`, `api/deps.py:14-16`); FastAPI 0.159.1 tears yield dependencies down after the response ends; 18 open streams → plain GET took 30.4 s, 14× `QueuePool limit` |
| B4 Idempotency-Key | confirmed at runtime, worse | global `unique=True` (`models.py:82`, migration `0001:75`) → HTTP 500 on reuse in another application; the frontend also generates a new key per call (`frontend/src/api/hooks.ts:116`), so a double click is not deduplicated by key |
| B5 non-active status worded as liquidation | confirmed, P2 latent | `features.py:73` default `"unknown"`, `decision.py:61-62`; mock generator always returns `active` (`mocks/mockapi/generator.py:65`), so unreachable until G |
| B6 smirnova outcome depends on typed revenue | confirmed at runtime | 1 M / 400 k + statement → counter 450 k @ 24.9 % (grade B); 500 k / 600 k → approved |
| B7 no offer expiry | confirmed | `valid_until` set at `steps.py:153`, never read |
| B8 statement not parsed | confirmed, worse | declared revenue trusted once any `bank_statement` file is attached, even to a draft (`steps.py:188-190`, `features.py:60-61`, `tasks.py:103`) |
| B9 bank cannot see "why" | confirmed | `DecisionOut` exposes outcome/reasons/tips only (`schemas.py:251-256`); score, grade, stop factors, recommendation stored but not served |
| B10 demo mode / shared password | confirmed | `api/auth.py` demo-login; default `SECRET_KEY` in compose lets anyone mint an analyst token |
| B11 token in localStorage | confirmed | `frontend/src/api/client.ts:8-22` |
| B12 `/admin/faults` open | confirmed | `mocks/mockapi/main.py:64`, port 8001 published on all interfaces |
| B13 blocking retries in worker | confirmed | `integrations.py:57` `time.sleep` inside the step |
| B14 token without `sub` → 500 | confirmed at runtime | `deps.py:24` |
| B15 sync INN lookup retries | confirmed | `api/companies.py:17-26` |
| B16 no CI | confirmed | no `.github/` |

### N — new

| ID | Finding | Evidence | Severity |
|---|---|---|---|
| N1 | Any client without a company can link an existing company by INN and see/cancel its applications; the `new@` demo is one-shot | `api/companies.py:56-72`; at runtime `new@` saw 6 bakery applications | P1 security |
| N2 | Analyst queue never refreshes once nothing is "moving" | `hooks.ts:79` + `refetchOnWindowFocus: false` (`main.tsx:21`) | P1 |
| N3 | Counter-offer only lowers the amount or lengthens the term; no "other product", which p.15 names explicitly | `decision.py:89-113, 164-169` | P1 |
| N4 | Token shared across tabs: logging in as analyst in a second tab logs the client out | `client.ts:8-22` | P1 demo |
| N5 | Worker loop catches only `OperationalError`; stale jobs recovered only at start; exhausted validate/score retries leave the application in scoring instead of sending it to a specialist | `worker.py:36-46`, `runner.py:43-49` | P1 |
| N6 | DSR is measured against revenue, not profit: sklad's 4.5 M / 12 counter-offer means ≈573 k/month debt service against ≈417 k/month profit (coverage 0.73) | `decision.py:15, 86-95` | P1 credit |
| N7 | A current overdue up to 60 days on a strong profile still auto-approves (grade B) | `decision.py:67`, `rules.py:108-112` | P1 credit |
| N8 | Debt load is scored at the requested terms with the base rate; the decision uses the grade rate. Asking for less can raise the grade | `features.py:69,90`, `decision.py:83` | P2 credit |
| N9 | Investment loan limit ignores collateral value (no LTV) | `products.py:108`, `decision.py:84` | P2 credit |
| N10 | Mock generator always yields a healthy company, so any typed INN gets approved | `generator.py` | P2 |
| N11 | Required artifacts missing: API description, request collection, test scenarios, CI, tag, RELEASE.md, news feed; NOTICES says signing "will be simulated" | repo tree, `THIRD_PARTY_NOTICES.md:56` | P0 for submission |
| N12 | Internal research notes were committed to the branch | resolved 22.10: kept outside the repo, branch history rewritten before the first push | done |
| N13 | `add_header` inside `location /assets/` drops server-level security headers for assets | `frontend/nginx.conf` | P2 |
| N14 | Draft request collection calls `/api/products/express/calculate` without query parameters | — | regenerate |

### Runtime checks (22.10, stack without Docker)

Mocks :8001, API :8000 on a throwaway SQLite file, worker. Timings below were taken with
`PIPELINE_STEP_DELAY_S=0.3` and `MOCK_LATENCY_MS=50`; the compose defaults (1.5 s, 400 ms) are slower on
purpose so the stages are visible.

| Check | Result |
|---|---|
| `pytest -q` | 54 passed in 3.0 s |
| `npm ci && npm run build` | OK |
| bakery, express 3 M / 12, revenue 4 M | approved 3 M @ 22.9 % in 6.5 s; actions `accept_offer`, `cancel` |
| buh (accountant), same application | actions `cancel` only |
| sklad, 10 M | counter_offer 4.5 M / 12 @ 22.9 % |
| smirnova 1 M / 400 k + statement | counter_offer 450 k @ 24.9 % (B6) |
| smirnova 500 k / 600 k + statement | approved 500 k @ 22.9 % |
| vector, invest 25 M / 48, collateral 30 M | manual_review; analyst has `decide`; no endpoint |
| start, 2 M | rejected, 3 reasons, 3 tips |
| zakat | rejected, stop factor |
| same Idempotency-Key, other application | HTTP 500 |
| JWT without `sub` | HTTP 500 |
| 18 SSE streams + GET | 200 after 30.4 s |
| new@ links bakery INN | 200, sees 6 bakery applications |

## Decisions

- D1 (22.10) Work on `feat/e2e-completion`; no pushes except this branch for CI; merge to `main` and tags
  only after explicit agreement.
- D2 (22.10) Scope = memo §5 with the changes in memo §9; order fixed; P0 by end of 24.10.
- D3 (22.10) No local Docker: GitHub Actions runs `docker compose build`, `up -d --wait` and a smoke script.
- D4 (22.10) The news feed uses the team's synthetic `news.json`, tagged by OKVED section, product and
  status, labelled as simulated.

## Verification commands

```bash
# backend tests (Git Bash on Windows; .venv/bin on Linux)
cd backend && .venv/Scripts/python -m pytest -q
# frontend build
cd frontend && npm ci && npm run build
```

## Next step

P0.3: stream-scoped auth dependency (B3), drop the global unique on `submit_key` and keep one key per draft
on the frontend (B4), reject tokens without `sub` (B14), ownership rule for `/companies/link` (N1).
