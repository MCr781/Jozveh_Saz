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
  synthesizeGroundedTutorAnswer
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
