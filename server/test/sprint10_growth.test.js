// server/test/sprint10_growth.test.js
// Acceptance test suite for Sprint 10 (Milestone 10: Viral Campus Distribution & Growth)
// 1. Story S10-0: Gemini 3.8 Flash Upgrade & Smart Fallback
// 2. Story S10-1: Tamper-Proof Referral Engine & Burner Anti-Farming
// 3. Story S10-2: 2-Tap University/Department Onboarding & Catalog Ranking
// 4. Story S10-3: Server-Side Streaks (UTC+03:30), Exam-Eve Panic Mode & Card Deep-Links
// 5. Story S10-4: Token-Bucket Channel Broadcast Worker & 403/429 Resilience

import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const testToken = '123456:SPRINT10-TEST-TOKEN';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint10-test-'));
const testDbPath = path.join(tmpDir, 'sprint10_test.db');

process.env.BOT_TOKEN = testToken;
process.env.STATE_DB_PATH = testDbPath;
process.env.PORT = '0';
process.env.ADMIN_CHAT_ID = '999999';
// Ensure key is available dynamically for CI runs without .env
process.env.GEMINI_API_KEY_1 = process.env.GEMINI_API_KEY_1 || 'test-ci-gemini-key';

const {
  server,
  db,
  growthRepo,
  recordCourseSale,
  callGeminiGenerateContent,
  synthesizeGroundedTutorAnswer,
  chunkTextForSse,
  resetFallbackStateForTests,
  isModelExhausted,
  markModelExhausted,
  isAdminUser
} = await import('../server.js');

const { config } = await import('../config.js');
const { mintInitData } = await import('../../scripts/dev_initdata.js');

let baseUrl = '';

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
});

describe('Story S10-0: Production Gemini 3.8 Flash Upgrade & Fallback', () => {
  it('defaults GEMINI_MODEL to gemini-3.8-flash in config', () => {
    assert.equal(config.geminiModel, 'gemini-3.8-flash');
  });

  it('maxOutputTokens defaults to 900 for fast latency without triggering timeouts', async () => {
    const originalFetch = global.fetch;
    let sentGenConfig = null;

    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      sentGenConfig = body.generationConfig;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'فرمول $r^{*} = \\frac{2\\gamma}{\\Delta G_v}$' }] } }]
        })
      };
    };

    try {
      const res = await callGeminiGenerateContent({
        apiKey: 'test-api-key',
        model: 'gemini-3.8-flash',
        payload: { contents: [{ parts: [{ text: 'شعاع بحرانی چیست؟' }] }] },
        timeoutMs: 1000
      });
      assert.equal(sentGenConfig.maxOutputTokens, 900);
      assert.equal(sentGenConfig.temperature, 0.2);
      assert.equal(sentGenConfig.topP, 0.95);
      assert.equal(sentGenConfig.thinkingConfig, undefined);
      assert.ok(res.includes('$r^{*} ='));
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('automatic retry succeeds when upstream returns a transient 503 High Demand on attempt 1 and 200 on attempt 2', async () => {
    const originalFetch = global.fetch;
    const prevDelay = process.env.GEMINI_RETRY_DELAY_MS;
    process.env.GEMINI_RETRY_DELAY_MS = '10'; // Fast retry for unit tests
    let attemptCount = 0;

    global.fetch = async (url, opts) => {
      attemptCount++;
      if (attemptCount === 1) {
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: async () => ({
            error: {
              code: 503,
              message: 'This model is currently experiencing high demand. Please try again later.'
            }
          })
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'پاسخ موفق پس از تلاش مجدد' }] } }]
        })
      };
    };

    try {
      const res = await callGeminiGenerateContent({
        apiKey: 'test-api-key',
        model: 'gemini-3.8-flash',
        payload: { contents: [{ parts: [{ text: 'تست تاب‌آوری' }] }] },
        timeoutMs: 2000
      });
      assert.equal(attemptCount, 2, 'Should succeed on attempt 2');
      assert.equal(res, 'پاسخ موفق پس از تلاش مجدد');
    } finally {
      global.fetch = originalFetch;
      if (prevDelay !== undefined) process.env.GEMINI_RETRY_DELAY_MS = prevDelay;
      else delete process.env.GEMINI_RETRY_DELAY_MS;
    }
  });

  it('POST /api/ask-tutor with stream: true streams SSE chunks and deducts quota once', async () => {
    const studentId = 777333;
    const studentAuth = mintInitData({ id: studentId, first_name: 'StreamStudent' }, testToken);
    const originalFetch = global.fetch;

    global.fetch = async (url, opts) => {
      if (String(url).includes('streamGenerateContent')) {
        const chunks = [
          'data: {"candidates": [{"content": {"parts": [{"text": "پاسخ "}]}}]}\n\n',
          'data: {"candidates": [{"content": {"parts": [{"text": "گام به گام $r^{*} = 5$ "}]}}]}\n\n',
          'data: [DONE]\n\n'
        ];
        const stream = new ReadableStream({
          start(controller) {
            for (const c of chunks) {
              controller.enqueue(new TextEncoder().encode(c));
            }
            controller.close();
          }
        });
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'Content-Type': 'text/event-stream' }),
          body: stream
        };
      }
      return originalFetch(url, opts);
    };

    try {
      const res = await fetch(`${baseUrl}/api/ask-tutor`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'X-Telegram-Init-Data': studentAuth
        },
        body: JSON.stringify({
          courseId: 'sample_course',
          contextText: 'شعاع بحرانی جوانه زنی',
          question: 'فرمول شعاع بحرانی چیست؟',
          stream: true
        })
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));

      const bodyText = await res.text();
      assert.ok(bodyText.includes('data: {"chunk":"پاسخ "}'));
      assert.ok(bodyText.includes('data: {"chunk":"گام به گام $r^{*} = 5$ "}'));
      assert.ok(bodyText.includes('data: [DONE]'));

      const { aiRepo } = await import('../server.js');
      const usage = aiRepo.getAiUsage(db, String(studentId), 'sample_course');
      assert.equal(usage.queriesCount, 1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('POST /api/ask-tutor falls back to word-chunked SSE when native stream fails', async () => {
    const studentId = 777444;
    const studentAuth = mintInitData({ id: studentId, first_name: 'FallbackStudent' }, testToken);
    const originalFetch = global.fetch;

    global.fetch = async (url, opts) => {
      if (String(url).includes('streamGenerateContent')) {
        // Simulate native stream failure with 503
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: async () => ({ error: { message: 'High demand' } })
        };
      }
      if (String(url).includes('generateContent')) {
        // Fallback non-streaming generateContent succeeds
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [{ text: 'پاسخ رفیق شب امتحان با رابطه $W = 100 J$ در فشار ثابت' }]
                }
              }
            ]
          })
        };
      }
      return originalFetch(url, opts);
    };

    try {
      const res = await fetch(`${baseUrl}/api/ask-tutor`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'X-Telegram-Init-Data': studentAuth
        },
        body: JSON.stringify({
          courseId: 'sample_course',
          contextText: 'محاسبه کار انبساط',
          question: 'کار چگونه محاسبه می شود؟',
          stream: true
        })
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));
      assert.equal(res.headers.get('x-accel-buffering'), 'no');

      const bodyText = await res.text();
      assert.ok(bodyText.includes('data: {"chunk":'));
      assert.ok(bodyText.includes('[DONE]'));

      // Quota deducted once
      const { aiRepo } = await import('../server.js');
      const usage = aiRepo.getAiUsage(db, String(studentId), 'sample_course');
      assert.equal(usage.queriesCount, 1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('POST /api/ask-tutor streams course-grounded fallback with zero quota deduction when upstream is completely unavailable', async () => {
    const studentId = 777555;
    const studentAuth = mintInitData({ id: studentId, first_name: 'OutageStudent' }, testToken);
    const originalFetch = global.fetch;

    // Both streamGenerateContent and generateContent fail (simulating complete Google 503 outage)
    global.fetch = async (url, opts) => {
      if (String(url).includes('streamGenerateContent') || String(url).includes('generateContent')) {
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: async () => ({ error: { message: 'The model is overloaded. Please try again later.' } })
        };
      }
      return originalFetch(url, opts);
    };

    try {
      const res = await fetch(`${baseUrl}/api/ask-tutor`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'X-Telegram-Init-Data': studentAuth
        },
        body: JSON.stringify({
          courseId: 'sample_course',
          contextText: 'صفحه ۳: محاسبه کار در فرآیند هم‌فشار با رابطه $W = P \\Delta V$ انجام می‌شود.',
          question: 'لطفاً یک مثال عددی از محاسبه کار با فرمول بزنید.',
          stream: true
        })
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));
      assert.equal(res.headers.get('x-accel-buffering'), 'no');

      const bodyText = await res.text();
      assert.ok(bodyText.includes(': stream-open'));
      assert.ok(bodyText.includes('data: {"chunk":'));
      assert.ok(bodyText.includes('[DONE]'));

      // Reconstruct streamed chunks
      const chunks = [];
      for (const line of bodyText.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:') && !trimmed.includes('[DONE]')) {
          try {
            const parsed = JSON.parse(trimmed.slice(5));
            if (parsed.chunk) chunks.push(parsed.chunk);
          } catch (_) {}
        }
      }
      const reconstructed = chunks.join('');
      assert.ok(reconstructed.includes('$W = P \\Delta V$'));
      assert.ok(reconstructed.includes('توضیح ساده و خودمانی'));
      assert.ok(reconstructed.includes('رابطه و کاربرد امتحانی'));
      assert.ok(reconstructed.includes('دام تستی و نکته کلیدی استاد'));

      // ZERO quota deduction on upstream outage
      const { aiRepo } = await import('../server.js');
      const usage = aiRepo.getAiUsage(db, String(studentId), 'sample_course');
      assert.equal(usage.queriesCount, 0, 'Quota must NOT be deducted when upstream fails and smart fallback is served');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('synthesizeGroundedTutorAnswer formats structured 3-part study guide with intact formulas', () => {
    const res = synthesizeGroundedTutorAnswer({
      question: 'دام تستی این فرمول چیست؟',
      contextText: 'ترمودینامیک: کار فرآیند انبساط $W = \\int P dV$ و گرما $Q = m c \\Delta T$ است.'
    });

    assert.ok(res.includes('💡 **تحلیل مستند به جزوه استاد:**'));
    assert.ok(res.includes('**۱. توضیح ساده و خودمانی نکته:**'));
    assert.ok(res.includes('**۲. رابطه و کاربرد امتحانی:**'));
    assert.ok(res.includes('**۳. دام تستی و نکته کلیدی استاد:**'));
    assert.ok(res.includes('$W = \\int P dV$'));
    assert.ok(res.includes('$Q = m c \\Delta T$'));
    assert.ok(res.includes('سهمیه روزانه کلید رایگان گوگل تکمیل شده است'));
  });

  it('synthesizeGroundedTutorAnswer preserves parenthesized titles and formats structured card context without robotic filler', () => {
    const res = synthesizeGroundedTutorAnswer({
      question: 'نقطه یوتکتوئید چیست؟',
      contextText: [
        'در دیاگرام فازی آهن-سمانتیت (Fe3C)، نقطه یوتکتوئید در غلظت 0.77 درصد وزنی کربن رخ می‌دهد.',
        'فرمول: $\\gamma \\rightarrow \\alpha + Fe_3C$',
        'نکته استاد: فاز فریت و سمانتیت به صورت لایه‌ای تشکیل می‌شوند.'
      ].join('\n')
    });

    assert.ok(res.includes('در دیاگرام فازی آهن-سمانتیت (Fe3C)'), 'Must not truncate titles at (');
    assert.ok(res.includes('$\\gamma \\rightarrow \\alpha + Fe_3C$'), 'Formula must be preserved intact');
    assert.ok(res.includes('فاز فریت و سمانتیت به صورت لایه‌ای تشکیل می‌شوند.'), 'Tip must be cleanly rendered');
    assert.ok(!res.includes('تغییرات در متغیرهای سیستم، مستقیماً طبق قوانین'), 'Robotic filler must be completely purged');
    assert.ok(!res.includes('دام تستی و نکته کلیدی استاد: دام تستی'), 'Duplicate prefixes must be purged');
  });

  it('chunkTextForSse reconstructs the exact original string with spaces, newlines, and formulas 100% intact', () => {
    const originalText = `💡 **تحلیل مستند به جزوه استاد:**\n\n` +
      `**۱. توضیح ساده و خودمانی نکته:**\n\nبرای درک رابطه $dH = dU + PdV + VdP$ در آنتالپی، به تغییرات فشار توجه کنید.\n\n` +
      `**۲. رابطه و کاربرد امتحانی:**\n\n$$W = \\int_{V_1}^{V_2} P \\, dV$$\n\n` +
      `**۳. دام تستی و نکته کلیدی استاد:**\n\nعلامت منفی را در انبساط فراموش نکنید!`;

    const chunks = chunkTextForSse(originalText);
    assert.ok(chunks.length > 3, 'Should produce multiple chunks for smooth streaming');

    // 1. Exact string reconstruction
    const joined = chunks.join('');
    assert.strictEqual(joined, originalText, 'Reconstructed chunks must exactly match original string without duplicate letters or lost spaces');

    // 2. Math blocks must not be cut across chunks
    assert.ok(chunks.some((c) => c.includes('$dH = dU + PdV + VdP$')), 'Inline math block must be contained whole inside a single chunk');
    assert.ok(chunks.some((c) => c.includes('$$W = \\int_{V_1}^{V_2} P \\, dV$$')), 'Block math must be contained whole inside a single chunk');
  });

  it('callGeminiGenerateContent cascades to gemini-3.5-flash-lite on 429 and caches cooldown', async () => {
    resetFallbackStateForTests();
    const originalFetch = global.fetch;
    const requestedModels = [];

    global.fetch = async (url, opts) => {
      const match = String(url).match(/models\/([^:]+):generateContent/);
      const targetModel = match ? match[1] : '';
      requestedModels.push(targetModel);

      if (targetModel === 'gemini-3.8-flash') {
        // First model hits quota
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          json: async () => ({
            error: {
              code: 429,
              message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash'
            }
          })
        };
      }

      // Cascaded fallback model succeeds
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: `پاسخ از مدل آبشاری ${targetModel}` }] } }]
        })
      };
    };

    try {
      const res = await callGeminiGenerateContent({
        apiKey: 'test-api-key',
        model: 'gemini-3.8-flash',
        payload: { contents: [{ parts: [{ text: 'تست کسکید' }] }] },
        timeoutMs: 2000
      });

      assert.ok(requestedModels.includes('gemini-3.8-flash'));
      assert.ok(requestedModels.includes('gemini-3.5-flash-lite'));
      assert.strictEqual(res, 'پاسخ از مدل آبشاری gemini-3.5-flash-lite');
      assert.ok(isModelExhausted('gemini-3.8-flash'), 'gemini-3.8-flash must be marked exhausted for cooldown');

      // Subsequent call skips exhausted model directly without network attempt
      requestedModels.length = 0;
      const res2 = await callGeminiGenerateContent({
        apiKey: 'test-api-key',
        model: 'gemini-3.8-flash',
        payload: { contents: [{ parts: [{ text: 'تست کش' }] }] },
        timeoutMs: 2000
      });

      assert.ok(!requestedModels.includes('gemini-3.8-flash'), 'Should skip gemini-3.8-flash while in cooldown');
      assert.ok(requestedModels.includes('gemini-3.5-flash-lite'));
      assert.strictEqual(res2, 'پاسخ از مدل آبشاری gemini-3.5-flash-lite');
    } finally {
      global.fetch = originalFetch;
      resetFallbackStateForTests();
    }
  });

  it('exhausting a model on Key 1 does NOT mark that model exhausted for Key 2 (AQ. key format supported)', async () => {
    resetFallbackStateForTests();
    const key1 = 'AQ.Key1_Alpha1111';
    const key2 = 'AQ.Key2_Beta2222';

    // Mark model exhausted on key 1
    markModelExhausted('gemini-3.8-flash', 60000, key1);

    // Key 1 is exhausted
    assert.strictEqual(isModelExhausted('gemini-3.8-flash', key1), true);

    // Key 2 is NOT exhausted
    assert.strictEqual(isModelExhausted('gemini-3.8-flash', key2), false);

    // Backward-compatible 1-arg check detects that model is exhausted under at least one key
    assert.strictEqual(isModelExhausted('gemini-3.8-flash'), true);

    // Test with callGeminiGenerateContent
    const originalFetch = global.fetch;
    const requestedModels = [];

    global.fetch = async (url, opts) => {
      const match = String(url).match(/models\/([^:]+):generateContent/);
      const targetModel = match ? match[1] : '';
      const keyHeader = opts?.headers?.['x-goog-api-key'];
      requestedModels.push({ targetModel, keyHeader });

      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: `پاسخ از ${targetModel}` }] } }]
        })
      };
    };

    try {
      // Calling with key1 should skip gemini-3.8-flash and request gemini-3.5-flash-lite
      requestedModels.length = 0;
      await callGeminiGenerateContent({
        apiKey: key1,
        model: 'gemini-3.8-flash',
        payload: { contents: [{ parts: [{ text: 'تست کلید ۱' }] }] },
        timeoutMs: 2000
      });
      assert.strictEqual(requestedModels[0].targetModel, 'gemini-3.5-flash-lite');

      // Calling with key2 should use gemini-3.8-flash directly!
      requestedModels.length = 0;
      await callGeminiGenerateContent({
        apiKey: key2,
        model: 'gemini-3.8-flash',
        payload: { contents: [{ parts: [{ text: 'تست کلید ۲' }] }] },
        timeoutMs: 2000
      });
      assert.strictEqual(requestedModels[0].targetModel, 'gemini-3.8-flash');
      assert.strictEqual(requestedModels[0].keyHeader, key2);
    } finally {
      global.fetch = originalFetch;
      resetFallbackStateForTests();
    }
  });

  it('isAdminUser grants unlimited AI quota and unlocked course access to ADMIN_CHAT_ID while restricting normal users', async () => {
    const adminId = 999999;
    const regularId = 777123;
    const adminAuth = mintInitData({ id: adminId, first_name: 'SuperAdmin' }, testToken);
    const regularAuth = mintInitData({ id: regularId, first_name: 'RegularStudent' }, testToken);

    // 1. Check helper
    assert.strictEqual(isAdminUser(adminId), true);
    assert.strictEqual(isAdminUser(String(adminId)), true);
    assert.strictEqual(isAdminUser(regularId), false);
    assert.strictEqual(isAdminUser(undefined), false);

    // Test ADMIN_TELEGRAM_IDS support
    const prevIds = process.env.ADMIN_TELEGRAM_IDS;
    process.env.ADMIN_TELEGRAM_IDS = '12345,67890';
    assert.strictEqual(isAdminUser('12345'), true);
    assert.strictEqual(isAdminUser('67890'), true);
    assert.strictEqual(isAdminUser('99999'), false);
    if (prevIds !== undefined) process.env.ADMIN_TELEGRAM_IDS = prevIds;
    else delete process.env.ADMIN_TELEGRAM_IDS;

    // 2. GET /api/course for admin vs regular
    const resAdminCourse = await fetch(`${baseUrl}/api/course?id=sample_course`, {
      headers: { 'X-Telegram-Init-Data': adminAuth }
    });
    assert.strictEqual(resAdminCourse.status, 200);
    const adminCourseData = await resAdminCourse.json();
    assert.strictEqual(adminCourseData.isProUnlocked, true);
    assert.strictEqual(adminCourseData.remainingAiQuota, 9999);
    // Locked flashcard answers must NOT be stripped for admin
    const lockedFc = (adminCourseData.course.flashcards || []).find((f) => f.is_locked);
    if (lockedFc) {
      assert.strictEqual(lockedFc.back.includes('🔒'), false);
    }

    const resRegularCourse = await fetch(`${baseUrl}/api/course?id=sample_course`, {
      headers: { 'X-Telegram-Init-Data': regularAuth }
    });
    assert.strictEqual(resRegularCourse.status, 200);
    const regularCourseData = await resRegularCourse.json();
    assert.strictEqual(regularCourseData.isProUnlocked, false);
    assert.ok(regularCourseData.remainingAiQuota <= 3);
    const regLockedFc = (regularCourseData.course.flashcards || []).find((f) => f.is_locked);
    if (regLockedFc) {
      assert.ok(regLockedFc.back.includes('🔒'));
      assert.strictEqual(regLockedFc.back, '🔒 این فرمول، نکته امتحانی استاد و حل تشریحی در نسخه کامل باز می‌شود.');
    }

    // 3. POST /api/ask-tutor: admin bypasses quota limit
    const { aiRepo } = await import('../server.js');
    // Set regular user usage to 10 queries (over limit of 3)
    aiRepo.recordAiQuery(db, { userId: String(regularId), courseId: 'sample_course', now: Date.now() });
    aiRepo.recordAiQuery(db, { userId: String(regularId), courseId: 'sample_course', now: Date.now() });
    aiRepo.recordAiQuery(db, { userId: String(regularId), courseId: 'sample_course', now: Date.now() });
    aiRepo.recordAiQuery(db, { userId: String(regularId), courseId: 'sample_course', now: Date.now() });

    const resRegularChat = await fetch(`${baseUrl}/api/ask-tutor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': regularAuth
      },
      body: JSON.stringify({
        courseId: 'sample_course',
        question: 'سوال تستی'
      })
    });
    assert.strictEqual(resRegularChat.status, 402, 'Regular user must be blocked when quota is exceeded');

    // Admin with same query count is NEVER blocked with 402
    aiRepo.recordAiQuery(db, { userId: String(adminId), courseId: 'sample_course', now: Date.now() });
    aiRepo.recordAiQuery(db, { userId: String(adminId), courseId: 'sample_course', now: Date.now() });
    aiRepo.recordAiQuery(db, { userId: String(adminId), courseId: 'sample_course', now: Date.now() });
    aiRepo.recordAiQuery(db, { userId: String(adminId), courseId: 'sample_course', now: Date.now() });

    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url).includes('generateContent')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: 'پاسخ هوش مصنوعی به ادمین' }] } }]
          })
        };
      }
      return originalFetch(url, opts);
    };

    try {
      const resAdminChat = await fetch(`${baseUrl}/api/ask-tutor`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': adminAuth
        },
        body: JSON.stringify({
          courseId: 'sample_course',
          question: 'سوال ادمین'
        })
      });
      assert.strictEqual(resAdminChat.status, 200, 'Admin must never be blocked with 402');
      const adminChatData = await resAdminChat.json();
      assert.strictEqual(adminChatData.ok, true);
      assert.strictEqual(adminChatData.remainingAiQuota, 9999);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('Story S10-1: Tamper-Proof Referral Engine & Burner Anti-Farming', () => {
  const referrerId = 888111;
  const referrerAuth = mintInitData({ id: referrerId, first_name: 'Referrer' }, testToken);

  it('generates an opaque referral code (ref_<10-hex>) without exposing user ID', async () => {
    const res = await fetch(`${baseUrl}/api/referral/code`, {
      headers: { 'X-Telegram-Init-Data': referrerAuth }
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.code.startsWith('ref_'), 'Code must start with ref_');
    assert.ok(!data.code.includes(String(referrerId)), 'Code must not expose raw user ID');
    assert.ok(data.shareUrl.includes(data.code));
  });

  it('burner accounts on signup grant ZERO reward; rewards trigger ONLY upon first settled purchase', async () => {
    const refCode = growthRepo.getOrCreateReferralCode(db, referrerId);

    // 5 burner accounts sign up with the referral code
    const burnerIds = [70001, 70002, 70003, 70004, 70005];
    for (const bId of burnerIds) {
      const bindRes = growthRepo.bindReferralIfEligible(db, {
        refereeId: bId,
        startParam: refCode
      });
      assert.equal(bindRes.bound, true);
      assert.equal(bindRes.referrerId, referrerId);
    }

    // CRITICAL: At this point, 0 rewards are granted! Referrals remain in status 'bound'.
    const countRewardedBefore = db.prepare(`
      SELECT COUNT(*) AS c FROM referrals WHERE referrer_id = ? AND status = 'rewarded'
    `).get(referrerId);
    assert.equal(countRewardedBefore.c, 0, 'No rewards should be granted on signup!');

    // First burner settles their first course purchase
    const burner1Sale = await recordCourseSale(burnerIds[0], 'sample_course');
    assert.equal(burner1Sale.ok, true);

    // Now reward triggers: 1 rewarded referral
    const countRewardedAfter = db.prepare(`
      SELECT COUNT(*) AS c FROM referrals WHERE referrer_id = ? AND status = 'rewarded'
    `).get(referrerId);
    assert.equal(countRewardedAfter.c, 1, 'Reward must trigger upon settled purchase');

    // Referee 1 cannot be rewarded again on second purchase
    const secondReward = growthRepo.triggerReferralRewardOnSale(db, {
      buyerId: burnerIds[0],
      courseId: 'sample_course'
    });
    assert.equal(secondReward.rewarded, false);
    assert.equal(secondReward.reason, 'no_pending_referral');

    // Referee 1 cannot be referred again by another user (first-touch attribution)
    const otherReferrerCode = growthRepo.getOrCreateReferralCode(db, 999222);
    const rebindRes = growthRepo.bindReferralIfEligible(db, {
      refereeId: burnerIds[0],
      startParam: otherReferrerCode
    });
    assert.equal(rebindRes.bound, false);
    assert.equal(rebindRes.reason, 'already_referred');
  });

  it('enforces daily cap of 5 rewarded referrals per referrer per Iran day (UTC+03:30)', () => {
    const testReferrer = 666777;
    const refCode = growthRepo.getOrCreateReferralCode(db, testReferrer);

    // Create 6 referee accounts and bind them
    for (let i = 1; i <= 6; i++) {
      const refId = 55500 + i;
      growthRepo.bindReferralIfEligible(db, { refereeId: refId, startParam: refCode });
    }

    // Trigger reward for first 5 referees -> all succeed
    for (let i = 1; i <= 5; i++) {
      const r = growthRepo.triggerReferralRewardOnSale(db, { buyerId: 55500 + i });
      assert.equal(r.rewarded, true, `Reward ${i} must succeed`);
    }

    // 6th referee purchase on the same day -> blocked by daily cap
    const r6 = growthRepo.triggerReferralRewardOnSale(db, { buyerId: 55500 + 6 });
    assert.equal(r6.rewarded, false);
    assert.equal(r6.reason, 'daily_cap_reached');
  });

  it('rejects self-referrals and referrals for users with prior purchases', () => {
    const userA = 444111;
    const codeA = growthRepo.getOrCreateReferralCode(db, userA);

    // 1. Self referral
    const selfRes = growthRepo.bindReferralIfEligible(db, { refereeId: userA, startParam: codeA });
    assert.equal(selfRes.bound, false);
    assert.equal(selfRes.reason, 'self_referral');

    // 2. Existing buyer
    const existingBuyer = 444222;
    db.prepare(`
      INSERT INTO sales(buyer_id, course_id, creator_id, price_toman, creator_share_toman, platform_share_toman, source, payment_ref, created_at)
      VALUES(?, 'sample_course', 'creator_1', 59000, 41300, 17700, 'manual_receipt', 'sale_test_priors', ?)
    `).run(existingBuyer, Date.now());
    db.prepare(`
      INSERT INTO purchases(buyer_id, course_id, sale_id, created_at)
      VALUES(?, 'sample_course', 1, ?)
    `).run(existingBuyer, Date.now());

    const existingRes = growthRepo.bindReferralIfEligible(db, { refereeId: existingBuyer, startParam: codeA });
    assert.equal(existingRes.bound, false);
    assert.equal(existingRes.reason, 'existing_customer');
  });
});

describe('Story S10-2: 2-Tap University/Department Onboarding & Catalog Ranking', () => {
  const studentId = 777333;
  const studentAuth = mintInitData({ id: studentId, first_name: 'Student' }, testToken);

  it('GET /api/campus/options serves standard university and department catalog', async () => {
    const res = await fetch(`${baseUrl}/api/campus/options`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.universities.some((u) => u.id === 'ut'));
    assert.ok(data.departments.some((d) => d.id === 'materials'));
  });

  it('POST /api/campus/profile rejects free-text and uncurated IDs', async () => {
    const res = await fetch(`${baseUrl}/api/campus/profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': studentAuth
      },
      body: JSON.stringify({
        universityId: 'fake_unknown_uni',
        departmentId: 'materials',
        term: 4
      })
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/campus/profile saves valid profile and ranks matching department courses at top of GET /api/courses', async () => {
    // 1. Save student profile for materials department
    const res = await fetch(`${baseUrl}/api/campus/profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': studentAuth
      },
      body: JSON.stringify({
        universityId: 'ut',
        departmentId: 'materials',
        term: 4
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.profile.departmentId, 'materials');

    // 2. GET /api/courses with student auth ranks materials courses first
    const catRes = await fetch(`${baseUrl}/api/courses`, {
      headers: { 'X-Telegram-Init-Data': studentAuth }
    });
    assert.equal(catRes.status, 200);
    const catData = await catRes.json();
    assert.ok(catData.courses.length > 0);

    const firstCourse = catData.courses[0];
    assert.equal(firstCourse.isRecommendedForDepartment, true, 'Top course must be recommended for department');
    assert.ok(
      firstCourse.category.includes('مواد') || firstCourse.category.includes('متالورژی'),
      'Recommended course matches department'
    );
  });
});

describe('Story S10-3: Server-Side Streaks (UTC+03:30), Exam-Eve Panic Mode & Card Deep-Links', () => {
  const learnerId = 333888;
  const learnerAuth = mintInitData({ id: learnerId, first_name: 'Learner' }, testToken);

  it('computes consecutive streak days accurately across Iran Standard Time (UTC+03:30)', () => {
    const now = Date.now();
    const oneDay = 24 * 3600 * 1000;

    // Simulate 3 consecutive study days: today, yesterday, 2 days ago
    growthRepo.recordStudyEvent(db, { userId: learnerId, courseId: 'c1', cardsReviewed: 10, now: now - 2 * oneDay });
    growthRepo.recordStudyEvent(db, { userId: learnerId, courseId: 'c1', cardsReviewed: 15, now: now - 1 * oneDay });
    growthRepo.recordStudyEvent(db, { userId: learnerId, courseId: 'c1', cardsReviewed: 20, now });

    const streak = growthRepo.getStreakAndBadges(db, learnerId, now);
    assert.equal(streak.currentStreakDays, 3);
    assert.ok(streak.badges.includes('streak_3'));
    assert.equal(streak.totalCardsReviewed, 45);
  });

  it('POST /api/course/exam-date & GET /api/course/exam-plan triggers panic mode when exam is within 24h', async () => {
    const examTimeWithin12Hours = Date.now() + 12 * 3600 * 1000;

    // 1. Set exam date
    const setRes = await fetch(`${baseUrl}/api/course/exam-date`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': learnerAuth
      },
      body: JSON.stringify({
        courseId: 'sample_course',
        examAt: examTimeWithin12Hours
      })
    });
    assert.equal(setRes.status, 200);

    // 2. Fetch exam plan
    const planRes = await fetch(`${baseUrl}/api/course/exam-plan?courseId=sample_course`, {
      headers: { 'X-Telegram-Init-Data': learnerAuth }
    });
    assert.equal(planRes.status, 200);
    const planData = await planRes.json();
    assert.equal(planData.ok, true);
    assert.equal(planData.hasExam, true);
    assert.equal(planData.panicMode, true, 'Exam within 12 hours must activate panicMode');
    assert.ok(planData.hoursRemaining <= 13);
    assert.ok(planData.plan.length > 0, 'Plan must partition cards into Pomodoro sprints');
    assert.equal(planData.plan[0].durationMinutes, 25);
  });

  it('parses deep-link parameters for direct flashcard navigation', () => {
    const target = growthRepo.parseCardDeepLink('card_sample_course_fc_2');
    assert.equal(target.isCardDeepLink, true);
    assert.equal(target.courseId, 'sample_course');
    assert.equal(target.cardId, 'fc_2');

    const invalid = growthRepo.parseCardDeepLink('other_param_123');
    assert.equal(invalid.isCardDeepLink, false);
  });
});

describe('Story S10-4: Token-Bucket Channel Broadcast Worker & 403/429 Resilience', () => {
  it('rate-limits to max 1 message per channel per tick and appends deep-link URL', async () => {
    // Schedule 2 posts for the same channel_1 and 1 post for channel_2
    growthRepo.scheduleBroadcastPost(db, {
      channelId: 'channel_101',
      courseId: 'sample_course',
      cardId: 'fc_1',
      teaserText: 'تیزر سوال امتحانی ۱'
    });
    growthRepo.scheduleBroadcastPost(db, {
      channelId: 'channel_101',
      courseId: 'sample_course',
      cardId: 'fc_2',
      teaserText: 'تیزر سوال امتحانی ۲'
    });
    growthRepo.scheduleBroadcastPost(db, {
      channelId: 'channel_202',
      courseId: 'sample_course',
      cardId: 'fc_1',
      teaserText: 'تیزر سوال امتحانی ۳'
    });

    const sentMessages = [];
    const fakeSendFn = async (post) => {
      sentMessages.push(post);
    };

    const resTick1 = await growthRepo.processScheduledBroadcasts(db, {
      sendFn: fakeSendFn,
      maxPerTick: 25,
      botUsername: 'JozvehBot'
    });

    // Tick 1 sends 1 for channel_101 and 1 for channel_202 (2 total; 2nd post of channel_101 is deferred)
    assert.equal(resTick1.sent, 2);
    assert.equal(sentMessages.length, 2);
    assert.ok(sentMessages[0].deepLinkUrl.includes('card_sample_course_fc_1'));

    // Tick 2 sends the remaining post for channel_101
    const resTick2 = await growthRepo.processScheduledBroadcasts(db, {
      sendFn: fakeSendFn,
      maxPerTick: 25,
      botUsername: 'JozvehBot'
    });
    assert.equal(resTick2.sent, 1);
  });

  it('reschedules posts on 429 Too Many Requests backoff without failing the batch', async () => {
    growthRepo.scheduleBroadcastPost(db, {
      channelId: 'channel_429',
      courseId: 'sample_course',
      cardId: 'fc_1',
      teaserText: 'تیزر اسپم'
    });

    const error429 = new Error('Too Many Requests');
    error429.statusCode = 429;
    error429.retryAfter = 10;

    const res = await growthRepo.processScheduledBroadcasts(db, {
      sendFn: async () => { throw error429; }
    });

    assert.equal(res.rescheduled, 1);
    assert.equal(res.failed, 0);

    const postRow = db.prepare('SELECT status, retry_after FROM scheduled_posts WHERE channel_id = ?').get('channel_429');
    assert.equal(postRow.status, 'pending');
    assert.ok(postRow.retry_after > Date.now());
  });

  it('handles 403 Forbidden by marking user bot_blocked_at', async () => {
    const blockedUserId = 999888;
    db.prepare('INSERT OR IGNORE INTO users(telegram_id, first_name, created_at, last_seen_at) VALUES(?, ?, ?, ?)')
      .run(blockedUserId, 'BlockedUser', Date.now(), Date.now());

    growthRepo.scheduleBroadcastPost(db, {
      channelId: String(blockedUserId),
      courseId: 'sample_course',
      cardId: 'fc_1',
      teaserText: 'پیام تست'
    });

    const error403 = new Error('Forbidden: bot was blocked by the user');
    error403.statusCode = 403;

    await growthRepo.processScheduledBroadcasts(db, {
      sendFn: async () => { throw error403; }
    });

    assert.equal(growthRepo.isUserBotBlocked(db, blockedUserId), true);
  });
});

describe('Wave 11-B: Professor/University Academic Metadata & Blurred Formula Teaser Paywall', () => {
  it('GET /api/courses exposes professor, university, semester, examWeight and item counts', async () => {
    const res = await fetch(`${baseUrl}/api/courses`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.courses) && data.courses.length >= 4);

    const sample = data.courses.find((c) => c.slug === 'sample_course' || c.id === 'ut_metal_thermo_01');
    assert.ok(sample, 'sample_course must be present in catalog');
    assert.ok(sample.professor && sample.professor.includes('دکتر'));
    assert.equal(sample.university, 'دانشگاه تهران');
    assert.equal(sample.semester, 'نیمسال اول ۱۴۰۵');
    assert.ok(sample.examWeight && sample.examWeight.includes('پوشش'));
    assert.ok(sample.formulasCount >= 4);
    assert.ok(sample.flashcardsCount >= 4);
    assert.ok(sample.quizCount >= 4);
  });

  it('stripLockedContentForFreeUser leaves 2 preview items intact and redacts locked items', async () => {
    const { stripLockedContentForFreeUser } = await import('../server.js');
    const mockCourse = {
      id: 'test_course_meta',
      title: 'درس تستی',
      summary_cheat_sheet: [
        { id: 'cs_1', topic: 'مبحث ۱', formula_latex: 'E=mc^2', key_points: ['نکته ۱'], source_page: 5 },
        { id: 'cs_2', topic: 'مبحث ۲', formula_latex: 'F=ma', key_points: ['نکته ۲'], source_page: 10 },
        { id: 'cs_3', topic: 'مبحث ۳ کلیدی', formula_latex: 'PV=nRT', key_points: ['نکته ۳ مهم'], source_page: 15 }
      ],
      flashcards: [
        { id: 'fc_1', front: 'سوال ۱', back: 'پاسخ ۱', source_page: 5 },
        { id: 'fc_2', front: 'سوال ۲', back: 'پاسخ ۲', source_page: 10 },
        { id: 'fc_3', front: 'سوال ۳ پرتکرار', back: 'پاسخ ۳ تحلیلی', source_page: 15 }
      ],
      exam_questions: [
        { id: 'q_1', question_stem: 'تست ۱', options: ['الف', 'ب', 'ج', 'د'], explanation: 'حل ۱', source_page: 5 },
        { id: 'q_2', question_stem: 'تست ۲', options: ['الف', 'ب', 'ج', 'د'], explanation: 'حل ۲', source_page: 10 },
        { id: 'q_3', question_stem: 'تست ۳ پایانی', options: ['الف', 'ب', 'ج', 'د'], explanation: 'حل ۳', source_page: 15 }
      ]
    };

    const stripped = stripLockedContentForFreeUser(mockCourse);

    // First 2 items remain unredacted
    assert.equal(stripped.summary_cheat_sheet[0].formula_latex, 'E=mc^2');
    assert.equal(stripped.summary_cheat_sheet[1].formula_latex, 'F=ma');
    assert.equal(stripped.flashcards[0].back, 'پاسخ ۱');
    assert.equal(stripped.flashcards[1].back, 'پاسخ ۲');
    assert.equal(stripped.exam_questions[0].explanation, 'حل ۱');
    assert.equal(stripped.exam_questions[1].explanation, 'حل ۲');

    // 3rd item is locked & redacted
    assert.equal(stripped.summary_cheat_sheet[2].is_locked, true);
    assert.equal(stripped.summary_cheat_sheet[2].topic, 'مبحث ۳ کلیدی');
    assert.equal(stripped.summary_cheat_sheet[2].source_page, 15);
    assert.equal(stripped.summary_cheat_sheet[2].formula_latex, '\\text{Locked Pro Formula}');
    assert.ok(stripped.summary_cheat_sheet[2].tip.includes('🔒'));

    assert.equal(stripped.flashcards[2].is_locked, true);
    assert.equal(stripped.flashcards[2].front, 'سوال ۳ پرتکرار');
    assert.equal(stripped.flashcards[2].source_page, 15);
    assert.ok(stripped.flashcards[2].back.includes('🔒'));

    assert.equal(stripped.exam_questions[2].is_locked, true);
    assert.equal(stripped.exam_questions[2].question_stem, 'تست ۳ پایانی');
    assert.equal(stripped.exam_questions[2].source_page, 15);
    assert.ok(stripped.exam_questions[2].explanation.includes('🔒'));
  });

  it('GET /api/course?id=eng_math_01 serves teaser paywall preview for anonymous/free student', async () => {
    const res = await fetch(`${baseUrl}/api/course?id=eng_math_01`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.isProUnlocked, false);

    const course = data.course;
    assert.equal(course.id, 'eng_math_01');
    assert.ok(course.summary_cheat_sheet.length > 2);

    // Free items intact
    assert.notEqual(course.summary_cheat_sheet[0].formula_latex, '\\text{Locked Pro Formula}');
    // Locked items redacted
    const lockedCs = course.summary_cheat_sheet[2];
    assert.equal(lockedCs.is_locked, true);
    assert.equal(lockedCs.formula_latex, '\\text{Locked Pro Formula}');
    assert.ok(lockedCs.source_page > 0);
  });
});

describe('Wave 11-C: Dorm Squad 2-Player Group Buy (30% Discount)', () => {
  const squadInitiatorId = 88776655;
  const squadInitiatorAuth = mintInitData({ id: squadInitiatorId, first_name: 'Farhad' }, testToken);
  const squadPartnerId = 44332211;
  const squadPartnerAuth = mintInitData({ id: squadPartnerId, first_name: 'Nima' }, testToken);

  let createdSquadCode = '';

  it('POST /api/squad/create generates squad deep-link with 30% discount', async () => {
    const res = await fetch(`${baseUrl}/api/squad/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': squadInitiatorAuth
      },
      body: JSON.stringify({ courseId: 'sample_course' })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.code && data.code.startsWith('squad_'));
    assert.ok(data.deepLink && data.deepLink.includes(data.code));
    assert.ok(data.deepLink.startsWith(`https://t.me/JozvehLabBot?start=${data.code}`));
    assert.ok(data.webAppUrl && data.webAppUrl.includes(`/?startapp=${data.code}`));
    assert.ok(data.shareLink && data.shareLink.includes('t.me/share/url'));
    assert.equal(data.originalPriceToman, 59000);
    assert.equal(data.discountedPriceToman, Math.floor(59000 * 0.7)); // 41300
    assert.equal(data.discountPercent, 30);
    assert.equal(data.status, 'waiting_partner');

    createdSquadCode = data.code;

    // Idempotent for same initiator and course
    const res2 = await fetch(`${baseUrl}/api/squad/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': squadInitiatorAuth
      },
      body: JSON.stringify({ courseId: 'sample_course' })
    });
    const data2 = await res2.json();
    assert.equal(data2.code, data.code);
  });

  it('GET /api/squad/status returns squad details and rejects invalid code', async () => {
    // 1. Valid code
    const res = await fetch(`${baseUrl}/api/squad/status?code=${createdSquadCode}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.code, createdSquadCode);
    assert.equal(data.initiatorId, squadInitiatorId);
    assert.equal(data.initiatorName, 'Farhad');
    assert.equal(data.discountedPriceToman, 41300);
    assert.equal(data.status, 'waiting_partner');

    // 2. Invalid code
    const invalidRes = await fetch(`${baseUrl}/api/squad/status?code=squad_nonexistent`);
    assert.equal(invalidRes.status, 404);
  });

  it('POST /api/payment/create with squadCode applies 30% discount and completes squad on settlement', async () => {
    const prevAllowDemo = process.env.ALLOW_DEMO_PAYMENTS;
    process.env.ALLOW_DEMO_PAYMENTS = '1';

    try {
      // 1. Create payment intent with squadCode
      const payRes = await fetch(`${baseUrl}/api/payment/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': squadPartnerAuth
        },
        body: JSON.stringify({
          courseId: 'sample_course',
          squadCode: createdSquadCode
        })
      });

      assert.equal(payRes.status, 200);
      const payData = await payRes.json();
      assert.equal(payData.ok, true);
      assert.equal(payData.amountToman, 41300);

      // 2. Verify payment settlement completes squad
      const verifyRes = await fetch(`${baseUrl}/api/payment/verify?Authority=${payData.authority}&Status=OK`, {
        redirect: 'manual'
      });
      assert.ok(verifyRes.status === 200 || verifyRes.status === 302);

      // 3. Status is now completed
      const statusRes = await fetch(`${baseUrl}/api/squad/status?code=${createdSquadCode}`);
      const statusData = await statusRes.json();
      assert.equal(statusData.status, 'completed');
      assert.equal(statusData.partnerId, squadPartnerId);
      assert.ok(statusData.completedAt > 0);
    } finally {
      process.env.ALLOW_DEMO_PAYMENTS = prevAllowDemo;
    }
  });

  describe('Story S10-4: Wave 11-D Graded Exam Sheet Simulator & 0–20 Grading Rubric', () => {
    it('verifies all 4 course files contain step-by-step rubrics summing to 20 total barom with zero KaTeX errors', async () => {
      const { findBrokenLatexFormulas } = await import('../../factory/generate.js');
      const courses = ['sample_course.json', 'eng_math_01.json', 'metal_casting_01.json', 'fluid_mechanics_01.json'];

      for (const file of courses) {
        const filePath = path.join(process.cwd(), 'server', 'content', file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        assert.ok(Array.isArray(data.exam_questions) && data.exam_questions.length > 0, `${file} missing questions`);

        let totalBarom = 0;
        data.exam_questions.forEach((q, idx) => {
          assert.ok(typeof q.barom === 'number' && q.barom > 0, `${file} q[${idx}] missing barom`);
          totalBarom += q.barom;

          assert.ok(Array.isArray(q.rubricSteps) && q.rubricSteps.length >= 3, `${file} q[${idx}] needs at least 3 rubric steps`);
          let stepSum = 0;
          q.rubricSteps.forEach((rs, sIdx) => {
            assert.ok(rs.step && typeof rs.step === 'string', `${file} q[${idx}] step[${sIdx}] missing description`);
            assert.ok(typeof rs.points === 'number' && rs.points > 0, `${file} q[${idx}] step[${sIdx}] missing points`);
            stepSum += rs.points;
          });
          assert.ok(Math.abs(stepSum - q.barom) < 0.01, `${file} q[${idx}] rubric steps (${stepSum}) do not equal barom (${q.barom})`);

          assert.ok(q.commonTrap && typeof q.commonTrap === 'string' && q.commonTrap.length > 10, `${file} q[${idx}] missing commonTrap`);
        });

        assert.strictEqual(totalBarom, 20, `${file} total barom must equal exactly 20 points`);

        const latexErrors = findBrokenLatexFormulas(data);
        assert.strictEqual(latexErrors.length, 0, `${file} has KaTeX errors: ${JSON.stringify(latexErrors)}`);
      }
    });

    it('stripLockedContentForFreeUser redacts rubricSteps and commonTrap on locked questions while retaining barom', async () => {
      const { stripLockedContentForFreeUser } = await import('../server.js');
      const filePath = path.join(process.cwd(), 'server', 'content', 'sample_course.json');
      const fullCourse = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      const stripped = stripLockedContentForFreeUser(fullCourse);

      // Question 1 & 2 (indices 0 and 1) are free preview questions
      assert.strictEqual(stripped.exam_questions[0].is_locked, false);
      assert.strictEqual(stripped.exam_questions[0].barom, 4);
      assert.strictEqual(stripped.exam_questions[0].rubricSteps.length, 3);
      assert.ok(!stripped.exam_questions[0].commonTrap.includes('🔒'));

      // Question 3, 4, 5 (indices 2, 3, 4) are locked
      for (let i = 2; i < stripped.exam_questions.length; i++) {
        const lockedQ = stripped.exam_questions[i];
        assert.strictEqual(lockedQ.is_locked, true);
        assert.strictEqual(lockedQ.barom, 4);
        assert.ok(lockedQ.commonTrap.includes('🔒') || lockedQ.commonTrap.includes('نسخه کامل'), 'commonTrap must be redacted');
        assert.strictEqual(lockedQ.rubricSteps[0].step, 'قفل - بارم‌بندی و کلید تصحیح تشریحی استاد');
        assert.strictEqual(lockedQ.rubricSteps[0].formula, '\\text{Locked Pro Rubric}');
      }
    });

    it('GET /api/course serves redacted rubrics to free users and full rubrics to admin VIP', async () => {
      // 1. Free unpurchased user
      const freeUser = { id: 998877, first_name: 'FreeStudent' };
      const freeAuth = mintInitData(freeUser, testToken);

      const freeRes = await fetch(`${baseUrl}/api/course?id=sample_course`, {
        headers: { 'X-Telegram-Init-Data': freeAuth }
      });
      assert.strictEqual(freeRes.status, 200);
      const freeData = await freeRes.json();
      assert.strictEqual(freeData.isProUnlocked, false);

      const freeQuestions = freeData.course.exam_questions;
      assert.strictEqual(freeQuestions[0].barom, 4);
      assert.ok(freeQuestions[2].is_locked, true);
      assert.ok(freeQuestions[2].commonTrap.includes('🔒') || freeQuestions[2].commonTrap.includes('نسخه کامل'));
      assert.strictEqual(freeQuestions[2].rubricSteps[0].step, 'قفل - بارم‌بندی و کلید تصحیح تشریحی استاد');

      // 2. Admin VIP user gets full unredacted course
      const adminUser = { id: 999999, first_name: 'SuperAdmin' };
      const adminAuth = mintInitData(adminUser, testToken);

      const adminRes = await fetch(`${baseUrl}/api/course?id=sample_course`, {
        headers: { 'X-Telegram-Init-Data': adminAuth }
      });
      assert.strictEqual(adminRes.status, 200);
      const adminData = await adminRes.json();
      assert.strictEqual(adminData.isProUnlocked, true);

      const adminQuestions = adminData.course.exam_questions;
      assert.strictEqual(adminQuestions[2].barom, 4);
      assert.ok(!adminQuestions[2].commonTrap.includes('🔒'));
      assert.notStrictEqual(adminQuestions[2].rubricSteps[0].step, 'قفل - بارم‌بندی و کلید تصحیح تشریحی استاد');
      assert.ok(adminQuestions[2].rubricSteps.length >= 3);
    });
  });

  describe('Wave 12-A: Universal ?start= Squad & Referral Deep-Links and JozvehLabBot Auto-Sync', () => {
    it('getRuntimeBotUsername defaults to JozvehLabBot and reflects dynamic setRuntimeBotUsername', async () => {
      const { getRuntimeBotUsername, setRuntimeBotUsername } = await import('../telegram.js');
      assert.strictEqual(getRuntimeBotUsername(), 'JozvehLabBot');

      setRuntimeBotUsername('CustomTestBot');
      assert.strictEqual(getRuntimeBotUsername(), 'CustomTestBot');

      setRuntimeBotUsername('JozvehLabBot');
      assert.strictEqual(getRuntimeBotUsername(), 'JozvehLabBot');
    });

    it('POST /api/squad/create uses JozvehLabBot and generates universal ?start=squad_... links with webAppUrl', async () => {
      const res = await fetch(`${baseUrl}/api/squad/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Init-Data': squadInitiatorAuth
        },
        body: JSON.stringify({ courseId: 'sample_course' })
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ok, true);
      assert.ok(data.deepLink.startsWith(`https://t.me/JozvehLabBot?start=${data.code}`));
      assert.ok(data.webAppUrl.includes(`/?startapp=${data.code}`));
      assert.ok(data.shareLink.includes(encodeURIComponent(data.deepLink)));
    });

    it('GET /api/referral/code uses JozvehLabBot and generates universal ?start=ref_... links with webAppUrl', async () => {
      const referrerUser = { id: 654321, first_name: 'ReferrerStudent' };
      const referrerAuth = mintInitData(referrerUser, testToken);

      const res = await fetch(`${baseUrl}/api/referral/code`, {
        headers: { 'X-Telegram-Init-Data': referrerAuth }
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.ok, true);
      assert.ok(data.shareUrl.startsWith(`https://t.me/JozvehLabBot?start=${data.code}`));
      assert.ok(data.webAppUrl.includes(`/?startapp=${data.code}`));
    });

    it('sending /start squad_<code> to handleUpdate replies with tailored invitation and inline web_app button containing ?startapp=squad_<code>', async () => {
      const { handleUpdate } = await import('../bot.js');
      const originalFetch = global.fetch;
      const sentTelegrams = [];

      global.fetch = async (url, opts) => {
        if (String(url).includes('api.telegram.org')) {
          const body = JSON.parse(opts?.body || '{}');
          sentTelegrams.push({ url: String(url), body });
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, result: { message_id: 12345 } })
          };
        }
        return originalFetch(url, opts);
      };

      try {
        const updateId = Date.now() + 500;
        const testUpdate = {
          update_id: updateId,
          message: {
            message_id: 8881,
            chat: { id: 554433 },
            from: { id: 554433, first_name: 'InvitedStudent' },
            text: `/start ${createdSquadCode}`
          }
        };

        const res = await handleUpdate(testUpdate);
        assert.strictEqual(res.ok, true);
        assert.strictEqual(sentTelegrams.length, 1);

        const sentMsg = sentTelegrams[0].body;
        assert.strictEqual(String(sentMsg.chat_id), '554433');
        assert.ok(sentMsg.text.includes('خرید دونفره') || sentMsg.text.includes('تخفیف'));
        assert.ok(sentMsg.text.includes('۴۱٬۳۰۰ تومان') || sentMsg.text.includes('41300'));

        const webAppBtn = sentMsg.reply_markup?.inline_keyboard?.[0]?.[0];
        assert.ok(webAppBtn && webAppBtn.web_app?.url);
        assert.ok(webAppBtn.web_app.url.includes(`/?startapp=${createdSquadCode}`));
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('pasting a message containing squad_<code> directly into bot replies with web_app button containing ?startapp=squad_<code>', async () => {
      const { handleUpdate } = await import('../bot.js');
      const originalFetch = global.fetch;
      const sentTelegrams = [];

      global.fetch = async (url, opts) => {
        if (String(url).includes('api.telegram.org')) {
          const body = JSON.parse(opts?.body || '{}');
          sentTelegrams.push({ url: String(url), body });
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, result: { message_id: 12346 } })
          };
        }
        return originalFetch(url, opts);
      };

      try {
        const updateId = Date.now() + 501;
        // Simulating forwarded/pasted link from Telegram log:
        const testUpdate = {
          update_id: updateId,
          message: {
            message_id: 8882,
            chat: { id: 665544 },
            from: { id: 665544, first_name: 'PastingStudent' },
            text: `سلام این لینک منه: https://t.me/JozvehLabBot?startapp=${createdSquadCode}`
          }
        };

        const res = await handleUpdate(testUpdate);
        assert.strictEqual(res.ok, true);
        assert.strictEqual(sentTelegrams.length, 1);

        const sentMsg = sentTelegrams[0].body;
        const webAppBtn = sentMsg.reply_markup?.inline_keyboard?.[0]?.[0];
        assert.ok(webAppBtn && webAppBtn.web_app?.url);
        assert.ok(webAppBtn.web_app.url.includes(`/?startapp=${createdSquadCode}`));
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
