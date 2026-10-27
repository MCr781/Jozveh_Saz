const AppState = {
  course: null,
  currentCardIndex: 0,
  cardFilter: 'all', // 'all' | 'review'
  leitnerStatus: {}, // { fc_1: 'known' | 'review' }
  quizAnswers: {},
  isProUnlocked: false,
  aiRemainingFree: 3,
  activeContextItem: null
};

// Helper: Determine API base URL (supports direct server access & Live Server port 5500)
function getApiBase() {
  if (window.location.port === '5500' || window.location.protocol === 'file:') {
    return 'http://localhost:3000';
  }
  return '';
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
      return `<code dir="ltr">${clean}</code>`;
    }
  }
  return `<code dir="ltr">${clean}</code>`;
}

function renderTextWithMath(text) {
  if (!text) return '';
  let processed = sanitizeLatex(text);

  // Block math $$...$$
  processed = processed.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    return renderLatexExpression(math.trim(), true);
  });

  // Inline math $...$
  processed = processed.replace(/\$([^\$]+?)\$/g, (_, math) => {
    return renderLatexExpression(math.trim(), false);
  });

  return processed.replace(/\n/g, '<br>');
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

async function initStudyPlayer() {
  window.TMA.initApp();

  const urlParams = new URLSearchParams(window.location.search);
  const courseSlug = urlParams.get('course') || 'sample_course';
  const apiBase = getApiBase();

  try {
    // تلاش اول: دریافت امن از سرور همراه با بررسی وضعیت خرید و سهمیه واقعی
    const apiRes = await fetch(`${apiBase}/api/course?id=${encodeURIComponent(courseSlug)}`, {
      headers: { 'X-Telegram-Init-Data': window.TMA.tg?.initData || '' }
    });
    if (!apiRes.ok) throw new Error('API course load failed');
    const payload = await apiRes.json();
    if (!payload.ok) throw new Error(payload.message || 'API failed');

    AppState.course = payload.course;
    AppState.isProUnlocked = Boolean(payload.isProUnlocked);
    AppState.aiRemainingFree = payload.remainingAiQuota !== undefined ? payload.remainingAiQuota : 3;
  } catch (_) {
    // تلاش دوم (Fallback مخصوص تست آفلاین / VS Code Live Server): خواندن فایل لوکال
    const res = await fetch(`./data/${courseSlug}.json`);
    AppState.course = await res.json();
    AppState.aiRemainingFree = AppState.course.ai_quota_free || 3;
  }

  window.TMA.loadProgress(`progress_${AppState.course.id}`, (saved) => {
    AppState.leitnerStatus = saved.leitnerStatus || {};
    if (saved.isProUnlocked) AppState.isProUnlocked = true;
    renderHeader();
    renderCheatSheet();
    renderFlashcardView();
    renderExamQuiz();
    renderAiQuotaBadge();
  });

  setupTabSwitching();
  setupKeyboardShortcuts();
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

  chatBox.innerHTML += `<div class="chat-bubble user">${userMsg}</div>`;
  chatBox.scrollTop = chatBox.scrollHeight;

  const loadingId = 'loading_ctx_' + Date.now();
  chatBox.innerHTML += `<div class="chat-bubble ai" id="${loadingId}">در حال پردازش بر اساس جزوه استاد... ⏳</div>`;
  chatBox.scrollTop = chatBox.scrollHeight;

  const apiBase = getApiBase();
  const contextDesc = AppState.activeContextItem
    ? `صفحه ${AppState.activeContextItem.sourcePage}: ${AppState.activeContextItem.originalText}`
    : (AppState.course?.title || '');

  try {
    const res = await fetch(`${apiBase}/api/ask-tutor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': window.TMA.tg?.initData || ''
      },
      body: JSON.stringify({
        courseId: AppState.course?.id || 'sample_course',
        contextText: contextDesc,
        question: userMsg,
        presetKey
      })
    });

    const data = await res.json().catch(() => null);
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();

    if (res.status === 402 || data?.quotaExceeded) {
      closeContextualDrawer();
      openPaywallModal();
      return;
    }

    if (res.status === 429) {
      alert(data?.message || 'لطفاً چند ثانیه صبر کنید.');
      return;
    }

    if (res.ok && data?.ok) {
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
  } catch (_) {
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();

    // Fallback محلی به sample_ai_responses
    const responses = AppState.course?.sample_ai_responses || {};
    const replyRaw = responses[presetKey] || responses.default || 'به رابطه مستقیم متغیرها در فرمول اصلی دقت فرمایید.';
    window.TMA.triggerHaptic('success');
    chatBox.innerHTML += `<div class="chat-bubble ai">${renderTextWithMath(replyRaw)}</div>`;
    chatBox.scrollTop = chatBox.scrollHeight;

    if (!AppState.isProUnlocked) {
      AppState.aiRemainingFree = Math.max(0, AppState.aiRemainingFree - 1);
      renderAiQuotaBadge();
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

  box.innerHTML += `<div class="chat-bubble user">${question}</div>`;
  box.scrollTop = box.scrollHeight;

  const loadingId = 'loading_main_' + Date.now();
  box.innerHTML += `<div class="chat-bubble ai" id="${loadingId}">در حال حل با روش و فرمول‌های استاد... ⏳</div>`;
  box.scrollTop = box.scrollHeight;

  const apiBase = getApiBase();

  try {
    const res = await fetch(`${apiBase}/api/ask-tutor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': window.TMA.tg?.initData || ''
      },
      body: JSON.stringify({
        courseId: AppState.course?.id || 'sample_course',
        contextText: AppState.course?.title || '',
        question,
        presetKey
      })
    });

    const data = await res.json().catch(() => null);
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();

    if (res.status === 402 || data?.quotaExceeded) {
      openPaywallModal();
      return;
    }

    if (res.status === 429) {
      alert(data?.message || 'لطفاً چند ثانیه صبر کنید.');
      return;
    }

    if (res.ok && data?.ok) {
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
  } catch (_) {
    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) loadingEl.remove();

    // Fallback محلی به sample_ai_responses
    const responses = AppState.course?.sample_ai_responses || {};
    const answer = responses[presetKey] || responses.default || 'بر اساس جزوه کلاسی، متغیرها را بر حسب واحدهای استاندارد SI بازنویسی کنید.';
    window.TMA.triggerHaptic('success');
    box.innerHTML += `<div class="chat-bubble ai">${renderTextWithMath(answer)}</div>`;
    box.scrollTop = box.scrollHeight;

    if (!AppState.isProUnlocked) {
      AppState.aiRemainingFree = Math.max(0, AppState.aiRemainingFree - 1);
      renderAiQuotaBadge();
    }
  }
};

// Paywall Modal
window.openPaywallModal = function () {
  window.TMA.triggerHaptic('warning');
  document.getElementById('paywallBackdrop').classList.add('open');
};

window.closePaywallModal = function () {
  document.getElementById('paywallBackdrop').classList.remove('open');
};

window.simulateUnlockPurchase = function (methodName) {
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
    const res = await fetch(`${apiBase}/api/report-issue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': window.TMA.tg?.initData || ''
      },
      body: JSON.stringify({
        courseId: AppState.course?.id || 'sample_course',
        itemId: currentReportTarget.itemId,
        originalText: currentReportTarget.originalText,
        userClaim: claim,
        sourcePage: currentReportTarget.sourcePage
      })
    });
    const data = await res.json().catch(() => null);
    lastLocalReportTimestamp = Date.now();
    if (data && data.message) {
      alert(data.message);
    } else {
      alert(res.ok ? '✅ گزارش ثبت شد.' : 'خطا در ثبت گزارش.');
    }
    if (data && data.ok) closeReportModal();
  } catch (_) {
    // Fallback در صورتی که فقط با Live Server تست می‌کنی و سرور پورت 3000 روشن نیست
    lastLocalReportTimestamp = Date.now();
    window.TMA.triggerHaptic('success');
    alert('✅ [حالت دمو] گزارش شما ثبت و برای داور هوش مصنوعی ارسال شد! پس از تایید صحت علمی، ۲ سهمیه پرسش رایگان به حساب شما اضافه خواهد شد.');
    closeReportModal();
  } finally {
    btn.disabled = false;
    btn.textContent = 'ارسال برای صحت‌سنجی هوشمند';
  }
};

document.addEventListener('DOMContentLoaded', initStudyPlayer);
