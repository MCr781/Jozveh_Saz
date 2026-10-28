/**
 * Jozveh Saz - Automated End-to-End Self-Test (Milestone 6)
 *
 * Runs the real HTTP server in-process against an isolated temporary database,
 * exercises every public API route plus static assets/security/caching rules,
 * and prints a Pass/Fail audit table.
 *
 * Exit code: 0 when every check passes, 1 otherwise.
 *
 * Usage:
 *   node server/self_test.js
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jozveh-saz-self-test-'));
const TEMP_DB_PATH = path.join(TEMP_DIR, 'state_db.json');
const DEMO_COURSE_ID = 'metal_casting_01';
const DEMO_USER_ID = 'demo_user_981024';
const IMMUTABLE_CACHE = 'public, max-age=604800, immutable';
const LOCK_MARKER = '🔒';

// Force an offline, isolated test environment BEFORE importing server.js.
// loadEnvFile() in server.js only fills undefined variables, so these empty
// values also prevent a local .env file from triggering Telegram/Gemini calls.
Object.assign(process.env, {
  NODE_ENV: 'test',
  STATE_DB_PATH: TEMP_DB_PATH,
  BOT_TOKEN: '',
  ADMIN_CHAT_ID: '',
  MERCHANT_ID: 'demo',
  GEMINI_API_KEY_1: '',
  GEMINI_API_KEY_2: '',
  GEMINI_API_KEY_3: ''
});

let serverRef = null;

async function cleanup() {
  if (serverRef) {
    const server = serverRef;
    serverRef = null;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        server.close(done);
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      } catch (_) {
        done();
      }
      setTimeout(done, 2000).unref?.();
    });
  }
  try {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch (_) {}
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  assert(
    Object.is(actual, expected),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function expectStatus(res, expected) {
  assert(
    res.status === expected,
    `Expected HTTP ${expected}, got HTTP ${res.status}: ${res.text.slice(0, 160)}`
  );
}

function expectOkJson(res) {
  assert(res.json && typeof res.json === 'object', 'Response is not valid JSON');
  assert(res.json.ok === true, `Expected ok=true, got ${JSON.stringify(res.json)}`);
  return res.json;
}

function expectHeader(res, name, expected) {
  const actual = res.headers.get(name);
  assert(
    actual === expected,
    `Header "${name}": expected "${expected}", got "${actual}"`
  );
}

function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function pad(value, width) {
  return String(value).padEnd(width, ' ');
}

function renderTable(results) {
  const headers = ['#', 'Result', 'Check', 'Details'];
  const rows = results.map((result, index) => [
    String(index + 1).padStart(2, '0'),
    result.status,
    truncate(result.name, 46),
    truncate(result.detail, 44)
  ]);
  const widths = headers.map((header, index) => {
    const maxContent = Math.max(
      header.length,
      ...rows.map((row) => String(row[index]).length)
    );
    const configuredMax = [3, 6, 46, 44][index];
    return Math.min(configuredMax, maxContent);
  });
  const border = `+${widths.map((width) => '-'.repeat(width + 2)).join('+')}+`;
  const formatRow = (row) =>
    `| ${row.map((cell, index) => pad(cell, widths[index])).join(' | ')} |`;

  console.log(border);
  console.log(formatRow(headers));
  console.log(border);
  for (const row of rows) console.log(formatRow(row));
  console.log(border);
}

async function main() {
  const { server, DB, DB_PATH } = await import('./server.js');
  serverRef = server;

  assert(
    DB_PATH === path.resolve(TEMP_DB_PATH),
    `Database isolation failed: DB_PATH is ${DB_PATH}, expected ${TEMP_DB_PATH}`
  );

  const fixturePath = path.join(PROJECT_ROOT, 'public', 'data', `${DEMO_COURSE_ID}.json`);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const expectedCreatorId = fixture.creator_telegram_id || 'creator_demo_1';
  const expectedCreatorShare = Math.round(Number(fixture.price_toman || 59000) * 0.7);

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(route, options = {}) {
    const init = { method: options.method || 'GET', headers: { ...(options.headers || {}) } };
    if (options.redirect) init.redirect = options.redirect;
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const res = await fetch(`${baseUrl}${route}`, init);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {}
    return { status: res.status, headers: res.headers, text, json };
  }

  const results = [];
  const suiteStartedAt = Date.now();

  async function test(name, fn) {
    const startedAt = Date.now();
    try {
      const detail = await fn();
      results.push({
        name,
        status: 'PASS',
        detail: detail || 'OK',
        ms: Date.now() - startedAt
      });
    } catch (err) {
      results.push({
        name,
        status: 'FAIL',
        detail: err?.message || String(err),
        ms: Date.now() - startedAt
      });
    }
  }

  // ---------------------------------------------------------------------
  // Static Mini App shell
  // ---------------------------------------------------------------------
  await test('GET / (Mini App shell)', async () => {
    const res = await request('/');
    expectStatus(res, 200);
    expectHeader(res, 'content-type', 'text/html; charset=utf-8');
    expectHeader(res, 'x-content-type-options', 'nosniff');
    expectHeader(res, 'x-frame-options', 'ALLOWALL');
    assert(
      res.text.includes('<html lang="fa" dir="rtl">'),
      'Home page is not a Persian RTL document'
    );
    assert(res.text.includes('جزوه زنده'), 'App title not found in home page');
    return '200 · RTL HTML · security headers';
  });

  // ---------------------------------------------------------------------
  // Catalog & course paywall stripping
  // ---------------------------------------------------------------------
  await test('GET /api/courses (catalog)', async () => {
    const res = await request('/api/courses');
    expectStatus(res, 200);
    const data = expectOkJson(res);
    assert(Array.isArray(data.courses), 'courses is not an array');
    const demo = data.courses.find(
      (course) => course.slug === DEMO_COURSE_ID || course.id === DEMO_COURSE_ID
    );
    assert(demo, `Demo course ${DEMO_COURSE_ID} missing from catalog`);
    assertEqual(demo.isProUnlocked, false, 'Demo course should be locked before purchase');
    expectHeader(res, 'x-content-type-options', 'nosniff');
    expectHeader(res, 'x-frame-options', 'ALLOWALL');
    return `200 · ${data.courses.length} courses · demo free`;
  });

  await test('GET /api/course (locked redaction)', async () => {
    const res = await request(`/api/course?id=${DEMO_COURSE_ID}`);
    expectStatus(res, 200);
    const data = expectOkJson(res);
    assertEqual(data.isProUnlocked, false, 'isProUnlocked before purchase');
    assert(data.course && Array.isArray(data.course.flashcards), 'Course flashcards missing');

    const lockedCard = data.course.flashcards.find((card) => card.id === 'mc_fc_4');
    assert(lockedCard, 'Locked flashcard mc_fc_4 missing');
    assert(String(lockedCard.back).includes(LOCK_MARKER), 'Locked card back was not redacted');

    const freeCard = data.course.flashcards.find((card) => card.id === 'mc_fc_1');
    assert(freeCard, 'Free flashcard mc_fc_1 missing');
    assert(!String(freeCard.back).includes(LOCK_MARKER), 'Free card was incorrectly redacted');

    const lockedQuestion = data.course.exam_questions.find((question) => question.id === 'mc_q_3');
    assert(lockedQuestion, 'Locked exam question mc_q_3 missing');
    assert(
      String(lockedQuestion.explanation).includes(LOCK_MARKER),
      'Locked exam explanation was not redacted'
    );
    return '200 · locked answers stripped';
  });

  await test('GET /api/course (unknown id)', async () => {
    const res = await request('/api/course?id=definitely_missing_course_xyz');
    expectStatus(res, 404);
    assert(res.json && res.json.ok === false, 'Unknown course should return ok=false');
    return '404 · not found JSON';
  });

  // ---------------------------------------------------------------------
  // AI tutor
  // ---------------------------------------------------------------------
  await test('POST /api/ask-tutor (empty question)', async () => {
    const res = await request('/api/ask-tutor', {
      method: 'POST',
      body: { courseId: DEMO_COURSE_ID, contextText: 'انجماد', question: '' }
    });
    expectStatus(res, 400);
    assert(res.json && res.json.ok === false, 'Empty question should be rejected');
    return '400 · empty question rejected';
  });

  await test('POST /api/ask-tutor (local fallback)', async () => {
    const res = await request('/api/ask-tutor', {
      method: 'POST',
      body: {
        courseId: DEMO_COURSE_ID,
        contextText: 'انجماد و ریخته‌گری',
        question: 'چرا سرعت انجماد در قالب فلزی بیشتر است؟'
      }
    });
    expectStatus(res, 200);
    const data = expectOkJson(res);
    assert(String(data.reply).includes('پاسخ سرور لوکال'), 'Local fallback reply missing');
    assertEqual(data.remainingAiQuota, 2, 'Free AI quota after one question');
    return '200 · local reply · quota 2';
  });

  // ---------------------------------------------------------------------
  // Leitner progress sync
  // ---------------------------------------------------------------------
  await test('POST /api/sync-progress (review sync)', async () => {
    const res = await request('/api/sync-progress', {
      method: 'POST',
      body: {
        courseId: DEMO_COURSE_ID,
        reviewCount: 3,
        knownCount: 2,
        totalCards: 6,
        pendingReviewIds: ['mc_fc_4', 'mc_fc_5']
      }
    });
    expectStatus(res, 200);
    const data = expectOkJson(res);
    assertEqual(data.courseId, DEMO_COURSE_ID, 'Canonical course id');
    assertEqual(data.reviewCount, 3, 'Synced review count');
    assertEqual(data.pendingCourses, 1, 'Pending course count');
    assert(
      DB.userStudyProgress[DEMO_USER_ID] &&
        DB.userStudyProgress[DEMO_USER_ID].reviewCount === 3,
      'Review progress was not stored in the database'
    );
    return '200 · reviewCount=3 · persisted';
  });

  // ---------------------------------------------------------------------
  // Creator baseline, demo purchase, entitlement
  // ---------------------------------------------------------------------
  await test('GET /api/creator-stats (baseline)', async () => {
    const res = await request(`/api/creator-stats?creator_id=${expectedCreatorId}`);
    expectStatus(res, 200);
    const data = expectOkJson(res);
    assertEqual(data.balanceToman, 0, 'Baseline creator balance');
    assertEqual(data.salesCount, 0, 'Baseline creator sales');
    return '200 · balance=0 · sales=0';
  });

  await test('POST /api/payment/create (demo)', async () => {
    const res = await request('/api/payment/create', {
      method: 'POST',
      body: { courseId: DEMO_COURSE_ID }
    });
    expectStatus(res, 200);
    const data = expectOkJson(res);
    assertEqual(data.simulated, true, 'Demo payment should be simulated');
    assert(
      DB.purchases[`${DEMO_USER_ID}_${DEMO_COURSE_ID}`] === true,
      'Demo purchase was not recorded for the user'
    );
    return '200 · simulated=true · unlocked';
  });

  await test('GET /api/course (unlocked full content)', async () => {
    const res = await request(`/api/course?id=${DEMO_COURSE_ID}`);
    expectStatus(res, 200);
    const data = expectOkJson(res);
    assertEqual(data.isProUnlocked, true, 'isProUnlocked after purchase');
    const previouslyLocked = data.course.flashcards.find((card) => card.id === 'mc_fc_4');
    assert(previouslyLocked, 'Purchased flashcard mc_fc_4 missing');
    assert(
      !String(previouslyLocked.back).includes(LOCK_MARKER),
      'Purchased flashcard back is still redacted'
    );
    assert(
      String(previouslyLocked.back).length > 20,
      'Purchased flashcard back is unexpectedly short'
    );
    return '200 · isProUnlocked=true · full text';
  });

  await test('GET /api/courses (purchase reflected)', async () => {
    const res = await request('/api/courses');
    expectStatus(res, 200);
    const data = expectOkJson(res);
    const demo = data.courses.find(
      (course) => course.slug === DEMO_COURSE_ID || course.id === DEMO_COURSE_ID
    );
    assert(demo, 'Demo course missing from catalog after purchase');
    assertEqual(demo.isProUnlocked, true, 'Catalog entitlement after purchase');
    return '200 · demo isProUnlocked=true';
  });

  await test('GET /api/creator-stats (70% share)', async () => {
    const res = await request(`/api/creator-stats?creator_id=${expectedCreatorId}`);
    expectStatus(res, 200);
    const data = expectOkJson(res);
    assertEqual(data.balanceToman, expectedCreatorShare, 'Creator 70% share');
    assertEqual(data.salesCount, 1, 'Creator sales count');
    assert(
      Array.isArray(data.history) && data.history.length === 1,
      'Creator sales history should contain one record'
    );
    return `200 · balance=${expectedCreatorShare} · sales=1`;
  });

  // ---------------------------------------------------------------------
  // Error reports & anti-spam shield
  // ---------------------------------------------------------------------
  const originalCardText = fixture.flashcards.find((card) => card.id === 'mc_fc_4')?.back || '';

  await test('POST /api/report-issue (AI auto-approve)', async () => {
    const res = await request('/api/report-issue', {
      method: 'POST',
      body: {
        courseId: DEMO_COURSE_ID,
        itemId: 'mc_fc_4',
        originalText: originalCardText,
        userClaim: 'در متن این کارت یک خطای علمی وجود دارد',
        sourcePage: 12
      }
    });
    expectStatus(res, 200);
    const data = expectOkJson(res);
    assert(String(data.message).includes('داور هوشمند'), 'AI approval message missing');
    assert(
      DB.reportedItemsLock[`${DEMO_COURSE_ID}_mc_fc_4`] === true,
      'Reported item was not locked'
    );
    assert(
      Object.keys(DB.pendingReports).length === 1,
      'Pending report was not stored for admin approval'
    );
    return '200 · AI-approved · item locked';
  });

  await test('POST /api/report-issue (120s cooldown)', async () => {
    const res = await request('/api/report-issue', {
      method: 'POST',
      body: {
        courseId: DEMO_COURSE_ID,
        itemId: 'mc_fc_5',
        originalText: fixture.flashcards.find((card) => card.id === 'mc_fc_5')?.back || '',
        userClaim: 'در این کارت نیز یک اشتباه محاسباتی وجود دارد',
        sourcePage: 14
      }
    });
    expectStatus(res, 429);
    assert(res.json && res.json.ok === false, 'Cooldown response should be ok=false');
    assert(String(res.json.message).includes('ثانیه'), 'Cooldown message missing wait time');
    return '429 · cooldown enforced';
  });

  await test('POST /api/report-issue (duplicate lock)', async () => {
    assert(DB.userSpamStats[DEMO_USER_ID], 'Demo user spam stats missing');
    // Move the previous report back in time to bypass the cooldown check,
    // so the item-level duplicate lock itself is exercised.
    DB.userSpamStats[DEMO_USER_ID].lastReportAt = Date.now() - 121 * 1000;

    const res = await request('/api/report-issue', {
      method: 'POST',
      body: {
        courseId: DEMO_COURSE_ID,
        itemId: 'mc_fc_4',
        originalText: originalCardText,
        userClaim: 'همان کارت را دوباره گزارش می‌کنم',
        sourcePage: 12
      }
    });
    expectStatus(res, 429);
    assert(res.json && res.json.ok === false, 'Duplicate response should be ok=false');
    assert(String(res.json.message).includes('قبلاً'), 'Duplicate lock message missing');
    return '429 · duplicate item locked';
  });

  // ---------------------------------------------------------------------
  // Raw data protection
  // ---------------------------------------------------------------------
  await test('GET /data/*.json (forbidden)', async () => {
    const res = await request(`/data/${DEMO_COURSE_ID}.json`);
    expectStatus(res, 403);
    assert(res.json && String(res.json.error).toLowerCase().includes('forbidden'), '403 body missing');
    expectHeader(res, 'x-content-type-options', 'nosniff');
    expectHeader(res, 'x-frame-options', 'ALLOWALL');
    return '403 · raw course data blocked';
  });

  // ---------------------------------------------------------------------
  // Static caching & security headers
  // ---------------------------------------------------------------------
  await test('GET /fonts/Vazirmatn.woff2 (cache)', async () => {
    const res = await request('/fonts/Vazirmatn.woff2');
    expectStatus(res, 200);
    expectHeader(res, 'content-type', 'font/woff2');
    expectHeader(res, 'cache-control', IMMUTABLE_CACHE);
    expectHeader(res, 'x-content-type-options', 'nosniff');
    expectHeader(res, 'x-frame-options', 'ALLOWALL');
    return '200 · immutable · font/woff2';
  });

  await test('GET /css/katex.min.css (cache)', async () => {
    const res = await request('/css/katex.min.css');
    expectStatus(res, 200);
    expectHeader(res, 'content-type', 'text/css; charset=utf-8');
    expectHeader(res, 'cache-control', IMMUTABLE_CACHE);
    return '200 · immutable · text/css';
  });

  await test('GET /js/katex.min.js (cache)', async () => {
    const res = await request('/js/katex.min.js');
    expectStatus(res, 200);
    expectHeader(res, 'content-type', 'application/javascript; charset=utf-8');
    expectHeader(res, 'cache-control', IMMUTABLE_CACHE);
    return '200 · immutable · application/javascript';
  });

  await test('GET /css/app.css (normal cache)', async () => {
    const res = await request('/css/app.css');
    expectStatus(res, 200);
    assert(
      res.headers.get('cache-control') !== IMMUTABLE_CACHE,
      'Non-KaTeX CSS should not be marked immutable'
    );
    return '200 · non-immutable cache policy';
  });

  await test('OPTIONS /api/courses (CORS)', async () => {
    const res = await request('/api/courses', { method: 'OPTIONS' });
    expectStatus(res, 204);
    expectHeader(res, 'access-control-allow-origin', '*');
    expectHeader(res, 'x-content-type-options', 'nosniff');
    return '204 · CORS preflight ok';
  });

  // ---------------------------------------------------------------------
  // Remaining API routes
  // ---------------------------------------------------------------------
  await test('POST /api/creator-payout (invalid sheba)', async () => {
    const res = await request('/api/creator-payout', {
      method: 'POST',
      body: { sheba: 'IR123', amount: 1000 }
    });
    expectStatus(res, 400);
    assert(res.json && res.json.ok === false, 'Invalid SHEBA should be rejected');
    assert(String(res.json.message).includes('شبا'), 'SHEBA validation message missing');
    return '400 · invalid SHEBA rejected';
  });

  await test('GET /api/payment/verify (demo redirect)', async () => {
    const res = await request(
      `/api/payment/verify?Status=OK&courseId=${DEMO_COURSE_ID}`,
      { redirect: 'manual' }
    );
    expectStatus(res, 302);
    const location = res.headers.get('location') || '';
    const target = new URL(location, baseUrl);
    assertEqual(target.searchParams.get('course'), DEMO_COURSE_ID, 'Redirect course id');
    assertEqual(target.searchParams.get('paid'), '1', 'Redirect paid flag');
    return '302 · redirect to app · paid=1';
  });

  await test('GET /unknown.js (404)', async () => {
    const res = await request('/unknown.js');
    expectStatus(res, 404);
    expectHeader(res, 'x-content-type-options', 'nosniff');
    return '404 · unknown asset handled';
  });

  // ---------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------
  const passed = results.filter((result) => result.status === 'PASS').length;
  const failed = results.length - passed;
  const totalMs = Date.now() - suiteStartedAt;

  console.log('');
  console.log('================================================================================');
  console.log('  JOZVEH SAZ - AUTOMATED SELF-TEST AUDIT (MILESTONE 6)');
  console.log('================================================================================');
  console.log(`  Server : ${baseUrl}`);
  console.log(`  DB     : ${TEMP_DB_PATH}`);
  console.log(`  Mode   : offline / isolated (Telegram + Gemini off, demo payment)`);
  console.log('');
  renderTable(results);
  console.log('');

  if (failed > 0) {
    console.log('FAILED CHECKS');
    console.log('--------------------------------------------------------------------------------');
    for (const result of results.filter((entry) => entry.status === 'FAIL')) {
      console.log(`- ${result.name}`);
      console.log(`  ${result.detail}`);
    }
    console.log('');
  }

  const summary = `${passed}/${results.length} checks passed, ${failed} failed (${totalMs} ms)`;
  console.log(`SUMMARY: ${summary}`);
  console.log(`EXIT CODE: ${failed === 0 ? 0 : 1}`);
  console.log('================================================================================');
  console.log('');

  await cleanup();
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(async (err) => {
  console.error('');
  console.error('SELF-TEST CRASHED BEFORE COMPLETION');
  console.error(err?.stack || err?.message || String(err));
  await cleanup();
  process.exitCode = 1;
});
