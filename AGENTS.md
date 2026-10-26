# Jezveh_Saz (جزوه‌ساز) - Architecture & Coding Rules

## 1. Tech Stack & Zero-CDN Policy
- **Frontend:** Pure HTML5, Vanilla JavaScript (ES6+), and Native CSS (using CSS Variables and Logical Properties).
- **Zero External CDN in HTML:** NEVER put external `<link>` or `<script>` tags (like Google Fonts or cdnjs) inside HTML files. Always load local files:
  - Font: `./fonts/Vazirmatn.woff2`
  - Math Engine: `./css/katex.min.css` and `./js/katex.min.js`
- **RTL & Logical CSS:** The app is strictly Persian RTL (`dir="rtl" lang="fa"`). Always use CSS Logical Properties (`margin-inline`, `padding-inline`, `inset-inline-start`, `border-inline-start`).
- **Math Isolation:** All math formulas rendered via `katex.renderToString()` MUST be wrapped in containers with `direction: ltr !important; unicode-bidi: isolate !important; display: inline-block;`.

## 2. Telegram Mini App (TMA) UX & Security
- Initialize `window.Telegram?.WebApp` safely with fallback for normal desktop browser testing (`Go Live`).
- Call `ready()`, `expand()`, and `disableVerticalSwipes()` if running inside Telegram.
- Trigger `HapticFeedback` on card flips (`impactOccurred('light')`), quiz answers (`notificationOccurred('success'|'error')`), and locked items.
- Save flashcard Leitner statuses (`known`, `review`) in `Telegram.WebApp.CloudStorage` with automatic fallback to `localStorage`.
- Render a subtle diagonal repeating watermark overlay showing the user's Telegram `@username` or ID across study cards (`pointer-events: none; user-select: none;`).
- Disable text copying (`user-select: none`) and right-click context menu on study content.

## 3. Contextual AI Tutor & Follow-up Q&A Architecture
- Every flashcard, summary item, and exam question MUST include a contextual action button: "💬 ابهامی داری؟ از همین نکته بپرس".
- Clicking this button opens a sleek slide-up AI Chat Drawer pre-loaded with the context of that specific card/question and its `source_page`.
- Provide quick-prompt chips inside the drawer (e.g., "ساده‌تر توضیح بده", "مثال عددی بزن", "نکته امتحانی این بخش چیه؟").
- Include a 4th main tab ("⚡ حل سوال و چت با جزوه") allowing students to ask free-form questions or upload an exam problem image to be solved strictly based on the professor's lecture notes, complete with a remaining query quota badge.