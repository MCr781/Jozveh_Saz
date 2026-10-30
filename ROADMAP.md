# Jezveh_Saz (جزوه‌ساز) - Autonomous Production Roadmap (Milestones 7 to 10)

> **Instructions for AI Executor (`Antigravity` / `OpenCode`):**
> Always read `@AGENTS.md` first. Implement all requirements across the codebase using 100% native Node.js 24 ESM (`node:http`, `node:fs`, `node:path`, `node:crypto`, `node:zlib`, `node:sqlite`, and global `fetch`) and Vanilla JS/CSS. Run mandatory `node --check` and `node server/self_test.js` before finishing.

---

## Milestone 7: Production Core, SQLite Migration & Financial Hardening (Sprint 7)
- **Zero-Dependency Native Architecture:** 100% native Node.js 24 ESM without external npm dependencies (`node:sqlite` in WAL mode, `node:crypto`, `node:zlib`).
- **Fail-Closed Financial & Security Engine:**
  - `GET /api/payment/verify` requires valid Authority in `DB.pendingPayments`, state set to `verifying` before any async call to close concurrent double-credits, and amount strictly matching catalog.
  - `POST /api/payment/create` derives price exclusively from catalog; fails closed (`502 GATEWAY_UNAVAILABLE`) on gateway outage.
  - Payout flow validates Sheba via mod-97 (`isValidSheba`), reserves funds atomically (`balanceToman -= amount; heldToman += amount`), and generates collision-safe UUIDs.
  - Telegram `initData` validated via HMAC-SHA256 with `timingSafeEqual`, code-unit sorting, and TTL enforcement (3600s money routes, 86400s study routes).
- **Resilient AI Tutor & Error Judge:**
  - Reads model strictly from `config.geminiModel` with `x-goog-api-key` header.
  - Upstream 503 errors never burn user quota; quota is deducted atomically in `ai_usage` ONLY upon successful completion.
  - AI fact-checker fails closed (`pending_manual`) on upstream failure. Server resolves `originalText` from catalog by `itemId`.
- **Content Protection & XSS Hardening:**
  - Course JSON files stored securely in `server/content/`; `/data/*` returns `404 Not Found`.
  - Unified `api()` wrapper with 15s timeout and automatic Telegram initData injection.
  - Strict Content-Security-Policy with `frame-ancestors https://web.telegram.org https://*.telegram.org;`.
  - Chat bubbles rendered with `textContent` (XSS-immune); math text rendered via tokenized KaTeX.
- **Ops & Disaster Recovery:**
  - Automated encrypted backups (`scripts/backup.js`) with `VACUUM INTO` -> gzip -> AES-256-GCM (`BACKUP_KEY`) with optional Telegram delivery.
  - Database restoration tool (`scripts/restore.js`) with `PRAGMA integrity_check` validation.
  - Automated CI test suite running 30 unit/integration tests and 8/8 P0 security checks.

---

## Milestone 8: High-Throughput Webhook Engine & Transactional Ledger
- **Webhook Engine:**
  - `setWebhook` with an unguessable path and `secret_token`; verify `X-Telegram-Bot-Api-Secret-Token` with `timingSafeEqual`.
  - Insert incoming updates into `tg_inbox(update_id PRIMARY KEY)` and return `200 OK` immediately.
  - Background worker drains the inbox with a concurrency cap and per-chat ordering.
  - Handlers are strictly idempotent on `update_id` and `callback_query.id`.
  - Polling remains a dev-only mode (`deleteWebhook`); never run both in production.
- **Transactional Ledger & Reconciliation:**
  - Robust `payment_intents` state machine with a reconciliation cron querying the gateway for unresolved intents.
  - Financial refunds and reversals tracked as append-only ledger entries.
- **Payout Settlement Automation:**
  - Payout lifecycle states: `requested (hold) -> approved -> paid | rejected (release)`.
  - Minimum payout threshold and bank code resolution from Sheba mod-97 shown to admin.
  - Cooling-off period and Telegram notification when a creator updates their Sheba account.
- **Acceptance Criteria:**
  - Replaying one update 100x produces exactly one side-effect.
  - 50 concurrent verify requests produce exactly one credit.
  - Worker kill mid-update guarantees exactly-once processing.
  - Daily ledger-vs-gateway reconciliation diff is 0.

---

## Milestone 9: Factory 2.0 (Multimodal OCR for Handwritten Notes)
- **Model & Intake:**
  - Model loaded dynamically from `GEMINI_MODEL` with boot probe and per-job cost cap.
  - Pipeline architecture (`factory_jobs`, `factory_pages`): `intake -> quality gate -> transcribe -> structure -> validate -> human review -> publish`.
- **Client Capture & Quality Gate:**
  - Canvas downscale to ~1600-2000px on long edge at JPEG ~0.85.
  - Blur detection (Laplacian variance) and exposure checks with "retake page N" guidance.
  - Batch 4-6 pages per Gemini REST request within payload size limits.
- **Multi-Pass Processing:**
  - *Pass 1:* Per-page transcription with per-line confidence scores and `[illegible]` markers (never hallucinations).
  - *Pass 2:* Semantic structuring with `responseSchema` into formulas, flashcards, MCQs, and cheat sheets.
  - *Pass 3:* Automated KaTeX compile audit loop with self-healing, capped at 2 retries.
  - *Pass 4:* Number and unit cross-verification against source page.
- **Mandatory Human Review Loop:**
  - Creator UI presents side-by-side cropped source page alongside extracted formula, highlighting low-confidence spans.
  - No course package is published without creator approval.
- **Safety & IP Protection:**
  - HTML-escape all generated content.
  - Client-side dHash duplicate-source detection and DMCA takedown flow for copyrighted material.
- **Acceptance Criteria:**
  - Golden evaluation set of ~30 blurry handwritten pages with baseline exact-match and edit-rate benchmarks.
  - 100% KaTeX compile success after self-heal or drop.
  - Job failure states transparently tracked without silent failures.

---

## Milestone 10: Viral Campus Distribution & Growth Loops
- **Cryptographic Referral Engine:**
  - Deep link format: `https://t.me/<bot>/<app>?startapp=ref_<code>` arriving as `start_param` inside signed initData.
  - Also support `/start ref_<code>` in Telegram bot.
  - Rewards unlocked ONLY upon referee's first **settled** purchase (granted as AI quota or discount credits, never cash).
  - Enforce `UNIQUE(referee_id)` constraint, daily caps, and ledger kind `referral_reward`.
- **Campus Department Catalog:**
  - Curated `universities`, `departments`, `terms` tables (no unvalidated free-text).
  - 2-tap onboarding with catalog automatically ranked by student's department and term.
  - Minimal personal data retention.
- **Gamification & Exam-Eve Sprints:**
  - Streaks and achievement badges derived strictly from server-side Leitner review events.
  - Exam countdown timer and dedicated "Exam-Eve Mode" generating a time-boxed sprint from weak cards and key formulas.
- **Channel Broadcast Automation:**
  - `scheduled_posts` table and background dispatcher.
  - Posts include card teasers with direct `startapp` deep link to the exact flashcard.
  - Token-bucket rate limiter adhering to Telegram limits (~30 msg/s overall, 1 msg/s per chat) with `429 retry_after` handling.
- **Acceptance Criteria:**
  - Five burner accounts cannot exploit or farm referral rewards.
  - 10,000-message broadcast completes without Telegram rate-limit storms.
  - Deep links open the exact target card inside the Mini App.
  - Analytics for K-factor, D1/D7 retention, and exam-eve activation per university department.
