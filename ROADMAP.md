# Jezveh_Saz (جزوه‌ساز) - Autonomous Production Roadmap (Milestones 4 to 6)

> **Instructions for AI Executor (`Antigravity` / `OpenCode`):**
> Always read `@AGENTS.md` first. When asked to execute a specific Milestone below, implement all requirements across the codebase using 100% native Node.js (`fetch`, `http`, `fs`, `path`, `crypto`) and Vanilla JS/CSS, then run mandatory `node --check` and live server endpoint tests before finishing.

---

## Milestone 4: Real Visual Exam Solver (Image Upload) & Smart VPN/Payment Guard
1. **Real Image Upload in AI Tutor (`public/index.html`, `public/js/app.js`, `server/server.js`):**
   - In `public/index.html` and `public/js/app.js`, wire the camera/photo button (`📷`) in Tab 4 (`tabAiSolver`) to a hidden `<input type="file" accept="image/*" id="examImageInput">`.
   - Compress/resize the selected exam problem image client-side using an HTML5 `<canvas>` (max width/height `1024px`, JPEG quality `0.75`, max payload `< 500KB`) and convert to Base64.
   - Update `POST /api/ask-tutor` in `server/server.js` (increase body limit to `1MB`) to accept an optional `imageBase64` field. When present, include `{ inlineData: { mimeType: "image/jpeg", data: imageBase64 } }` in the Gemini `generateContent` REST request so the AI reads the uploaded exam question photo and solves it step-by-step using the professor's formulas. Provide a realistic local demo fallback if no Gemini API key is configured.
2. **Real Iranian Payment Gateway Integration + VPN Guard (`server/server.js`, `public/js/app.js`):**
   - Implement native `fetch` support for Zibal/Zarinpal payment initiation (`POST /api/payment/create`) and callback verification (`GET /api/payment/verify`) using `MERCHANT_ID` from `.env` (fallback to instant simulated unlock if `MERCHANT_ID` is empty/demo).
   - Add a creator payout request endpoint (`POST /api/creator-payout`) and `/payout` command in `server/bot.js` allowing creators to register their Sheba (`IR...`) number and request settlement of their 70% earnings (`DB.creatorEarnings`), notifying the Admin on Telegram.

---

## Milestone 5: Local CLI Course Generator & Leitner Spaced-Repetition Bot Reminders
1. **Terminal CLI Tool for Fast Course Creation (`factory/cli.js`):**
   - Create `factory/cli.js` so the admin can generate a new course package directly from Windows PowerShell without needing Telegram:
     `node factory/cli.js --file ./notes.pdf --id metal_casting_01 --title "پکیج شب امتحان انجماد و ریخته‌گری" --category "مهندسی مواد و متالورژی" --price 65000`
   - Include a `--demo` flag that generates a valid, KaTeX-verified course JSON file in `public/data/` even when offline/without an API key for rapid testing.
2. **Leitner Review Sync & Nightly Bot Reminder (`server/server.js`, `server/bot.js`, `public/js/app.js`):**
   - Add `POST /api/sync-progress` in `server/server.js` so when a student marks cards as `review` ("🔄 مرور مجدد در شب امتحان"), the count of cards needing review is synced to `DB.userStudyProgress[userId]`.
   - Add a `/review` command and a lightweight reminder scheduler in `server/bot.js` that messages students who have pending `review` flashcards with a direct WebApp Deep Link button to review their weak cards before exam day.

---

## Milestone 6: Production Hardening, Caching, and Automated End-to-End Test Suite
1. **Performance & Security Hardening (`server/server.js`):**
   - Add `Cache-Control: public, max-age=604800, immutable` headers for static `.woff2` fonts and `katex.min.*` files so the Mini App loads instantaneously on slow mobile networks.
   - Add basic security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: ALLOWALL` for Telegram WebView compatibility) and load `.env` variables natively using a lightweight parser in `server/server.js`.
2. **Production Process Config & Self-Test Suite (`ecosystem.config.cjs`, `server/self_test.js`):**
   - Create `ecosystem.config.cjs` for 24/7 production deployment with `pm2` (`pm2 start ecosystem.config.cjs`).
   - Create `server/self_test.js` that runs an automated end-to-end health check of all API routes (`/api/courses`, `/api/course`, `/api/ask-tutor`, `/api/report-issue`, `/api/creator-stats`, static asset protection) and prints a clear pass/fail report.