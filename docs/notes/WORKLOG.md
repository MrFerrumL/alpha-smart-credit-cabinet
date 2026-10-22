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
| P0.3 | SSE session (B3), idempotency (B4), token `sub` (B14), company ownership on link (N1) | done `496f420` |
| CI | GitHub Actions: pytest on PostgreSQL, frontend build, OpenAPI drift, compose smoke | green since `af7eaff` (run 39850005361) |
| P0.1 | Accept offer → sign with in-app code → issue with repayment schedule (B1) | landed on `main` (`990e5d5`), merged `b327da1`; gap fixes `5228957`; request collection generator `d44b901` |
| P0.2 | Analyst card and decision (B2, B9) | done `5807d2e`, verified in the browser on a local stack |
| P1.8 | Demo resilience: live queue (N2), per-tab token (N4), worker (N5), ports (B12) | done `35dd827` |
| P1.5 | Credit policy: coverage by profit (N6), current overdue (N7), statement-only revenue (B8), one rate in DSR (N8), other-product counter-offer (N3) | done `17165e4` |
| P1.6 | Offer expiry (B7), unanswered bank requests | done `17165e4` |
| B | Accountant prepares → director signs, authority checked against ЕГРЮЛ | done `385d3c6`, reviewed |
| G | Risk profiles in the mock generator (N10) together with B5 | done `9834575` |
| News | Feed from `news.json`, tagged by OKVED, product, status | done `189b0dd` |
| A | Decision rule trace, policy version, replay | done `f81366e` |
| C | Policy impact simulator | done (this commit), reviewed |
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
- D5 (22.10) `main` moved: Step 3 (accept, contract, in-cabinet code signing, issue via a core-banking
  emulator, loans, notifications, offer expiry housekeeping) landed as `990e5d5`. Merged into the branch
  (no rebase). Both sides had a migration numbered 0003; ours became `0004_submit_key_per_application`
  on top of `0003_signing_loans_notifications`. 70 tests pass after the merge; OpenAPI and state diagram
  still match the code.
- D6 (22.10) P0.3 review follow-ups applied: authority is checked before the "already connected" 409 so
  outsiders cannot probe which companies are clients; concurrent first links return 409 instead of 500;
  the surname is mandatory in name matching; 0004 downgrade de-duplicates keys first.
- D7 (22.10) Step 3 spec review → fixes:
  - signing code no longer persisted in plain text (it was in the notification title): returned once as
    `demo_code` and shown in the signing modal, labelled as a simulated e-signature;
  - code HMAC on a derived key and bound to SHA-256 of canonical contract terms + schedule; the hash goes
    to the `offer_accepted` / `contract_signed` events and the contract card;
  - atomic attempt decrement, conditional consume of the code, version bump on sign (cancel race → 409),
    5 codes per hour per application (429);
  - offer validity re-checked on code/confirm; `signing → expired` added; expiry per application with its
    own commit; worker loop survives any exception and recovers stale jobs periodically (part of N5);
  - disbursement never strands: exhausted retries re-enqueue with `DISBURSE_RETRY_S`, UI says the transfer
    is delayed;
  - decline and offer-stage cancel need signing rights; the registry head may join an already connected
    company (otherwise a founder connecting first locks the director out);
  - overdraft contract text describes a limit; the amortising model of the overdraft is documented as a
    simplification.
- D8 (22.10) P0.2 analyst cabinet is ours (agreed with the teammate). Design:
  - the pipeline records why a case went to a person (`review_reason`: manual product, grade C/D, source
    failure); the card is built from the stored feature snapshot and scoring result;
  - stop factors became an explicit checklist (`stop_checks`), shared by the pipeline and the card;
  - analyst outcomes: approve (requested terms), counter-offer, request info (analyst task), reject,
    retry checks (`manual_review → enrichment`, only after a source failure);
  - the analyst is bound by the same policy as the pipeline: no override of stop factors or grade E,
    rate ≥ grade rate, DSR ≤ policy, amount ≤ `ANALYST_AUTHORITY_LIMIT` (above → credit committee, 403);
  - mandatory internal justification kept in the event payload and shown to the bank only; deviation
    from the pipeline recommendation flagged; double decisions blocked by the version lock;
  - "take in work" assignment and four-eyes approval left for the roadmap.
- Note: a dev database migrated on the branch between `496f420` and `b327da1` is stamped `0003` with the
  old per-application-key migration and will skip the teammate's `0003`; recreate such local databases.
  Clean clones and CI are unaffected.
- D9 (23.10) Credit policy `policy-1.1`:
  - affordability = DSR ≤ 50 % of revenue AND FNS monthly profit ≥ 1.2 × new payment (skipped when FNS
    has no expenses); one function shared by the pipeline and the analyst;
  - manual triggers before terms: current overdue ≤ 60 days, statement-only revenue, manual product, C/D;
  - other-product counter-offer when the requested product cannot fit its minimum amount;
  - N8 kept as documented: the scorecard's debt-load factor uses the base rate because the grade (and
    hence the grade rate) is not known yet at scoring time; affordability checks use the grade rate;
  - persona outcomes now: sklad counter 4.5 M / 16 mo (shortest passing term); vector recommendation
    19.5 M / 60 mo;
    smirnova after the statement goes to a specialist (the "information request answered" demo path that
    ends automatically is bakery with the revenue field left empty);
  - unanswered bank requests expire after `NEEDS_INFO_TTL_DAYS` (14).
- D10 (23.10) Policy review follow-ups: interest-only products (overdraft) are checked with an annuity
  equivalent so the limit's repayment counts; coverage stays "profit vs new payment" and docs state it is
  not a full DSCR (existing principal is only bounded by DSR) — a full DSCR would make the vector persona
  unfinanceable with the current synthetic data; shortest passing term instead of the maximum; zero or
  negative profit → specific rejection; FNS without expenses → specialist; offers show a product change;
  expired bank requests show as closed. Not done: the analyst cannot counter-offer a different product
  (recommendation stays None when the requested product does not fit) — roadmap.
- D11 (23.10) G: profile by the 9th INN digit (0–4 healthy, 5 thin margin, 6 heavy debt, 7 current
  overdue, 8 tax debt + mass address, 9 inactive: liquidating/reorganizing/bankrupt by the 8th digit).
  B5 fixed: status-specific stop texts, reorganizing → specialist. Open question: linking a generated
  company needs the profile name to match the registry director; the only seeded client without a company
  is `new@` (director of «Новые горизонты»), so jurors cannot yet try a generated INN in the UI. Options:
  let a client without a company state their name at onboarding (identity check stays simulated), or seed
  a few extra demo heads for sample INNs.
- D12 (23.10) News feed: the team's 20 items got real one-line summaries (the originals were placeholders,
  so the demo could not show "what the news contains"), `tags.statuses` on 3 items, and 4 untagged general
  items; ranking: OKVED section +3, IP +3, region +2, product +2, latest application status +6, general
  +0.5; foreign sector, legal form or region excluded. UI refreshes the feed when application statuses
  change.

- D13 (23.10) CI had been red on every push since `86c1418`: pytest on PostgreSQL and the frontend build
  passed, but `docker compose up --wait` rejects a service with a disabled healthcheck (the worker). Fix
  `af7eaff`: the worker touches a heartbeat file each loop; compose checks it is younger than 60 s. From
  now on every push is followed by `gh run watch` and the next item starts only on green. Remaining CI
  warning: actions/checkout@v4, setup-python@v5, setup-node@v4 run on Node 20 (deprecated) — cosmetic.
## Verification commands

```bash
# backend tests (Git Bash on Windows; .venv/bin on Linux)
cd backend && .venv/Scripts/python -m pytest -q
# frontend build
cd frontend && npm ci && npm run build
```

## Next step

Close the gaps the Step 3 review finds; confirm the first CI run; agree who builds the analyst cabinet
(README step 4 = our P0.2) to avoid duplicate work with the teammate.
