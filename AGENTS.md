# Jezveh_Saz (جزوه‌ساز) - Master Architecture & Autonomous Executor Rules

## 1. Role of the AI Agent (Autonomous Executor)
- You are the primary code executor. Never leave half-finished files or ask the user to manually edit code.
- **Self-Verification Loop:** After creating or updating any backend (`server/`, `factory/`) or frontend (`public/`) files, you MUST run verification checks in the terminal (e.g., `node --check server/server.js`, `node --check factory/generate.js`) to guarantee zero syntax or runtime errors before finishing your turn.
- **Zero-Dependency Backend Rule:** Use native Node.js modules (`http`, `fs`, `path`, `crypto`, and native global `fetch`) for all backend server, Telegram Bot API, and Gemini REST API calls (`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`). Do NOT depend on external npm packages unless strictly necessary. If an npm package is ever required, ALWAYS install using `@latest` (never hardcode old version numbers).

## 2. Frontend & Zero-CDN Policy (`public/`)
- **Frontend Stack:** Pure HTML5, Vanilla JavaScript (ES6+), and local CSS.
- **Zero External CDN in HTML:** NEVER use external `<link>` or `<script>` tags. Always load local assets:
  - Font: `./fonts/Vazirmatn.woff2`
  - Math Engine: `./css/katex.min.css` and `./js/katex.min.js`
- **RTL & Math Isolation:** Strictly Persian RTL (`dir="rtl" lang="fa"`). Wrap all KaTeX output in containers with `direction: ltr !important; unicode-bidi: isolate !important; display: inline-block;`.
- Delete `public/editor.html` as the pipeline is 100% automated.

## 3. Telegram Mini App (TMA) & Anti-Piracy Architecture
- Initialize `window.Telegram?.WebApp` safely with desktop browser fallback (`Go Live` / `localhost:3000`).
- Server-Side Paywall Stripping: Direct browser access to `/data/*.json` MUST return `403 Forbidden`. Serve course data via `GET /api/course?id=...`. If the user has not purchased the course, strip/redact locked flashcard answers (`back`) and locked exam explanations (`explanation`) on the server before sending the JSON.
- Validate `Telegram.WebApp.initData` via `HMAC-SHA256` with the `"WebAppData"` seed when `BOT_TOKEN` is set.

## 4. Self-Healing AI Factory & Anti-Spam Error Reporting
- **Auto-Compiler Loop (`factory/generate.js`):** Load local `../public/js/katex.min.js` to validate every generated LaTeX formula with `katex.renderToString(expr, { throwOnError: true })`. Automatically fix broken formulas via Gemini REST API before saving.
- **Continuous Memory (`factory/learned_rules.json`):** Inject learned rules into the generation prompt so OCR/formula mistakes are never repeated.
- **Anti-Spam & AI Judge (`POST /api/report-issue`):**
  - Enforce rate limits: max 3 reports/day per user, 120s cooldown between reports, shadow-ban after 3 rejected strikes, and lock items that already have a pending report.
  - Validate student error claims with an AI Fact-Checker pass before queuing for 1-click admin approval in Telegram (`approve_<id>` / `reject_<id>`). Grant +2 bonus AI chat quota ONLY after approval.