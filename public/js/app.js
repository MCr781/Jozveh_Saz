const AppState = {
  course: null,
  currentCourseSlug: 'sample_course',
  catalog: [],
  catalogCategory: 'all',
  catalogSearchQuery: '',
  currentCardIndex: 0,
  cardFilter: 'all', // 'all' | 'review'
  leitnerStatus: {}, // { fc_1: 'known' | 'review' }
  quizAnswers: {},
  isProUnlocked: false,
  aiRemainingFree: 3,
  activeContextItem: null,
  creatorStats: { balanceToman: 0, salesCount: 0 }
};

// Helper: Determine API base URL (supports direct server access & Live Server port 5500)
function getApiBase() {
  if (window.location.port === '5500' || window.location.protocol === 'file:') {
    return 'http://localhost:3000';
  }
  return '';
}

// Helper: Safely retrieve Telegram WebApp initData string
function getTelegramInitData() {
  return window.Telegram?.WebApp?.initData || window.TMA?.tg?.initData || '';
}

// XSS Protection: HTML entity escaping
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Unified API client wrapper with 15s timeout, Telegram auth & error surfacing
async function api(path, options = {}) {
  const apiBase = getApiBase();
  const url = path.startsWith('http') ? path : `${apiBase}${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  const headers = Object.assign({
    'Content-Type': 'application/json',
    'X-Telegram-Init-Data': getTelegramInitData()
  }, options.headers || {});

  try {
    const res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (res.status === 401) {
      alert('لطفاً مینی‌اپ را از داخل تلگرام باز کنید.');
      return { ok: false, status: 401, code: 'UNAUTHORIZED', message: 'لطفاً مینی‌اپ را از داخل تلگرام باز کنید.' };
    }

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        code: data?.code || `HTTP_${res.status}`,
        message: data?.message || data?.error || res.statusText,
        data
      };
    }

    return data || { ok: true, status: res.status };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return { ok: false, status: 408, code: 'TIMEOUT', message: 'مهلت پاسخ‌دهی به پایان رسید (۱۵ ثانیه).' };
    }
    return { ok: false, status: 0, code: 'NETWORK_ERROR', message: err.message || 'خطای ارتباط با سرور' };
  }
}

// Sanitize JSON control characters (\f, \t, \b) & render KaTeX safely
function sanitizeLatex(str) {
  if (!str) return '';
  return String(str)
    .replace(/\f/g, '\\f')
    .replace(/\t/g, '\\t')
    .replace(/\x08/g, '\\b');
}

function renderLatexExpression(latex, displayMode = false) {
  const clean = sanitizeLatex(latex);
  if (window.katex) {
    try {
      const rendered = window.katex.renderToString(clean, {
        displayMode,
        throwOnError: false
      });
      return `<span class="katex-container" style="direction: ltr !important; unicode-bidi: isolate !important; display: ${displayMode ? 'block' : 'inline-block'};">${rendered}</span>`;
    } catch (_) {
      return `<code dir="ltr">${escapeHtml(clean)}</code>`;
    }
  }
  return `<code dir="ltr">${escapeHtml(clean)}</code>`;
}

function renderTextWithMath(text) {
  if (!text) return '';
  const sanitized = sanitizeLatex(text);

  const mathTokens = [];
  // 1. Block math $$...$$
  let withTokens = sanitized.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    const idx = mathTokens.length;
    mathTokens.push(renderLatexExpression(math.trim(), true));
    return `___MATH_BLOCK_${idx}___`;
  });

  // 2. Inline math $...$
  withTokens = withTokens.replace(/\$([^\$]+?)\$/g, (_, math) => {
    const idx = mathTokens.length;
    mathTokens.push(renderLatexExpression(math.trim(), false));
    return `___MATH_INLINE_${idx}___`;
  });

  // 3. Escape all non-math text so <img src=x onerror=...> never executes
  let escaped = escapeHtml(withTokens);

  // 4. Restore rendered KaTeX
  escaped = escaped.replace(/___MATH_(?:BLOCK|INLINE)_(\d+)___/g, (_, idx) => {
    return mathTokens[Number(idx)] || '';
  });

  return escaped.replace(/\n/g, '<br>');
}

function buildWatermarkHTML() {
  const mark = window.TMA.getUserWatermark();
  return `<div class="watermark-overlay">
    <span>${mark}</span><span>${mark}</span>
    <span>${mark}</span><span>${mark}</span>
    <span>${mark}</span><span>${mark}</span>
  </div>`;
}

// Locate any item by ID across cheat sheet, flashcards, and exam questions
function getItemById(itemId) {
  if (!AppState.course) return null;
  const s = (AppState.course.summary_cheat_sheet || []).find((x) => x.id === itemId);
  if (s) {
    return {
      itemId: s.id,
      originalText: `${s.topic} ${s.formula_latex || ''}`,
      sourcePage: s.source_page,
      label: s.topic
    };
  }
  const f = (AppState.course.flashcards || []).find((x) => x.id === itemId);
  if (f) {
    return {
      itemId: f.id,
      originalText: `${f.front} - ${f.back}`,
      sourcePage: f.source_page,
      label: f.front.slice(0, 45) + '...'
    };
  }
  const q = (AppState.course.exam_questions || []).find((x) => x.id === itemId);
  if (q) {
    return {
      itemId: q.id,
      originalText: q.question_stem,
      sourcePage: q.source_page,
      label: q.question_stem.slice(0, 45) + '...'
    };
  }
  return null;
}

// بارگذاری جزوه مشخص‌شده با جابه‌جایی آنی بدون نیاز به ریفرش کامل مرورگر
async function loadCourseData(courseSlug) {
  AppState.currentCourseSlug = courseSlug;

  try {
    // ۱. دریافت داده‌ها از API سرور همراه با بررسی وضعیت خرید Pro
    const payload = await api(`/api/course?id=${encodeURIComponent(courseSlug)}`);
    if (payload && payload.ok && payload.course) {
      AppState.course = payload.course;
      AppState.isProUnlocked = Boolean(payload.isProUnlocked);
      AppState.aiRemainingFree = payload.remainingAiQuota !== undefined ? payload.remainingAiQuota : 3;
    } else {
      throw new Error(payload?.message || 'API course load failed');
    }
  } catch (_) {
    // ۲. Fallback مخصوص تست آفلاین
    const fallback = AppState.catalog.find((c) => c.slug === courseSlug || c.id === courseSlug);
    if (fallback) {
      AppState.course = fallback;
    }
  }

  if (!AppState.course) return;

  AppState.currentCardIndex = 0;
  const loadedCourseId = AppState.course.id;
  window.TMA.loadProgress(`progress_${loadedCourseId}`, (saved) => {
    // اگر کاربر حین بارگذاری درس را عوض کرده باشد، نتیجهٔ قدیمی نادیده گرفته می‌شود
    if (!AppState.course || AppState.course.id !== loadedCourseId) return;
    AppState.leitnerStatus = saved.leitnerStatus || {};
    if (saved.isProUnlocked) AppState.isProUnlocked = true;
    renderHeader();
    renderCheatSheet();
    renderFlashcardView();
    renderExamQuiz();
    renderAiQuotaBadge();
    updatePaywallModalPrices();
    // همگام‌سازی اولیه وضعیت مرور با سرور تا یادآور شبانه تلگرام دقیق باشد
    syncStudyProgress();
  });
}

// همگام‌سازی تعداد کارت‌های نیازمند مرور با سرور (برای یادآور لایتنر در ربات)
async function syncStudyProgress() {
  if (!AppState.course) return;

  const cards = AppState.course.flashcards || [];
  const validIds = new Set(cards.map((card) => card.id));
  const entries = Object.entries(AppState.leitnerStatus).filter(([id]) => validIds.has(id));
  const pendingReviewIds = entries.filter(([, status]) => status === 'review').map(([id]) => id);
  const knownCount = entries.filter(([, status]) => status === 'known').length;

  const payload = {
    courseId: AppState.currentCourseSlug || AppState.course.id || 'sample_course',
    courseTitle: AppState.course.title || '',
    reviewCount: pendingReviewIds.length,
    knownCount,
    totalCards: cards.length,
    pendingReviewIds: pendingReviewIds.slice(0, 200)
  };

  try {
    const res = await api('/api/sync-progress', {
      method: 'POST',
      body: JSON.stringify(payload),
      keepalive: true
    });
    if (res && res.streak !== undefined) {
      updateStreakUI(res.streak, res.badges);
    }
  } catch (_) {
    // آفلاین: پیشرفت در localStorage/CloudStorage باقی می‌ماند
  }
}

function updateStreakUI(streak = 0, badges = []) {
  const badgeEl = document.getElementById('streakBadge');
  if (!badgeEl) return;
  if (streak > 0) {
    badgeEl.style.display = 'inline-block';
    badgeEl.textContent = `🔥 ${streak} روز متوالی`;
  } else {
    badgeEl.style.display = 'none';
  }
}

// دریافت کاتالوگ تمام دروس موجود
async function fetchCatalog() {
  try {
    const data = await api('/api/courses');
    if (data && data.ok && Array.isArray(data.courses) && data.courses.length > 0) {
      AppState.catalog = data.courses;
      renderCatalogCourses();
      return;
    }
  } catch (_) {}

  // Fallback محلی برای حالت آفلاین
  AppState.catalog = [
    {
      id: 'ut_metal_thermo_01',
      slug: 'sample_course',
      title: 'پکیج شب امتحان ترمودینامیک و خواص مواد',
      instructor: 'منطبق بر جزوه و سوالات پایانترم دانشگاه تهران',
      creator: 'گردآوری: رتبه ۱ ورودی ۱۴۰۱',
      category: 'مهندسی مواد و متالورژی',
      price_toman: 59000,
      flashcards_count: 6,
      questions_count: 5,
      isProUnlocked: false
    },
    {
      id: 'eng_math_01',
      slug: 'eng_math_01',
      title: 'پکیج شب امتحان ریاضی مهندسی - معادلات دیفرانسیل با مشتقات جزئی و فوریه',
      instructor: 'منطبق بر سرفصل‌های دانشگاه تهران و صنعتی شریف',
      creator: 'گردآوری: سارا محمدی (رتبه ۲ ورودی ۱۴۰۱)',
      category: 'دروس پایه مهندسی',
      price_toman: 69000,
      flashcards_count: 4,
      questions_count: 4,
      isProUnlocked: false
    }
  ];
  renderCatalogCourses();
}

// دریافت آمار سهم ۷۰ درصدی جزوه‌نویس
async function fetchCreatorStats() {
  try {
    const data = await api('/api/creator-stats');
    if (data && data.ok) {
      AppState.creatorStats = {
        balanceToman: data.balanceToman || 0,
        salesCount: data.salesCount || 0
      };
      const salesEl = document.getElementById('creatorSalesCount');
      const balEl = document.getElementById('creatorBalanceToman');
      if (salesEl) salesEl.textContent = `${(data.salesCount || 0).toLocaleString('fa-IR')} پکیج`;
      if (balEl) balEl.textContent = `${(data.balanceToman || 0).toLocaleString('fa-IR')} تومان`;
    }
  } catch (_) {}
}

async function initStudyPlayer() {
  window.TMA.initApp();

  const urlParams = new URLSearchParams(window.location.search);
  const courseSlug = urlParams.get('course') || 'sample_course';

  await loadCourseData(courseSlug);
  fetchCatalog();
  fetchCreatorStats();

  setupTabSwitching();
  setupKeyboardShortcuts();

  // Deep Link ربات: /?course=...&review=1 → مستقیم تب فلش‌کارت و فیلتر کارت‌های ضعیف
  if (urlParams.get('review') === '1' || urlParams.get('filter') === 'review') {
    activateReviewMode();
  }
}

function activateReviewMode() {
  AppState.cardFilter = 'review';
  AppState.currentCardIndex = 0;

  const flashTabBtn = document.querySelector('.tab-btn[data-tab="tabFlashcards"]');
  if (flashTabBtn) {
    flashTabBtn.click();
  } else {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === 'tabFlashcards');
    });
    document.querySelectorAll('.view-section').forEach((view) => {
      view.classList.toggle('active', view.id === 'tabFlashcards');
    });
  }

  const filterPills = document.querySelectorAll('#tabFlashcards .filter-pills .pill-btn');
  filterPills.forEach((pill, index) => pill.classList.toggle('active', index === 1));

  renderFlashcardView();
}

function setupKeyboardShortcuts() {
  const drawerInput = document.getElementById('drawerInput');
  if (drawerInput) {
    drawerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        window.sendContextualPrompt('default');
      }
    });
  }

  const mainAiInput = document.getElementById('mainAiInput');
  if (mainAiInput) {
    mainAiInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        window.sendMainTabQuestion('default');
      }
    });
  }
}

function renderHeader() {
  const c = AppState.course;
  if (!c) return;
  document.getElementById('courseTitle').textContent = c.title || 'جزوه زنده';
  document.getElementById('courseSubtitle').textContent = `${c.instructor || ''} • ${c.creator || ''}`;

  const totalCards = (c.flashcards || []).length;
  const knownCount = Object.values(AppState.leitnerStatus).filter((v) => v === 'known').length;
  const pct = totalCards > 0 ? Math.min(100, Math.round((knownCount / totalCards) * 100)) : 0;

  document.getElementById('progressFill').style.width = `${pct}%`;
  document.getElementById('progressLabel').textContent = `${knownCount} از ${totalCards} کارت مسلط`;

  const proBtn = document.getElementById('headerProBtn');
  if (AppState.isProUnlocked) {
    proBtn.textContent = '✨ نسخه کامل فعال';
    proBtn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
  } else {
    const priceText = c.price_toman ? (c.price_toman / 1000) + ' ت' : '۵۹ ت';
    proBtn.textContent = `🔓 نسخه کامل (${priceText})`;
    proBtn.style.background = '';
  }
}

function updatePaywallModalPrices() {
  const c = AppState.course;
  if (!c) return;
  const priceStr = `${(c.price_toman || 59000).toLocaleString('fa-IR')} تومان`;
  const p1 = document.getElementById('paywallPriceShaparak');
  const p2 = document.getElementById('paywallPriceCard');
  if (p1) p1.textContent = priceStr;
  if (p2) p2.textContent = priceStr;
}

function setupTabSwitching() {
  const btns = document.querySelectorAll('.tab-btn');
  const views = document.querySelectorAll('.view-section');

  btns.forEach((btn) => {
    btn.addEventListener('click', () => {
      window.TMA.triggerHaptic('light');
      const target = btn.getAttribute('data-tab');
      btns.forEach((b) => b.classList.remove('active'));
      views.forEach((v) => v.classList.remove('active'));

      btn.classList.add('active');
      const targetEl = document.getElementById(target);
      if (targetEl) targetEl.classList.add('active');
    });
  });
}

// 1. Cheat Sheet Tab
function renderCheatSheet() {
  const container = document.getElementById('cheatSheetContainer');
  if (!AppState.course?.summary_cheat_sheet) return;

  container.innerHTML = AppState.course.summary_cheat_sheet
    .map((item) => {
      const pointsHtml = (item.key_points || [])
        .map((p) => `<li>${renderTextWithMath(p)}</li>`)
        .join('');
      const formulaHtml = item.formula_latex
        ? renderLatexExpression(item.formula_latex, true)
        : '';

      return `
        <div class="study-card">
          ${buildWatermarkHTML()}
          <div class="card-header-meta">
            <span class="topic-title">${item.topic}</span>
            <span class="page-badge">صفحه ${item.source_page} جزوه</span>
          </div>
          <ul class="key-points-list">${pointsHtml}</ul>
          ${formulaHtml}
          <button class="ask-ai-contextual-btn" onclick="openContextualDrawer('${item.id}')">
            💬 ابهامی داری؟ از همین نکته بپرس
          </button>
          <button class="pill-btn" style="margin-top:6px; width:100%; font-size:0.72rem;" onclick="openReportModal('${item.id}')">
            🚩 گزارش خطای علمی/تایپی در این فرمول
          </button>
        </div>
      `;
    })
    .join('');
}

// 2. Flashcards Tab
function getFilteredCards() {
  const all = AppState.course?.flashcards || [];
  if (AppState.cardFilter === 'review') {
    const filtered = all.filter((c) => AppState.leitnerStatus[c.id] === 'review');
    return filtered.length ? filtered : all;
  }
  return all;
}

function renderFlashcardView() {
  const deck = getFilteredCards();
  if (!deck.length) return;

  if (AppState.currentCardIndex >= deck.length) {
    AppState.currentCardIndex = 0;
  }

  const card = deck[AppState.currentCardIndex];
  const isLocked = card.is_locked && !AppState.isProUnlocked;

  document.getElementById('cardCounterBadge').textContent = `کارت ${AppState.currentCardIndex + 1} از ${deck.length}`;

  const scene = document.getElementById('flashcardScene');
  const cardReportBtn = document.getElementById('cardReportBtn');

  if (isLocked) {
    scene.innerHTML = `
      <div class="flashcard-face">
        <div class="locked-blur-content card-body-center">
          <div class="card-text-flow">${renderTextWithMath(card.front)}</div>
        </div>
        <div class="locked-overlay-cta">
          <div style="font-size:1.6rem">🔒</div>
          <div style="font-weight:800; font-size:0.95rem; margin-top:4px;">این فلش‌کارت قفل است</div>
          <div style="font-size:0.78rem; color:#cbd5e1; margin-top:6px; max-width:320px;">
            برای دسترسی به تمام فلش‌کارت‌ها، سوالات پایانترم و ۱۰۰ پرسش از هوش مصنوعی، نسخه کامل را فعال کنید.
          </div>
          <button class="unlock-btn-primary" onclick="openPaywallModal()">
            🔓 باز کردن قفل کامل (${(AppState.course.price_toman || 59000).toLocaleString('fa-IR')} تومان)
          </button>
        </div>
      </div>
    `;
    const ctxBtn = document.getElementById('cardContextualBtn');
    if (ctxBtn) ctxBtn.style.display = 'none';
    if (cardReportBtn) cardReportBtn.style.display = 'none';
  } else {
    const statusBadge =
      AppState.leitnerStatus[card.id] === 'known'
        ? '<span style="color:#34d399; font-size:0.74rem;">✅ مسلط هستم</span>'
        : AppState.leitnerStatus[card.id] === 'review'
        ? '<span style="color:#fbbf24; font-size:0.74rem;">🔄 نیاز به مرور</span>'
        : '<span style="color:#94a3b8; font-size:0.74rem;">جدید</span>';

    scene.innerHTML = `
      <div class="flashcard-inner" id="flashcardInner" onclick="flipCurrentCard()">
        <div class="flashcard-face flashcard-front">
          ${buildWatermarkHTML()}
          <div class="card-header-meta">
            ${statusBadge}
            <span class="page-badge">صفحه ${card.source_page} جزوه</span>
          </div>
          <div class="card-body-center">
            <div class="card-text-flow">${renderTextWithMath(card.front)}</div>
          </div>
          <div class="flip-hint">👆 برای مشاهده پاسخ و فرمول روی کارت بزنید</div>
        </div>
        <div class="flashcard-face flashcard-back">
          ${buildWatermarkHTML()}
          <div class="card-header-meta">
            <span style="color:#34d399; font-size:0.76rem; font-weight:700;">پاسخ استاندارد جزوه</span>
            <span class="page-badge">صفحه ${card.source_page}</span>
          </div>
          <div class="card-body-center">
            <div class="card-text-flow">${renderTextWithMath(card.back)}</div>
          </div>
          <div class="flip-hint">👆 بازگشت به روی کارت</div>
        </div>
      </div>
    `;

    const ctxBtn = document.getElementById('cardContextualBtn');
    if (ctxBtn) {
      ctxBtn.style.display = 'flex';
      ctxBtn.onclick = () => openContextualDrawer(card.id);
    }
    if (cardReportBtn) {
      cardReportBtn.style.display = 'block';
    }
  }
}

window.openCurrentCardReport = function () {
  const deck = getFilteredCards();
  const card = deck[AppState.currentCardIndex];
  if (!card) return;
  openReportModal(card.id);
};

window.flipCurrentCard = function () {
  window.TMA.triggerHaptic('light');
  const inner = document.getElementById('flashcardInner');
  if (inner) inner.classList.toggle('is-flipped');
};

window.markCardStatus = function (status) {
  const deck = getFilteredCards();
  const card = deck[AppState.currentCardIndex];
  if (!card) return;

  if (card.is_locked && !AppState.isProUnlocked) {
    openPaywallModal();
    return;
  }

  window.TMA.triggerHaptic(status === 'known' ? 'success' : 'warning');
  AppState.leitnerStatus[card.id] = status;
  window.TMA.saveProgress(`progress_${AppState.course.id}`, {
    leitnerStatus: AppState.leitnerStatus,
    isProUnlocked: AppState.isProUnlocked
  });

  // هر بار «مرور مجدد» یا «بلدم» زده شد، شمارش کارت‌های ضعیف به سرور سینک می‌شود
  syncStudyProgress();

  renderHeader();
  nextFlashcard(1);
};

window.nextFlashcard = function (dir) {
  window.TMA.triggerHaptic('light');
  const deck = getFilteredCards();
  if (!deck.length) return;
  AppState.currentCardIndex = (AppState.currentCardIndex + dir + deck.length) % deck.length;
  renderFlashcardView();
};

window.setCardFilter = function (filterType, btnEl) {
  AppState.cardFilter = filterType;
  AppState.currentCardIndex = 0;
  document.querySelectorAll('.pill-btn').forEach((b) => b.classList.remove('active'));
  btnEl.classList.add('active');
  renderFlashcardView();
};

// 3. Exam Simulator Tab
function renderExamQuiz() {
  const container = document.getElementById('examQuestionsContainer');
  if (!AppState.course?.exam_questions) return;

  container.innerHTML = AppState.course.exam_questions
    .map((q, idx) => {
      const isLocked = q.is_locked && !AppState.isProUnlocked;

      if (isLocked) {
        return `
          <div class="study-card locked-container" style="min-height:190px;">
            <div class="locked-blur-content">
              <div class="topic-title">${q.question_stem}</div>
            </div>
            <div class="locked-overlay-cta">
              <div>🔒 <strong>سوال امتحانی شماره ${idx + 1} قفل است</strong></div>
              <button class="unlock-btn-primary" onclick="openPaywallModal()">
                مشاهده تمامی سوالات + پاسخ تشریحی
              </button>
            </div>
          </div>
        `;
      }

      const optionsHtml = (q.options || [])
        .map(
          (opt, optIdx) => `
          <button class="quiz-option-btn" id="opt_${q.id}_${optIdx}" onclick="selectQuizOption('${q.id}', ${optIdx}, ${q.correct_index})">
            <span>${renderTextWithMath(opt)}</span>
          </button>
        `
        )
        .join('');

      return `
        <div class="study-card">
          ${buildWatermarkHTML()}
          <div class="card-header-meta">
            <span class="topic-title">سوال ${idx + 1}</span>
            <span class="page-badge">منبع: صفحه ${q.source_page} جزوه</span>
          </div>
          <div style="font-size:0.9rem; margin-bottom:12px;">
            ${renderTextWithMath(q.question_stem)}
          </div>
          <div>${optionsHtml}</div>
          <div class="quiz-explanation-box" id="exp_${q.id}">
            <strong>✅ پاسخ تشریحی استاد:</strong><br>
            ${renderTextWithMath(q.explanation)}
            <button class="ask-ai-contextual-btn" onclick="openContextualDrawer('${q.id}')">
              💬 چرا این گزینه درست شد؟ از هوش مصنوعی بپرس
            </button>
            <button class="pill-btn" style="margin-top:8px; width:100%; font-size:0.72rem;" onclick="openReportModal('${q.id}')">
              🚩 گزارش خطای علمی/تایپی در این سوال
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

window.selectQuizOption = function (qId, selectedIdx, correctIdx) {
  for (let i = 0; i < 4; i++) {
    const el = document.getElementById(`opt_${qId}_${i}`);
    if (!el) continue;
    el.classList.remove('correct', 'wrong');
    if (i === correctIdx) el.classList.add('correct');
    else if (i === selectedIdx) el.classList.add('wrong');
  }

  window.TMA.triggerHaptic(selectedIdx === correctIdx ? 'success' : 'error');
  const expBox = document.getElementById(`exp_${qId}`);
  if (expBox) expBox.classList.add('visible');
};

// 4. Contextual AI Tutor & Main Chat Solver
function renderAiQuotaBadge() {
  const badge = document.getElementById('aiQuotaStatus');
  if (!badge) return;
  if (AppState.isProUnlocked) {
    badge.innerHTML = '⚡ سهمیه پرسش هوشمند: <strong>۱۰۰ پرسش فعال (نسخه Pro)</strong>';
  } else {
    badge.innerHTML = `⚡ سهمیه رایگان چت با جزوه: <strong>${AppState.aiRemainingFree} از ۳ پرسش باقی‌مانده</strong>`;
  }
}

window.openContextualDrawer = function (itemId) {
  window.TMA.triggerHaptic('light');
  const item = getItemById(itemId) || {
    itemId,
    originalText: 'مبحث انتخابی',
    sourcePage: 1,
    label: 'نکته جزوه'
  };

  AppState.activeContextItem = item;
  document.getElementById('drawerContextTitle').textContent = `صفحه ${item.sourcePage} جزوه • ${item.label}`;
  document.getElementById('drawerChatBox').innerHTML = `
    <div class="chat-bubble ai">
      سلام! من روی <strong>صفحه ${item.sourcePage} جزوه استاد</strong> زوم کرده‌ام:<br>
      <div style="color:#94a3b8; font-size:0.8rem; margin-top:4px;">«${renderTextWithMath(item.label)}»</div>
      <div style="margin-top:6px;">کدام بخش این نکته یا فرمول برایت مبهم است؟</div>
    </div>
  `;
  document.getElementById('aiDrawerBackdrop').classList.add('open');
};

window.closeContextualDrawer = function () {
  document.getElementById('aiDrawerBackdrop').classList.remove('open');
};

window.sendContextualPrompt = async function (presetKey, customText) {
  if (!AppState.isProUnlocked && AppState.aiRemainingFree <= 0) {
    closeContextualDrawer();
    openPaywallModal();
    return;
  }

  const chatBox = document.getElementById('drawerChatBox');
  const inputEl = document.getElementById('drawerInput');
  const userMsg = (customText || inputEl.value || '').trim();
  if (!userMsg) return;
  if (!customText) inputEl.value = '';

  // XSS protection: safely append user message with textContent
  const userBubble = document.createElement('div');
  userBubble.className = 'chat-bubble user';
  userBubble.textContent = userMsg;
  chatBox.appendChild(userBubble);
  chatBox.scrollTop = chatBox.scrollHeight;

  const loadingId = 'loading_ctx_' + Date.now();
  chatBox.innerHTML += `<div class="chat-bubble ai" id="${loadingId}">در حال پردازش بر اساس جزوه استاد... ⏳</div>`;
  chatBox.scrollTop = chatBox.scrollHeight;

  const contextDesc = AppState.activeContextItem
    ? `صفحه ${AppState.activeContextItem.sourcePage}: ${AppState.activeContextItem.originalText}`
    : (AppState.course?.title || '');

  try {
    const data = await api('/api/ask-tutor', {
      method: 'POST',
      body: JSON.stringify({
        courseId: AppState.course?.id || 'sample_course',
        contextText: contextDesc,
        question: userMsg,
        presetKey
      })
    });

    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();

    if (data.status === 402 || data?.quotaExceeded) {
      closeContextualDrawer();
      openPaywallModal();
      return;
    }

    if (data.status === 429) {
      alert(data?.message || 'لطفاً چند ثانیه صبر کنید.');
      return;
    }

    if (data.status === 503 || data.code === 'AI_UPSTREAM') {
      alert('سرویس هوش مصنوعی موقتاً در دسترس نیست. لطفاً بعداً تلاش فرمایید (سهمیه شما محفوظ است).');
      return;
    }

    if (data && data.ok) {
      window.TMA.triggerHaptic('success');
      chatBox.innerHTML += `<div class="chat-bubble ai">${renderTextWithMath(data.reply)}</div>`;
      chatBox.scrollTop = chatBox.scrollHeight;
      if (data.remainingAiQuota !== undefined) {
        AppState.aiRemainingFree = data.remainingAiQuota;
        renderAiQuotaBadge();
      }
      return;
    }
    throw new Error(data?.message || 'Server error');
  } catch (err) {
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();

    if (err?.message && err.message !== 'Server error') {
      alert(err.message);
    }
  }
};

window.sendMainTabQuestion = async function (presetKey, labelText) {
  if (!AppState.isProUnlocked && AppState.aiRemainingFree <= 0) {
    openPaywallModal();
    return;
  }

  const box = document.getElementById('mainAiChatBox');
  const input = document.getElementById('mainAiInput');
  const question = (labelText || input.value || '').trim();
  if (!question) return;
  if (!labelText) input.value = '';

  // XSS protection: safely append user message with textContent
  const userBubble = document.createElement('div');
  userBubble.className = 'chat-bubble user';
  userBubble.textContent = question;
  box.appendChild(userBubble);
  box.scrollTop = box.scrollHeight;

  const loadingId = 'loading_main_' + Date.now();
  box.innerHTML += `<div class="chat-bubble ai" id="${loadingId}">در حال حل با روش و فرمول‌های استاد... ⏳</div>`;
  box.scrollTop = box.scrollHeight;

  try {
    const data = await api('/api/ask-tutor', {
      method: 'POST',
      body: JSON.stringify({
        courseId: AppState.course?.id || 'sample_course',
        contextText: AppState.course?.title || '',
        question,
        presetKey
      })
    });

    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();

    if (data.status === 402 || data?.quotaExceeded) {
      openPaywallModal();
      return;
    }

    if (data.status === 429) {
      alert(data?.message || 'لطفاً چند ثانیه صبر کنید.');
      return;
    }

    if (data.status === 503 || data.code === 'AI_UPSTREAM') {
      alert('سرویس هوش مصنوعی موقتاً در دسترس نیست. لطفاً بعداً تلاش فرمایید (سهمیه شما محفوظ است).');
      return;
    }

    if (data && data.ok) {
      window.TMA.triggerHaptic('success');
      box.innerHTML += `<div class="chat-bubble ai">${renderTextWithMath(data.reply)}</div>`;
      box.scrollTop = box.scrollHeight;
      if (data.remainingAiQuota !== undefined) {
        AppState.aiRemainingFree = data.remainingAiQuota;
        renderAiQuotaBadge();
      }
      return;
    }
    throw new Error(data?.message || 'Server error');
  } catch (err) {
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();
    if (err?.message && err.message !== 'Server error') {
      alert(err.message);
    }
  }
};

// --- Milestone 3: Multi-Course Catalog Hub & Switching ---
window.openCatalogModal = function () {
  window.TMA.triggerHaptic('light');
  fetchCatalog();
  fetchCreatorStats();
  document.getElementById('catalogBackdrop').classList.add('open');
};

window.closeCatalogModal = function () {
  document.getElementById('catalogBackdrop').classList.remove('open');
};

window.setCatalogCategory = function (category, btnEl) {
  AppState.catalogCategory = category;
  document.querySelectorAll('.catalog-pills .pill-btn').forEach((b) => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  renderCatalogCourses();
};

window.filterCatalogList = function () {
  const input = document.getElementById('catalogSearchInput');
  AppState.catalogSearchQuery = (input ? input.value : '').trim().toLowerCase();
  renderCatalogCourses();
};

function renderCatalogCourses() {
  const container = document.getElementById('catalogCoursesContainer');
  if (!container) return;

  const filtered = AppState.catalog.filter((c) => {
    // فیلتر بر اساس دسته‌بندی
    if (AppState.catalogCategory !== 'all' && c.category !== AppState.catalogCategory) {
      return false;
    }
    // فیلتر جستجو
    if (AppState.catalogSearchQuery) {
      const q = AppState.catalogSearchQuery;
      const match =
        (c.title && c.title.toLowerCase().includes(q)) ||
        (c.instructor && c.instructor.toLowerCase().includes(q)) ||
        (c.creator && c.creator.toLowerCase().includes(q)) ||
        (c.category && c.category.toLowerCase().includes(q));
      if (!match) return false;
    }
    return true;
  });

  if (!filtered.length) {
    container.innerHTML = `
      <div style="text-align:center; padding:30px 10px; color:#94a3b8; font-size:0.84rem;">
        🔍 جزوه‌ای با این عنوان یافت نشد. می‌توانید با ارسال PDF در ربات، اولین جزوه‌نویس این درس باشید!
      </div>
    `;
    return;
  }

  container.innerHTML = filtered
    .map((c) => {
      const isCurrent = (AppState.course && AppState.course.id === c.id) || AppState.currentCourseSlug === c.slug;
      const isUnlocked = c.isProUnlocked || (isCurrent && AppState.isProUnlocked);
      const priceText = isUnlocked ? '✨ نسخه کامل فعال' : `${(c.price_toman || 59000).toLocaleString('fa-IR')} تومان`;

      return `
        <div class="course-catalog-card ${isCurrent ? 'active-course' : ''}" onclick="switchCourse('${c.slug}')">
          <div class="catalog-card-category">${c.category || 'دروس پایه'}</div>
          <div class="catalog-card-title">${c.title}</div>
          <div class="catalog-card-instructor">${c.instructor || ''} • ${c.creator || ''}</div>
          <div class="catalog-card-footer">
            <div class="catalog-card-badges">
              <span>🗂️ ${c.flashcards_count || 4} فلش‌کارت</span>
              <span>📝 ${c.questions_count || 4} سوال امتحان</span>
            </div>
            <div class="catalog-card-price ${isUnlocked ? 'unlocked-pro' : ''}">${priceText}</div>
          </div>
        </div>
      `;
    })
    .join('');
}

// جابه‌جایی آنی درس بدون بارگذاری مجدد کل صفحه
window.switchCourse = async function (slug) {
  if (AppState.currentCourseSlug === slug) {
    closeCatalogModal();
    return;
  }

  window.TMA.triggerHaptic('success');
  closeCatalogModal();

  // به‌روزرسانی URL بدون ریفرش صفحه
  const newUrl = `${window.location.pathname}?course=${encodeURIComponent(slug)}`;
  window.history.pushState(null, '', newUrl);

  await loadCourseData(slug);
  renderCatalogCourses();
};

// اشتراک‌گذاری مستقیم لینک درس در گروه‌های تلگرامی
window.shareCurrentCourse = function () {
  window.TMA.triggerHaptic('success');
  const slug = AppState.currentCourseSlug || 'sample_course';
  const courseTitle = AppState.course?.title || 'جزوه زنده شب امتحان';
  const shareUrl = `${window.location.origin}${window.location.pathname}?course=${encodeURIComponent(slug)}`;
  const shareText = `🎓 ${courseTitle}\nفرمول‌نامه کامل، فلش‌کارت لایتنر و شبیه‌ساز سوالات پایانترم با حل هوش مصنوعی:\n${shareUrl}`;

  if (window.navigator?.clipboard?.writeText) {
    window.navigator.clipboard.writeText(shareUrl).then(() => {
      alert(`✅ لینک مستقیم «${courseTitle}» در کلیپ‌بورد کپی شد!\nمی‌توانید در گروه‌های کلاسی تلگرام ارسال کنید.`);
    }).catch(() => {
      alert(shareText);
    });
  } else {
    alert(shareText);
  }
};

// نمایش راهنما و موجودی پنل جزوه‌نویسان
window.openCreatorInfoModal = function () {
  window.TMA.triggerHaptic('light');
  const bal = (AppState.creatorStats.balanceToman || 0).toLocaleString('fa-IR');
  const sales = (AppState.creatorStats.salesCount || 0).toLocaleString('fa-IR');

  alert(
    `💰 پنل درآمد جزوه‌نویسان برتر (سهم ۷۰٪):\n\n` +
    `📊 تعداد فروش پکیج‌های شما: ${sales} پکیج\n` +
    `💵 موجودی قابل تسویه: ${bal} تومان\n\n` +
    `✨ چگونه جزوه خود را اضافه کنید؟\n` +
    `کافی است فایل PDF جزوه دست‌نویس خود را در ربات تلگرام ارسال کنید؛ هوش مصنوعی آن را ظرف چند ثانیه به پکیج تعاملی تبدیل کرده و ۷۰٪ مبلغ هر خرید بلافاصله به کیف پول شما منظور می‌شود!`
  );
};

// Paywall Modal
window.openPaywallModal = function () {
  window.TMA.triggerHaptic('warning');
  updatePaywallModalPrices();
  document.getElementById('paywallBackdrop').classList.add('open');
};

window.closePaywallModal = function () {
  document.getElementById('paywallBackdrop').classList.remove('open');
};

window.simulateUnlockPurchase = async function (methodName) {
  window.TMA.triggerHaptic('success');
  AppState.isProUnlocked = true;
  window.TMA.saveProgress(`progress_${AppState.course?.id || 'sample_course'}`, {
    leitnerStatus: AppState.leitnerStatus,
    isProUnlocked: true
  });

  closePaywallModal();
  renderHeader();
  renderFlashcardView();
  renderExamQuiz();
  renderAiQuotaBadge();
  fetchCatalog();
  fetchCreatorStats();
  alert(`✅ پرداخت آزمایشی (${methodName}) تایید شد! تمام فلش‌کارت‌ها، سوالات امتحان و ۱۰۰ پرسش هوش مصنوعی باز شدند.`);
};

// Anti-Spam Verified Issue Reporting
let currentReportTarget = null;
let lastLocalReportTimestamp = 0;

window.openReportModal = function (itemId, fallbackText, fallbackPage) {
  window.TMA.triggerHaptic('light');
  const found = getItemById(itemId);
  const originalText = found ? found.originalText : (fallbackText || 'محتوای کارت');
  const sourcePage = found ? found.sourcePage : (fallbackPage || 1);
  const label = found ? found.label : originalText;

  currentReportTarget = { itemId, originalText, sourcePage };
  document.getElementById('reportItemMeta').textContent = `کارت انتخابی (صفحه ${sourcePage} جزوه): ${label.slice(0, 45)}...`;
  document.getElementById('reportClaimInput').value = '';
  document.getElementById('reportIssueBackdrop').classList.add('open');
};

window.closeReportModal = function () {
  document.getElementById('reportIssueBackdrop').classList.remove('open');
};

window.submitVerifiedReport = async function () {
  const claim = document.getElementById('reportClaimInput').value.trim();
  if (claim.length < 5) {
    alert('لطفاً توضیح دقیق‌تری درباره خطای علمی یا فرمولی بنویسید (حداقل ۵ حرف).');
    return;
  }

  // قفل ضداسپم سمت کلاینت (Cooldown 60s)
  const now = Date.now();
  if (now - lastLocalReportTimestamp < 60000) {
    const rem = Math.ceil((60000 - (now - lastLocalReportTimestamp)) / 1000);
    alert(`⏳ برای جلوگیری از اسپم، لطفاً ${rem} ثانیه دیگر مجدداً تلاش کنید.`);
    return;
  }

  const btn = document.getElementById('submitReportBtn');
  btn.disabled = true;
  btn.textContent = '⏳ در حال صحت‌سنجی توسط داور هوش مصنوعی...';

  const apiBase = getApiBase();

  try {
    const data = await api('/api/report-issue', {
      method: 'POST',
      body: JSON.stringify({
        courseId: AppState.course?.id || 'sample_course',
        itemId: currentReportTarget.itemId,
        originalText: currentReportTarget.originalText,
        userClaim: claim,
        sourcePage: currentReportTarget.sourcePage
      })
    });
    lastLocalReportTimestamp = Date.now();
    if (data && data.message) {
      alert(data.message);
    } else {
      alert(data && data.ok ? '✅ گزارش ثبت شد.' : 'خطا در ثبت گزارش.');
    }
    if (data && data.ok) closeReportModal();
  } catch (err) {
    lastLocalReportTimestamp = Date.now();
    alert(err?.message || 'خطا در ثبت گزارش.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'ارسال برای صحت‌سنجی هوشمند';
  }
};

// ===== Milestone 4: Visual Exam Solver (Image Upload) =====
async function compressImageFileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        const MAX = 1024;
        if (width > MAX || height > MAX) {
          if (width >= height) { height = Math.round(height * MAX / width); width = MAX; }
          else { width = Math.round(width * MAX / height); height = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        let quality = 0.75;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while (dataUrl.length > 500 * 1024 * 1.37 && quality > 0.3) {
          quality = Math.round((quality - 0.05) * 100) / 100;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(dataUrl.split(',')[1]);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleExamImageSelected(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const base64 = await compressImageFileToBase64(file);
    const box = document.getElementById('mainAiChatBox');
    if (box) {
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble user';
      bubble.textContent = '📷 تصویر سوال امتحانی ارسال شد';
      box.appendChild(bubble);
      box.scrollTop = box.scrollHeight;
    }
    await sendExamImageToSolver(base64);
  } catch (err) {
    alert('خطا در پردازش تصویر: ' + (err && err.message ? err.message : err));
  }
}

window.sendExamImageToSolver = async function (imageBase64) {
  if (!AppState.isProUnlocked && AppState.aiRemainingFree <= 0) { openPaywallModal(); return; }
  const box = document.getElementById('mainAiChatBox');
  const loadingId = 'loading_img_' + Date.now();
  if (box) {
    box.innerHTML += `<div class="chat-bubble ai" id="${loadingId}">در حال خواندن تصویر و حل سوال... ⏳</div>`;
    box.scrollTop = box.scrollHeight;
  }
  try {
    const data = await api('/api/ask-tutor', {
      method: 'POST',
      body: JSON.stringify({
        courseId: AppState.course?.id || 'sample_course',
        contextText: AppState.course?.title || '',
        question: 'صورت سوال امتحانی موجود در تصویر را با روش و فرمول‌های استاد حل کن.',
        presetKey: 'example',
        imageBase64
      })
    });
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();
    if (data.status === 402 || data?.quotaExceeded) { openPaywallModal(); return; }
    if (data.status === 429) { alert(data?.message || 'لطفاً چند ثانیه صبر کنید.'); return; }
    if (data.status === 503 || data.code === 'AI_UPSTREAM') {
      alert('سرویس هوش مصنوعی موقتاً در دسترس نیست. سهمیه شما کسر نشد.');
      return;
    }
    if (data && data.ok) {
      window.TMA.triggerHaptic('success');
      if (box) {
        box.innerHTML += `<div class="chat-bubble ai">${renderTextWithMath(data.reply)}</div>`;
        box.scrollTop = box.scrollHeight;
      }
      if (data.remainingAiQuota !== undefined) { AppState.aiRemainingFree = data.remainingAiQuota; renderAiQuotaBadge(); }
      return;
    }
    throw new Error(data?.message || 'Server error');
  } catch (err) {
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();
    if (err?.message && err.message !== 'Server error') {
      alert(err.message);
    }
  }
};

// ===== Milestone 4: Real Payment Gateway =====
window.startOnlinePayment = async function () {
  try {
    const data = await api('/api/payment/create', {
      method: 'POST',
      body: JSON.stringify({ courseId: AppState.currentCourseSlug })
    });
    if (data && data.paymentUrl) {
      window.location.href = data.paymentUrl;
      return;
    }
    if (data && data.simulated) {
      await simulateUnlockPurchase('درگاه بانکی شاپرک');
      return;
    }
    alert(data?.message || 'خطا در ایجاد پرداخت.');
  } catch (err) {
    alert(err?.message || 'خطا در اتصال به درگاه پرداخت.');
  }
};

// ===== Factory 2.0 Client Studio & Computer Vision =====

function computeLaplacianVariance(imageData) {
  const { width, height, data } = imageData;
  const gray = new Float32Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  let sum = 0;
  let count = 0;
  const laplacian = new Float32Array((width - 2) * (height - 2));
  let idx = 0;

  for (let y = 1; y < height - 1; y++) {
    const rowOffset = y * width;
    for (let x = 1; x < width - 1; x++) {
      const val =
        gray[rowOffset - width + x] +
        gray[rowOffset + width + x] +
        gray[rowOffset + x - 1] +
        gray[rowOffset + x + 1] -
        4 * gray[rowOffset + x];
      laplacian[idx++] = val;
      sum += val;
      count++;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  let varianceSum = 0;
  for (let i = 0; i < count; i++) {
    const diff = laplacian[i] - mean;
    varianceSum += diff * diff;
  }
  return varianceSum / count;
}

function computeMeanExposure(imageData) {
  const data = imageData.data;
  let sum = 0;
  const total = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return total ? (sum / total) : 128;
}

function computeDHash64(canvasOrImg) {
  const cvs = document.createElement('canvas');
  cvs.width = 9;
  cvs.height = 8;
  const ctx = cvs.getContext('2d');
  ctx.drawImage(canvasOrImg, 0, 0, 9, 8);
  const imgData = ctx.getImageData(0, 0, 9, 8).data;
  const gray = [];
  for (let i = 0; i < imgData.length; i += 4) {
    gray.push(0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2]);
  }
  let hex = '';
  for (let row = 0; row < 8; row++) {
    let byte = 0;
    for (let col = 0; col < 8; col++) {
      const left = gray[row * 9 + col];
      const right = gray[row * 9 + col + 1];
      if (left > right) {
        byte |= (1 << (7 - col));
      }
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

window.computeLaplacianVariance = computeLaplacianVariance;
window.computeMeanExposure = computeMeanExposure;
window.computeDHash64 = computeDHash64;

let factoryProcessedPages = [];
let activeFactoryJob = null;

window.openFactoryStudioModal = function () {
  const backdrop = document.getElementById('factoryStudioBackdrop');
  if (backdrop) backdrop.classList.add('open');
};

window.closeFactoryStudioModal = function () {
  const backdrop = document.getElementById('factoryStudioBackdrop');
  if (backdrop) backdrop.classList.remove('open');
};

window.handleFactoryFilesChange = async function (files) {
  if (!files || !files.length) return;
  const preview = document.getElementById('factoryPagesPreview');
  const processBtn = document.getElementById('factoryProcessBtn');
  if (preview) preview.innerHTML = '<div style="font-size:0.75rem; color:#94a3b8;">در حال ارزیابی کیفیت تصاویر جزوه... ⏳</div>';

  factoryProcessedPages = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const pageNum = i + 1;
    try {
      const pageData = await processPageFile(file, pageNum);
      factoryProcessedPages.push(pageData);
    } catch (err) {
      console.warn('Error processing page:', err);
    }
  }

  renderFactoryPagesPreview();
  if (processBtn) processBtn.style.display = factoryProcessedPages.length > 0 ? 'block' : 'none';
};

async function processPageFile(file, pageNum = 1) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = async () => {
        const maxEdge = 1600;
        let w = img.width;
        let h = img.height;
        if (w > maxEdge || h > maxEdge) {
          if (w > h) {
            h = Math.round((h * maxEdge) / w);
            w = maxEdge;
          } else {
            w = Math.round((w * maxEdge) / h);
            h = maxEdge;
          }
        }
        const cvs = document.createElement('canvas');
        cvs.width = w;
        cvs.height = h;
        const ctx = cvs.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        const imgData = ctx.getImageData(0, 0, w, h);
        const blurScore = computeLaplacianVariance(imgData);
        const exposureScore = computeMeanExposure(imgData);
        const dhash = computeDHash64(cvs);

        const dataUrl = cvs.toDataURL('image/jpeg', 0.85);

        // هش SHA-256
        let shaHex = '';
        try {
          const bin = atob(dataUrl.split(',')[1]);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          if (window.crypto?.subtle) {
            const hashBuf = await window.crypto.subtle.digest('SHA-256', arr);
            shaHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
          }
        } catch (_) {}
        if (!shaHex) shaHex = 'sha256_' + Math.random().toString(36).slice(2);

        const isAcceptable = blurScore >= 35 && exposureScore >= 20 && exposureScore <= 240;

        resolve({
          pageNum,
          blurScore: Math.round(blurScore * 10) / 10,
          exposureScore: Math.round(exposureScore * 10) / 10,
          dhash,
          imageSha256: shaHex,
          dataUrl,
          isAcceptable
        });
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

window.processPageFile = processPageFile;

function renderFactoryPagesPreview() {
  const container = document.getElementById('factoryPagesPreview');
  if (!container) return;

  if (!factoryProcessedPages.length) {
    container.innerHTML = '';
    return;
  }

  const hasFailingPage = factoryProcessedPages.some((p) => !p.isAcceptable);

  let warningHtml = '';
  if (hasFailingPage) {
    warningHtml = `
      <div style="background:rgba(239, 68, 68, 0.15); border:1px solid #ef4444; color:#fca5a5; padding:8px 10px; border-radius:8px; font-size:0.75rem; margin-bottom:8px;">
        ⚠️ برخی صفحات کیفیت لازم را ندارند (مات یا نور نامناسب). لطفاً صفحات مشخص‌شده را مجدداً عکاسی کنید.
      </div>
    `;
  }

  container.innerHTML = warningHtml + factoryProcessedPages.map((p) => {
    const blurBadge = p.blurScore >= 35
      ? `<span style="color:#34d399;">✅ وضوح مناسب (${p.blurScore})</span>`
      : `<span style="color:#f87171;">⚠️ مات (${p.blurScore} &lt; 35)</span>`;

    const expBadge = (p.exposureScore >= 20 && p.exposureScore <= 240)
      ? `<span style="color:#34d399;">✅ نور استاندارد (${p.exposureScore})</span>`
      : `<span style="color:#f87171;">⚠️ نور نامناسب (${p.exposureScore})</span>`;

    return `
      <div style="display:flex; align-items:center; gap:8px; padding:6px; background:#1e293b; border-radius:6px; margin-bottom:6px; border:1px solid ${p.isAcceptable ? '#334155' : '#ef4444'};">
        <img src="${p.dataUrl}" style="width:40px; height:40px; object-fit:cover; border-radius:4px;" />
        <div style="font-size:0.72rem; flex:1;">
          <strong>برگه ${p.pageNum}</strong>
          <div>${blurBadge} • ${expBadge}</div>
        </div>
      </div>
    `;
  }).join('');
}

window.submitFactoryJobFromUi = async function () {
  const title = (document.getElementById('factoryCourseTitle')?.value || '').trim();
  if (!title) {
    alert('لطفاً عنوان درس را وارد کنید.');
    return;
  }
  if (!factoryProcessedPages.length) {
    alert('لطفاً حداقل یک صفحه از جزوه را انتخاب کنید.');
    return;
  }

  const failing = factoryProcessedPages.filter((p) => !p.isAcceptable);
  if (failing.length > 0) {
    const pagesStr = failing.map((p) => p.pageNum).join('، ');
    alert(`کیفیت گیت کنترل رد شد: صفحه(های) ${pagesStr} مات یا دارای نور نامناسب هستند. لطفاً مجدداً عکس بگیرید.`);
    return;
  }

  const btn = document.getElementById('factoryProcessBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ در حال ترنسکریپشن ۴-پاس و اعتبارسنجی KaTeX...';
  }

  try {
    const data = await api('/api/factory/jobs', {
      method: 'POST',
      body: JSON.stringify({
        title,
        pages: factoryProcessedPages
      })
    });

    if (!data.ok) {
      if (data.code === 'DUPLICATE_SOURCE') {
        alert('⚠️ تصویر ارسالی قبلاً توسط جزوه‌نویس دیگری منتشر شده یا در دست بررسی است (نقض کپی‌رایت).');
        return;
      }
      if (data.code === 'QUALITY_GATE_FAILED') {
        alert(`کیفیت تصویر رد شد: صفحات ${(data.retakePages || []).join('، ')} نیاز به عکاسی مجدد دارند.`);
        return;
      }
      alert(data.message || 'خطا در ثبت و پردازش کارخانه.');
      return;
    }

    activeFactoryJob = {
      id: data.jobId,
      draft: data.draft,
      validationReport: data.validationReport
    };

    renderFactoryReviewSection();
  } catch (err) {
    alert(err?.message || 'خطا در پردازش جزوه.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚡ پردازش با پایپ‌لاین ۴-پاس هوش مصنوعی';
    }
  }
};

function renderFactoryReviewSection() {
  const uploadSec = document.getElementById('factoryUploadSection');
  const reviewSec = document.getElementById('factoryReviewSection');
  if (uploadSec) uploadSec.style.display = 'none';
  if (reviewSec) reviewSec.style.display = 'block';

  const draft = activeFactoryJob?.draft;
  const rep = activeFactoryJob?.validationReport;
  const summaryEl = document.getElementById('factoryGroundingSummary');

  if (summaryEl) {
    const flagged = rep?.flaggedCount || 0;
    if (flagged > 0) {
      summaryEl.innerHTML = `⚠️ <strong>توجه مؤلف:</strong> تعداد ${flagged} مورد نیازمند بازبینی تطابق عددی با دست‌نویس مشخص شده است. لطفاً کارت‌های نارنجی را بررسی و اصلاح کنید.`;
      summaryEl.style.color = '#fbbf24';
      summaryEl.style.borderColor = 'rgba(245, 158, 11, 0.4)';
    } else {
      summaryEl.innerHTML = `✅ <strong>همه کارت‌ها ۱۰۰٪ با دست‌نویس منبع تطابق دارند و فرمول‌ها در KaTeX تایید شدند.</strong> می‌توانید منتشر کنید.`;
      summaryEl.style.color = '#34d399';
      summaryEl.style.borderColor = 'rgba(52, 211, 153, 0.4)';
    }
  }

  const listEl = document.getElementById('factoryCardsReviewList');
  if (!listEl || !draft) return;

  const cardsHtml = (draft.flashcards || []).map((fc, idx) => {
    const isNeedsReview = Boolean(fc.needsReview);
    return `
      <div style="background:#1e293b; border:1px solid ${isNeedsReview ? '#f59e0b' : '#334155'}; border-radius:8px; padding:10px; margin-bottom:8px; cursor:pointer;" onclick="tapToFixCard(${idx}, 'flashcard')">
        <div style="display:flex; justify-content:space-between; font-size:0.72rem; color:#94a3b8; margin-bottom:4px;">
          <span>فلش‌کارت ${idx + 1} (صفحه ${fc.source_page || 1})</span>
          ${isNeedsReview ? '<span style="color:#fbbf24; font-weight:700;">⚠️ نیازمند بازبینی</span>' : '<span style="color:#34d399;">✅ تایید شده</span>'}
        </div>
        <div style="font-size:0.8rem; font-weight:600; margin-bottom:4px;">${renderTextWithMath(fc.front)}</div>
        <div style="font-size:0.76rem; color:#cbd5e1;">${renderTextWithMath(fc.back)}</div>
        ${fc.reviewReason ? `<div style="font-size:0.68rem; color:#fca5a5; margin-top:4px;">دلیل پرچم: ${escapeHtml(fc.reviewReason)}</div>` : ''}
        <div style="font-size:0.68rem; color:#38bdf8; margin-top:6px;">👆 برای ویرایش یا تغییر فرمول کلیک کنید (Tap-to-Fix)</div>
      </div>
    `;
  }).join('');

  listEl.innerHTML = cardsHtml;
}

window.tapToFixCard = function (idx, type) {
  if (!activeFactoryJob?.draft) return;
  const draft = activeFactoryJob.draft;
  if (type === 'flashcard') {
    const fc = draft.flashcards[idx];
    const newFront = prompt('ویرایش روی کارت (پرسش):', fc.front);
    if (newFront === null) return;
    const newBack = prompt('ویرایش پشت کارت (پاسخ تشریحی و فرمول):', fc.back);
    if (newBack === null) return;

    fc.front = newFront;
    fc.back = newBack;
    fc.needsReview = false;
    fc.reviewReason = '';
    renderFactoryReviewSection();
  }
};

window.publishCurrentFactoryJobFromUi = async function () {
  if (!activeFactoryJob?.id) return;
  const btn = document.getElementById('factoryPublishBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ در حال انتشار در کاتالوگ جزوات...';
  }

  try {
    const data = await api(`/api/factory/jobs/${activeFactoryJob.id}/publish`, {
      method: 'POST',
      body: JSON.stringify({ draft: activeFactoryJob.draft })
    });

    if (data && data.ok) {
      alert('🎉 جزوه شما با موفقیت تایید و در کاتالوگ عمومی منتشر شد!');
      closeFactoryStudioModal();
      await fetchCatalog();
      if (data.courseSlug) switchCourse(data.courseSlug);
    } else {
      alert(data?.message || 'خطا در انتشار جزوه.');
    }
  } catch (err) {
    alert(err?.message || 'خطا در ارتباط با سرور هنگام انتشار.');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🚀 تایید و انتشار نهایی در کاتالوگ جزوات';
    }
  }
};

// چک کردن پارامتر URL جهت باز شدن مستقیم پیش‌نویس برای بررسی (مانند لینک تلگرام)
window.checkUrlForFactoryReview = async function () {
  const urlParams = new URLSearchParams(window.location.search);
  const factoryJobId = urlParams.get('factoryJob');
  if (!factoryJobId) return;

  try {
    const data = await api(`/api/factory/jobs/${encodeURIComponent(factoryJobId)}`);
    if (data && data.ok && data.job) {
      activeFactoryJob = {
        id: data.job.id,
        draft: data.job.draft,
        validationReport: data.job.validationReport
      };
      openFactoryStudioModal();
      renderFactoryReviewSection();
    }
  } catch (_) {}
};

// ===== Milestone 10: Campus, Referrals, Panic Mode & Deep Links =====

let campusOptions = null;

window.openCampusModal = async function () {
  const backdrop = document.getElementById('campusModalBackdrop');
  if (backdrop) backdrop.classList.add('open');

  if (!campusOptions) {
    const data = await api('/api/campus/options');
    if (data && data.ok) {
      campusOptions = data;
      renderCampusSelects();
    }
  }

  const profileRes = await api('/api/campus/profile');
  if (profileRes && profileRes.ok && profileRes.profile) {
    const p = profileRes.profile;
    const uniSel = document.getElementById('campusUniSelect');
    const deptSel = document.getElementById('campusDeptSelect');
    const termSel = document.getElementById('campusTermSelect');
    if (uniSel && p.universityId) uniSel.value = p.universityId;
    if (deptSel && p.departmentId) deptSel.value = p.departmentId;
    if (termSel && p.term) termSel.value = String(p.term);
  }
};

window.closeCampusModal = function () {
  const backdrop = document.getElementById('campusModalBackdrop');
  if (backdrop) backdrop.classList.remove('open');
};

function renderCampusSelects() {
  if (!campusOptions) return;
  const uniSel = document.getElementById('campusUniSelect');
  const deptSel = document.getElementById('campusDeptSelect');

  if (uniSel) {
    uniSel.innerHTML = campusOptions.universities.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
  }
  if (deptSel) {
    deptSel.innerHTML = campusOptions.departments.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  }
}

window.submitCampusProfileFromUi = async function () {
  const universityId = document.getElementById('campusUniSelect')?.value;
  const departmentId = document.getElementById('campusDeptSelect')?.value;
  const term = Number(document.getElementById('campusTermSelect')?.value || 4);

  if (!universityId || !departmentId) {
    alert('لطفاً دانشگاه و رشته خود را انتخاب کنید.');
    return;
  }

  try {
    const data = await api('/api/campus/profile', {
      method: 'POST',
      body: JSON.stringify({ universityId, departmentId, term })
    });
    if (data && data.ok) {
      alert('✅ دانشگاه و رشته شما با موفقیت ثبت شد!');
      closeCampusModal();
      const label = document.getElementById('campusHeaderLabel');
      if (label) label.textContent = 'دانشکده من';
      await fetchCatalog();
    } else {
      alert(data?.message || 'خطا در ثبت مشخصات.');
    }
  } catch (err) {
    alert(err?.message || 'خطا در ثبت مشخصات دانشگاهی.');
  }
};

window.openReferralModal = async function () {
  const backdrop = document.getElementById('referralModalBackdrop');
  if (backdrop) backdrop.classList.add('open');
  const input = document.getElementById('referralShareInput');
  if (input) input.value = 'در حال تولید لینک دعوت... ⏳';

  try {
    const data = await api('/api/referral/code');
    if (data && data.ok && data.shareUrl) {
      if (input) input.value = data.shareUrl;
    } else {
      if (input) input.value = window.location.origin;
    }
  } catch (_) {
    if (input) input.value = window.location.origin;
  }
};

window.closeReferralModal = function () {
  const backdrop = document.getElementById('referralModalBackdrop');
  if (backdrop) backdrop.classList.remove('open');
};

window.copyReferralLink = function () {
  const input = document.getElementById('referralShareInput');
  if (!input || !input.value) return;

  if (window.navigator?.clipboard?.writeText) {
    window.navigator.clipboard.writeText(input.value).then(() => {
      alert('📋 لینک اختصاصی دعوت کپی شد! می‌توانید در گروه‌های درسی تلگرام بفرستید.');
    }).catch(() => {
      input.select();
      document.execCommand('copy');
      alert('📋 لینک دعوت کپی شد.');
    });
  } else {
    input.select();
    document.execCommand('copy');
    alert('📋 لینک دعوت کپی شد.');
  }
};

window.openExamPanicModal = async function () {
  const backdrop = document.getElementById('examPanicModalBackdrop');
  if (backdrop) backdrop.classList.add('open');
  await refreshExamPanicPlan();
};

window.closeExamPanicModal = function () {
  const backdrop = document.getElementById('examPanicModalBackdrop');
  if (backdrop) backdrop.classList.remove('open');
};

async function refreshExamPanicPlan() {
  const container = document.getElementById('examPanicPlanContainer');
  const countdownLabel = document.getElementById('examCountdownLabel');
  const courseId = AppState.course?.id || AppState.currentCourseSlug || 'sample_course';

  if (container) container.innerHTML = '<div style="font-size:0.75rem; color:#94a3b8; padding:12px;">در حال بارگذاری برنامه اسپرینت‌های شب امتحان... ⏳</div>';

  try {
    const data = await api(`/api/course/exam-plan?courseId=${encodeURIComponent(courseId)}`);
    if (data && data.ok) {
      if (data.panicMode) {
        if (countdownLabel) countdownLabel.textContent = `🔥 کمتر از ${data.hoursRemaining} ساعت تا امتحان مانده است! (حالت اضطراری فعال)`;
      } else if (data.hasExam) {
        if (countdownLabel) countdownLabel.textContent = `⏰ ${data.hoursRemaining} ساعت تا امتحان باقی‌مانده است.`;
      } else {
        if (countdownLabel) countdownLabel.textContent = 'تاریخ امتحان ثبت نشده است. لطفاً تاریخ امتحان را وارد کنید.';
      }

      if (data.plan && data.plan.length > 0) {
        container.innerHTML = data.plan.map((sprint) => `
          <div style="background:#1e293b; border:1px solid #334155; border-radius:8px; padding:10px; margin-bottom:8px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
              <strong style="color:#38bdf8; font-size:0.8rem;">${escapeHtml(sprint.title)}</strong>
              <span style="font-size:0.68rem; color:#fbbf24; background:rgba(245, 158, 11, 0.15); padding:2px 6px; border-radius:4px;">⏱️ ${sprint.durationMinutes} دقیقه</span>
            </div>
            <div style="font-size:0.72rem; color:#cbd5e1; margin-bottom:4px;">
              🗂️ <strong>کارت‌های این اسپرینت:</strong> ${sprint.cards.length} کارت (${sprint.cards.map(c => `صفحه ${c.page || 1}`).join('، ')})
            </div>
            ${sprint.formulas && sprint.formulas.length ? `
              <div style="font-size:0.72rem; color:#cbd5e1;">
                📑 <strong>فرمول‌های کلیدی:</strong> ${sprint.formulas.map(f => f.topic).join(' • ')}
              </div>
            ` : ''}
          </div>
        `).join('');
      } else {
        container.innerHTML = '<div style="font-size:0.75rem; color:#94a3b8; padding:12px;">کارت ضعیفی یافت نشد یا برنامه آماده نیست.</div>';
      }
    }
  } catch (err) {
    if (container) container.innerHTML = `<div style="font-size:0.75rem; color:#f87171; padding:12px;">خطا: ${escapeHtml(err.message)}</div>`;
  }
}

window.saveExamDateFromUi = async function () {
  const dtInput = document.getElementById('examDateTimeInput');
  if (!dtInput || !dtInput.value) {
    alert('لطفاً تاریخ و ساعت امتحان را انتخاب کنید.');
    return;
  }

  const examTimestamp = new Date(dtInput.value).getTime();
  if (!Number.isFinite(examTimestamp) || examTimestamp <= Date.now()) {
    alert('تاریخ امتحان باید در آینده باشد.');
    return;
  }

  const courseId = AppState.course?.id || AppState.currentCourseSlug || 'sample_course';
  try {
    const data = await api('/api/course/exam-date', {
      method: 'POST',
      body: JSON.stringify({ courseId, examAt: examTimestamp })
    });
    if (data && data.ok) {
      alert('✅ زمان امتحان ثبت شد و اسپرینت‌های فشرده پومودورو تنظیم گردید.');
      await refreshExamPanicPlan();
    } else {
      alert(data?.message || 'خطا در ثبت تاریخ امتحان.');
    }
  } catch (err) {
    alert(err?.message || 'خطا در ثبت تاریخ امتحان.');
  }
};

window.checkDeepLinkNavigation = async function () {
  const urlParams = new URLSearchParams(window.location.search);
  let startParam = urlParams.get('tgWebAppStartParam') || urlParams.get('startapp') || urlParams.get('card') || '';
  if (!startParam && window.Telegram?.WebApp?.initDataUnsafe?.start_param) {
    startParam = window.Telegram.WebApp.initDataUnsafe.start_param;
  }

  if (startParam && startParam.startsWith('card_')) {
    const match = startParam.match(/^card_([a-zA-Z0-9_\-]+)_([a-zA-Z0-9_\-]+)$/);
    if (match) {
      const courseId = match[1];
      const targetCardId = match[2];

      if (AppState.currentCourseSlug !== courseId) {
        await switchCourse(courseId);
      }

      const flashcardTabBtn = document.querySelector('[data-tab="tabFlashcards"]');
      if (flashcardTabBtn) flashcardTabBtn.click();

      const deck = getFilteredCards();
      const targetIdx = deck.findIndex(c => c.id === targetCardId || String(c.id).includes(targetCardId));
      if (targetIdx !== -1) {
        AppState.currentCardIndex = targetIdx;
        renderFlashcardView();
      }
    }
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('examImageInput');
  if (inp) inp.addEventListener('change', handleExamImageSelected);
  setTimeout(() => window.checkUrlForFactoryReview(), 500);
  setTimeout(() => window.checkDeepLinkNavigation(), 400);
});

document.addEventListener('DOMContentLoaded', initStudyPlayer);
