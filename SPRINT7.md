# Jozveh Saz (جزوه‌ساز) — Sprint 7 & Milestones 7–10

> **Instructions for the AI Executor (Cline / Antigravity / OpenCode):**
> 1. Read `AGENTS.md` and `ROADMAP.md` first.
> 2. Implement **only the story you were asked to** (e.g. `S7-3`). Do not touch files that are not listed in the story.
> 3. 100% native Node.js (`http`, `crypto`, `fs`, `path`, `fetch`, `node:sqlite`, `node:test`). No npm runtime dependencies.
> 4. Never add a fail-open fallback, never use a silent `catch (_) {}` on data paths, never put an `await` inside `tx()`.
> 5. After every change run `node --check` on each touched file and `node --test server/test/` (once S7-8 exists). Print the changed file list and the test output before finishing.
> 6. If a requirement is ambiguous, stop and ask. Do not guess on money or auth logic.

**Reference implementations** (tested, provided with this document in `sprint7-reference/`): copy the folder to `reference/` at the repo root before starting.

| File | Use |
|---|---|
| `reference/tg_auth.js` | Starting point for `server/auth.js` (initData verification) |
| `reference/db.js` | Starting point for `server/db.js` (pragmas, `tx()`, schema, idempotent `recordSale`, `requestPayout`) |
| `reference/sheba.js` | Copy to `server/sheba.js` (mod-97 check) |
| `reference/reference.test.js` | 4 passing tests; move into `server/test/` |
| `reference/p0_regression.mjs` | Black-box exploit regression; acceptance test for **S7-0** (`node reference/p0_regression.mjs .`). Currently 0/8 secure. |

---

## 0. Why this sprint exists (findings from the code review)

Reproduced locally against the repo snapshot of 2026-10-28:

| # | Severity | Finding | Where |
|---|---|---|---|
| P0-1 | Critical | `GET /api/payment/verify` with no `Authority` unlocks the course for user `guest` (shared by every unauthenticated visitor) and credits the creator 70% **per call** | `server/server.js` verify handler |
| P0-2 | Critical | Price comes from the client (`amount`); any gateway error/rejection falls through to `recordCourseSale` (free unlock + creator credit) | `/api/payment/create` |
| P0-3 | Critical | `creatorId` is taken from the request body: any user can request another creator's payout to their own Sheba; no balance reservation (repeat requests each claim the full balance); Sheba is regex-only; `/api/creator-stats?creator_id=` leaks balances and buyer IDs | `/api/creator-payout`, `/api/creator-stats`, bot `/payout` |
| P0-4 | Critical | Auth fails open: missing `BOT_TOKEN` ⇒ shared demo user; invalid initData ⇒ `guest`; no `auth_date` expiry; non-constant-time compare | `verifyTelegramInitData` |
| P0-5 | Verify | `public/index.html` does not load `telegram-web-app.js`; without it `Telegram.WebApp.initData` is empty | `public/index.html` |
| P0-6 | Verify | `gemini-2.5-flash` is hardcoded and may be retired (check with `curl`); on a 404 the tutor silently returns canned text and still burns quota; AI judge fails open | `server.js`, `factory/generate.js` |
| P0-7 | Verify | State lives in `state_db.json` on Render's ephemeral filesystem unless a persistent disk is attached; corrupt JSON is swallowed and then overwritten | `server.js` DB load/save |
| P1 | High | Check→`await`→act races (double credit), non-idempotent bot callbacks, in-memory `update_id`, serial update handling blocks the bot during PDF generation, whole-DB sync rewrite on every mutation, per-request parsing of all course files, truncating (not rejecting) body readers, `Date.now()` IDs, circular import `server.js` ↔ `bot.js` | multiple |
| P2 | Medium | No HTML escaping in `renderTextWithMath` / `innerHTML +=`; invalid `X-Frame-Options: ALLOWALL`, no CSP; paid JSON in `public/` and in git; Gemini key in URL; report flow trusts client `originalText`; unescaped HTML in admin messages; tests only cover `BOT_TOKEN=''` + `MERCHANT_ID='demo'` | multiple |

---

## 1. Human-only prerequisites (do these before any agent starts)

1. **SDK check:** open the Mini App on a real phone (or Telegram Desktop with webview inspection) and evaluate `Telegram.WebApp.initData.length`. Record the result.
2. **Model check:** `curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash?key=$GEMINI_API_KEY_1"`. A 404 means the model is retired; pick a current Flash-class model from `models.list` for `GEMINI_MODEL`.
3. **Render:** confirm the instance type. SQLite requires a paid instance with a persistent disk (note: a disk disables zero-downtime deploys and horizontal scaling). If a live `state_db.json` exists, download a backup first.
4. **Repo visibility:** if the GitHub repo is public, make it private (paid course JSON is in git).
5. **Node pin:** set `engines.node` / `NODE_VERSION` (the zip contained no `package.json`; make sure Render has one or the env var).
6. **Schedule:** plan the database cutover away from peak exam nights.

### Environment contract (new/changed)

| Variable | Required in prod | Notes |
|---|---|---|
| `NODE_ENV` | yes | `production` enables fail-fast checks |
| `BOT_TOKEN` | yes | boot refuses to start without it in production |
| `ADMIN_CHAT_ID` | yes | |
| `WEBAPP_URL` | yes | https, no trailing slash |
| `STATE_DB_PATH` | yes | absolute path on the mounted disk, e.g. `/var/data/jozveh.db` |
| `INITDATA_MAX_AGE_SEC` | no (default `86400`) | study/read routes |
| `INITDATA_MONEY_MAX_AGE_SEC` | no (default `3600`) | creator-stats / payout routes |
| `GEMINI_API_KEY_1..3` | yes | sent via `x-goog-api-key` header, never in the URL |
| `GEMINI_MODEL` | yes | no hardcoded model IDs anywhere |
| `MERCHANT_ID` | yes | `demo` is rejected in production |
| `PAYMENT_CALLBACK_BASE` | yes | |
| `ZARINPAL_BASE` | tests only | points the code at `server/test/fake_gateway.js` |
| `ALLOW_DEMO_PAYMENTS` | **forbidden** in prod | dev only |
| `BACKUP_KEY` | yes | 32-byte hex, AES-256-GCM for DB backups |

---

## 2. Sprint 7 backlog (Milestone 7: Enterprise Telegram Auth & SQLite Persistence)

Recommended order: `S7-0` ships alone and first; then `S7-1` → `S7-9` in numeric order.

### S7-0 — P0 hotfix (1–2 days, ships alone, still JSON-era)

**Files:** `server/server.js`, `server/bot.js`, new `server/sheba.js` (copy `reference/sheba.js`).

1. **`GET /api/payment/verify`**
   - Reject (400) unless `Authority` is present, exists in `DB.pendingPayments`, and `Status` is `OK`.
   - Before the first `await`, set `pending.state = 'verifying'` synchronously; if it is already `verifying` or `done`, reject. This closes the concurrent double-credit race.
   - Take `userId`, `courseId`, `amount` **only** from the pending record. Ignore the `courseId` query param and never fall back to `guest`.
   - The gateway-verified amount must equal the stored amount. Accept code 100 once; treat 101 (already verified) as "already processed", never as a second credit.
   - Remove the `else { ok = true }` branch. Demo verification is allowed only when `ALLOW_DEMO_PAYMENTS=1` and `NODE_ENV !== 'production'`.
2. **`POST /api/payment/create`**
   - Ignore `amount` in the body. Price = catalog `price_toman`. Unknown course ⇒ 404.
   - If the gateway returns anything other than code 100 or the request fails: respond `502 { ok:false, code:'GATEWAY_UNAVAILABLE' }`. **Never** call `recordCourseSale` here.
   - Demo success only under `ALLOW_DEMO_PAYMENTS=1` outside production.
3. **`GET /api/creator-stats`:** require valid auth; ignore `creator_id`; always return the caller's own stats; remove `buyerUserId` from `history` in the response.
4. **Payouts** (`POST /api/creator-payout` and bot `/payout`)
   - `creatorId` = authenticated user ID only; ignore any body value.
   - Validate Sheba with `isValidSheba` (mod-97), not just the regex.
   - Reserve funds at request time: `balanceToman -= amount; heldToman += amount`. Reject if a pending payout already exists for that creator. Reject ⇒ release the hold; approve ⇒ `heldToman -= amount`.
   - Payout IDs must be collision-safe (`crypto.randomUUID()`), not `Date.now()`.
5. **`verifyTelegramInitData`**
   - In production, a missing `BOT_TOKEN` is a boot error, not a demo user. No demo branch in production.
   - Check `auth_date`: reject if older than the route's TTL (`INITDATA_MAX_AGE_SEC` for study routes, `INITDATA_MONEY_MAX_AGE_SEC` for creator-stats/payout) or more than 60 s in the future.
   - Compare hashes with `crypto.timingSafeEqual`; sort keys by code unit, not `localeCompare`. Keep the `signature` field in the data-check string (only `hash` is removed).
   - Invalid auth on `/api/course` ⇒ 401 (the catalog `/api/courses` may stay anonymous but must not return purchase flags).
6. **Bot receipts**
   - Replace `unlock_|<chatId>|sample_course` with `unlock|<receiptId>`. Store `{receiptId, userId, courseId, status:'pending'}` server-side when the receipt photo arrives (the student must pick the course first, e.g. `/pay <slug>`).
   - The handler must check-and-set `status: pending → approved` synchronously before any `await`, so a double click or a replayed update credits once.

**Acceptance:** `node reference/p0_regression.mjs .` prints `8/8 secure`; `node --check server/server.js server/bot.js`.

---

### S7-1 — Config and health

**Files:** new `server/config.js`; `server/env.js` unchanged.
- Parse and validate all env vars from the contract above in one place. Export a frozen config object. Replace scattered `process.env` reads over time (new code must use it).
- In production, exit non-zero at boot if: `BOT_TOKEN` missing; `ALLOW_DEMO_PAYMENTS` set; `MERCHANT_ID` is empty/`demo`/`YOUR_*`; `STATE_DB_PATH` not absolute; `GEMINI_MODEL` empty.
- Add `GET /api/health` → `{ ok, db:'up'|'down', modelProbe:'ok'|'fail', version }`. The model probe calls `models.get` once at boot and logs loudly on failure (do not crash the server for it).
- **Verify:** booting with each bad env exits non-zero (add as tests).

### S7-2 — Auth module

**Files:** new `server/auth.js` (start from `reference/tg_auth.js`), `server/server.js`.
- `requireUser(req, { money = false })` → verified user or throws `HttpError(401, code)`. `optionalUser(req)` for the anonymous catalog only. Error codes: `missing`, `bad_signature`, `expired`, `from_future`, `bad_user`, `server_misconfigured`.
- Define an explicit route table marking each route `public` or `protected`. Delete every `'guest'` and demo-user path.
- `/api/payment/verify` is a browser redirect with no initData; it is authorized only by the pending record + gateway verification.
- New `scripts/dev_initdata.js` mints correctly signed initData with a dev bot token so local development exercises the real auth path.
- **Verify:** `reference.test.js` auth cases pass inside the repo test suite; no `guest` string remains in `server/`.

### S7-3 — SQLite core

**Files:** new `server/db.js` (start from `reference/db.js`), `server/schema.js`, `server/repo/{users,commerce,ai,progress,reports}.js`, new `server/telegram.js`; edit `server/bot.js`, `server/server.js`.
- Pragmas: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`. Migrations keyed by `PRAGMA user_version`.
- `tx(db, fn)` is synchronous: `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`. No `await` inside.
- Tables (all `STRICT`, integer toman, `CHECK` and `UNIQUE` constraints):
  - `users`, `sales` (`payment_ref UNIQUE`), `purchases` (`PRIMARY KEY(buyer_id, course_id)`), `creator_ledger` (append-only, `UNIQUE(kind, ref)`), `payment_intents`, `payouts`, `receipts`, `ai_usage` (per user+course), `progress`, `reports`, `learned_rules`, `meta`.
- Money rules: creator share `floor(price * 70 / 100)`, platform share = `price - creator`; balance = `SUM(creator_ledger.amount_toman)`.
- No SQL outside `server/repo/`.
- Move `tgApi` / `notifyTelegram` into `server/telegram.js` with `AbortSignal.timeout` (30 s; 40 s for `getUpdates`). `bot.js` and `server.js` may import repos and `telegram.js`, **never each other**.
- Wrap `node:sqlite` only inside `server/db.js` so the driver can be swapped (it is a release-candidate module in recent Node 24.x; pin the Node version).
- **Verify:** `node --check` on all new files; `reference.test.js` DB tests pass against the real `server/db.js`.

### S7-4 — JSON → SQLite migration

**Files:** new `server/migrate_json.js` with `--dry-run` and `--apply`.
- Corrupt or unparsable JSON ⇒ abort with exit code 2. Never continue with an empty DB.
- Refuse to run if the target DB already contains sales, unless `--force`.
- Recompute creator balances from `creatorEarnings[*].history` (sales) and payouts; do **not** trust `balanceToman`.
- Quarantine into a `legacy_quarantine` table (and print a report) everything tied to `guest`, `demo_user_*` or `creator_demo*`. Write `migration_report.json` listing sales with no verified gateway reference, for admin review **before any payout is approved**.
- Pending payouts become ledger holds. Archive the input as `state_db.json.migrated-<timestamp>`.
- **Verify:** rows in = rows out + quarantined; running `--apply` twice is a no-op; a corrupt-JSON fixture exits 2.

### S7-5 — Commerce on SQLite

**Files:** `server/server.js`, `server/bot.js`, `server/repo/commerce.js`, new `server/test/fake_gateway.js`.
- `recordCourseSale` → `recordSale` (see `reference/db.js`), idempotent on `payment_ref` = Zarinpal authority or `receipt:<id>`.
- Payments use `payment_intents` with states `created → redirected → verified → settled | failed | expired`; amount and course are bound server-side at creation; `authority` is unique.
- Payout routes and bot approve/reject use `requestPayout` and ledger entries (`payout_hold`, `payout_paid`, `payout_release`) inside a single `tx()`.
- `/api/creator-stats` and `/income` are computed from the ledger.
- `fake_gateway.js`: a local `http.createServer` stub used via `ZARINPAL_BASE` (codes 100 / 101 / failure modes selectable per test).
- **Verify:** 50 concurrent `/api/payment/verify` calls for one authority produce exactly 1 sale and 1 ledger credit; replaying an admin approve callback 20× changes nothing after the first.

### S7-6 — AI tutor, report flow, content location

**Files:** `server/server.js`, `factory/generate.js`, `factory/cli.js`, `server/bot.js`.
- **Gemini:** model from `GEMINI_MODEL`; key via `x-goog-api-key` header; boot probe (S7-1). Update `factory/generate.js` the same way.
- **Tutor:** on upstream failure return `503 { ok:false, code:'AI_UPSTREAM' }` and **do not consume quota**. Consume quota only after a successful answer, in the same transaction as the `ai_usage` row (per user + course). Remove the canned "[پاسخ سرور لوکال]" fallback outside demo mode.
- **Report flow:** the AI judge fails **closed** (`pending_manual`, never auto-valid). The server derives `originalText` from the catalog by `itemId`; ignore the client value. HTML-escape every user/AI string in admin messages. `learnedRule` is length- and charset-limited, shown in full to the admin, and stored in the `learned_rules` table (not appended to a repo file).
- **Content:** move `public/data/*.json` → `server/content/`. Build an in-memory index (`id`, `slug`, `price`, `creator`) at boot, invalidated by file mtime, so `/api/courses` does no per-request parsing. `/data/*` returns 404. Update paths in `factory/cli.js`, `factory/generate.js` and the bot's PDF handler.
- **Verify:** with a bad model name the tutor returns 503 and the user's quota is unchanged; `curl /data/eng_math_01.json` → 404.

### S7-7 — Frontend hardening

**Files:** `public/index.html`, `public/js/app.js`, `public/js/telegram.js`, new `public/js/telegram-web-app.js`, `server/server.js` (headers + body reader).
- Vendor a pinned copy of Telegram's `telegram-web-app.js` locally (check its license header) and load it before `telegram.js`, keeping the zero-CDN policy.
- One `api()` wrapper: adds the `X-Telegram-Init-Data` header, 15 s timeout via `AbortController`, maps 401 to an "open this from Telegram" screen, and surfaces the server's error `code`.
- `escapeHtml()`; rewrite `renderTextWithMath` so non-math text is escaped and only KaTeX output is injected; build chat bubbles with `textContent`; remove the dead `simulate_buy` request.
- Server: send `Content-Security-Policy: default-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org` (adjust for the Telegram web origins you need) and drop `X-Frame-Options: ALLOWALL`.
- Server: replace the truncating body handlers with `readBody(req, maxBytes)` that returns 413 and destroys the socket, plus a read timeout.
- **Verify:** a chat message containing `<img src=x onerror=alert(1)>` renders as text; on a real phone `initData.length > 0`.

### S7-8 — Test suite

**Files:** replace `server/self_test.js` with `server/test/*.test.js` (`node:test`).
- Tests always use signed initData (via `scripts/dev_initdata.js`) and the fake gateway. No `BOT_TOKEN=''` / `MERCHANT_ID='demo'` mode remains.
- Include: the 8 P0 regressions (ported from `p0_regression.mjs` to the repo layer), `reference.test.js`, the corrupt-JSON migration case, and a child-process test that kills the process after `BEGIN` and asserts the DB is unchanged on reopen.
- Add a CI workflow running `node --check` on all `.js` files and `node --test server/test/`.

### S7-9 — Ops

**Files:** `ecosystem.config.cjs` (stays single fork), new `scripts/backup.js`, `scripts/restore.js`, `AGENTS.md`, `ROADMAP.md`.
- Render: paid instance + disk, `STATE_DB_PATH` on the mount, health check path `/api/health`, pinned Node version.
- Nightly backup: `sqlite.backup()` → gzip → AES-256-GCM (`BACKUP_KEY`) → `sendDocument` to the admin chat (verify Telegram's file-size limit; the DB is small). `restore.js` + a documented restore drill that must be executed once before sign-off.
- Update `AGENTS.md` with the new hard rules: no fail-open, no client-trusted price/creator, no `await` inside `tx()`, no silent catch on data paths, no model IDs in code. Replace the old milestone list in `ROADMAP.md` with Milestones 7–10 from this document.

---

## 3. Sprint 7 Definition of Done

- [ ] `node reference/p0_regression.mjs .` → `8/8 secure` (after S7-0), and the same checks pass as repo tests (after S7-8)
- [ ] `node --check` passes on every `.js` file; `node --test server/test/` is green
- [ ] No occurrence of `saveDB`, `'guest'`, or demo-user logic in `server/`
- [ ] Migration dry-run succeeds on a copy of production data; `migration_report.json` reviewed by the admin
- [ ] Phone smoke test: `initData.length > 0`, catalog loads, purchase via fake/real gateway unlocks only the purchased course
- [ ] Restore drill executed from a real backup file
- [ ] Rollback plan: archived `state_db.json.migrated-*` kept for 30 days; previous deploy can be restored from Render

---

## 4. Milestone 8 — High-Throughput Webhook Engine & Transactional Ledger

- **Webhook:** `setWebhook` with an unguessable path and `secret_token`; verify `X-Telegram-Bot-Api-Secret-Token` with `timingSafeEqual`. Insert the update into `tg_inbox(update_id PRIMARY KEY)` and answer `200` immediately; a worker drains the inbox with a concurrency cap and per-chat ordering. Handlers are idempotent on `update_id` and `callback_query.id`. Polling remains a dev-only mode (`deleteWebhook`); never run both. Treat an always-on instance as a prerequisite (a cold start of up to a minute delays updates).
- **Payments:** the `payment_intents` state machine from S7-5, plus a reconciliation cron that asks the gateway about unresolved intents (the browser return may never happen). Refunds and reversals are ledger entries.
- **Payouts:** states `requested(hold) → approved → paid | rejected(release)`; minimum payout; Sheba mod-97 plus bank code shown to the admin (verify the bank-code table before using it); cooling-off period and Telegram notice when a creator changes Sheba. A checksum proves validity, not ownership: ownership needs a manual name check or a licensed inquiry API behind an interface. Check whether gateway-side split settlement reduces your custodial exposure, and confirm the legal requirements.
- **Acceptance:** replaying one update 100× has one effect; 50 concurrent verifies produce one credit; killing the worker mid-update still yields exactly-once effects; the daily ledger-vs-gateway diff is 0.

## 5. Milestone 9 — Factory 2.0 (Multimodal OCR for Handwritten Notes)

- **Model:** from `GEMINI_MODEL` with a boot probe and a per-job cost cap. Do not target the 1.5 family.
- **Pipeline** (`factory_jobs`, `factory_pages`): intake → quality gate → transcribe → structure → validate → human review → publish.
  - *Client capture:* canvas downscale to roughly 1600–2000 px long edge at JPEG ≈ 0.85 (tune on the golden set; the tutor path's 1024 px / 0.75 is too lossy for handwriting); blur (Laplacian variance) and exposure checks with "retake page N" prompts; batch 4–6 pages per Gemini request (verify the inline request size limit).
  - *Pass 1:* per-page transcription with per-line confidence and `[illegible]` markers, never guesses.
  - *Pass 2:* structuring with `responseSchema` into formulas, flashcards, MCQs and the grading schema.
  - *Pass 3:* the existing KaTeX compile audit and self-heal, capped at 2 retries.
  - *Pass 4:* numbers and units must appear in the source page.
  - *Human review is mandatory:* the creator sees the page crop beside each extracted formula, low-confidence items highlighted; nothing publishes unreviewed.
- **Safety:** escape all generated strings; client-side dHash duplicate-source detection; takedown flow for copied material.
- **Acceptance:** golden set of ≥ 30 real blurry handwritten pages with baseline exact-match and edit-rate; 100% KaTeX compile after heal or drop; failures visible as job states, never silent.

## 6. Milestone 10 — Viral Campus Distribution & Growth Loops

- **Referrals:** `https://t.me/<bot>/<app>?startapp=ref_<code>` arrives as `start_param` inside signed initData (tamper-proof); also handle `/start ref_…` in the bot. Reward only on the referee's first **settled** purchase, in AI quota or discount credits (not cash), with `UNIQUE(referee_id)`, daily caps and ledger kind `referral_reward`.
- **Departments:** `universities`, `departments`, `terms` tables (admin-curated, no free text); 2-tap onboarding; catalog ranked by department and term; store minimal personal data.
- **Streaks and badges:** derived from server-side Leitner events (never client claims); exam-date countdown; exam-eve mode builds a time-boxed plan from weak cards and pinned formulas.
- **Channel automation:** `scheduled_posts` table and worker; each post is a teaser plus a `startapp` deep link to the exact card. Token-bucket sender (Telegram's broadcast limits are roughly 30 msg/s overall and 1 msg/s per chat; verify), `429 retry_after` handling, mark 403 as blocked.
- **Acceptance:** five burner accounts cannot farm rewards; a 10k broadcast completes without 429 storms; a deep link opens the exact card; dashboards for K-factor, D1/D7 and exam-eve activation per department.
