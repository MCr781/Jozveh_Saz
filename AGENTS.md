# Jezveh_Saz (جزوه‌ساز) - Master Architecture & Autonomous Executor Rules

## 1. Role of the AI Agent (Autonomous Executor)
- You are the primary code executor. Never leave half-finished files or ask the user to manually edit code.
- **Self-Verification Loop:** After creating or updating any backend (`server/`, `factory/`) or frontend (`public/`) files, you MUST run verification checks in the terminal (e.g., `node --check server/server.js`, `node --check factory/generate.js`, `node --test reference/reference.test.js server/test/*.test.js`) to guarantee zero syntax or runtime errors before finishing your turn.
- **Zero-Dependency Backend Rule:** Use native Node.js 24 ESM modules (`node:http`, `node:fs`, `node:path`, `node:crypto`, `node:zlib`, `node:sqlite`, and native global `fetch`) for all backend server, Telegram Bot API, and Gemini REST API calls. Do NOT depend on external npm packages unless strictly necessary. If an npm package is ever required, ALWAYS install using `@latest` (never hardcode old version numbers).

## 2. Hard Security & Financial Invariants (Zero Exceptions)
- **No Fail-Open:** Never use default-grant or fallback unlock on money, quota, or authentication paths. On upstream or validation failures, always fail closed (`502 GATEWAY_UNAVAILABLE`, `503 AI_UPSTREAM`, `401 UNAUTHORIZED`, or `pending_manual`).
- **No Client-Trusted Price or Creator:** Always derive price, creator, and course item text exclusively from the server-side catalog or database. Never accept or trust `amount`, `creator_id`, or `originalText` from request bodies or query parameters.
- **Transactional Discipline & No `await` inside `tx()`:** All SQLite database writes must be synchronous inside `tx()`. Never pass `async` functions or `await` promises inside `tx()`. `node:sqlite` transactions are synchronous and will throw or deadlock if async operations run within a transaction.
- **No Silent Catch on Data Paths:** Never swallow errors with empty `catch (_) {}` on write, payment, or auth operations. Log or bubble errors with structured context.
- **No Hardcoded Model IDs:** Never hardcode model IDs (such as `'gemini-2.5-flash'`) directly in API routes. Always load the model through `config.geminiModel` with fallback to `process.env.GEMINI_MODEL`.

## 3. Frontend & Zero-CDN Policy (`public/`)
- **Frontend Stack:** Pure HTML5, Vanilla JavaScript (ES6+), and local CSS.
- **Zero External CDN in HTML:** NEVER use external `<link>` or `<script>` tags. Always load local assets:
  - Font: `./fonts/Vazirmatn.woff2`
  - Math Engine: `./css/katex.min.css` and `./js/katex.min.js`
- **RTL & Math Isolation:** Strictly Persian RTL (`dir="rtl" lang="fa"`). Wrap all KaTeX output in containers with `direction: ltr !important; unicode-bidi: isolate !important; display: inline-block;`.
- **XSS Immunity:** Always use `textContent` when rendering user messages in chat bubbles. Tokenize and escape all HTML in `renderTextWithMath` before injecting rendered KaTeX HTML.
- Delete `public/editor.html` as the pipeline is 100% automated.

## 4. Telegram Mini App (TMA) & Anti-Piracy Architecture
- Initialize `window.Telegram?.WebApp` safely with desktop browser fallback (`Go Live` / `localhost:3000`).
- Server-Side Paywall Stripping: Direct browser access to `/data/*.json` MUST return `404 Not Found`. Serve course data via `GET /api/course?id=...`. If the user has not purchased the course, strip/redact locked flashcard answers (`back`) and locked exam explanations (`explanation`) on the server before sending the JSON.
- Validate `Telegram.WebApp.initData` via `HMAC-SHA256` with the `"WebAppData"` seed using `crypto.timingSafeEqual`, code-unit sorting, keeping `signature` in the data-check string, and enforcing `auth_date` TTL (86400s default for study routes, 3600s for creator/payout routes).

## 5. Self-Healing AI Factory & Anti-Spam Error Reporting
- **Auto-Compiler Loop (`factory/generate.js`):** Load local `../public/js/katex.min.js` to validate every generated LaTeX formula with `katex.renderToString(expr, { throwOnError: true })`. Automatically fix broken formulas via Gemini REST API before saving.
- **Continuous Memory (`factory/learned_rules.json` & SQLite `learned_rules`):** Inject learned rules into the generation prompt so OCR/formula mistakes are never repeated.
- **Anti-Spam & AI Judge (`POST /api/report-issue`):**
  - Enforce rate limits: max 3 reports/day per user, 120s cooldown between reports, shadow-ban after 3 rejected strikes, and lock items that already have a pending report.
  - Derive `originalText` on the server from the course catalog by `itemId` (ignoring client-submitted text).
  - Validate student error claims with an AI Fact-Checker pass before queuing for 1-click admin approval in Telegram (`approve_<id>` / `reject_<id>`). Grant +2 bonus AI chat quota ONLY after approval.
- **Encrypted Snapshots:** Nightly automated backups with AES-256-GCM + gzip and integrity verification via `PRAGMA integrity_check`.
