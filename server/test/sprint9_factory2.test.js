// server/test/sprint9_factory2.test.js
// Acceptance test suite for Sprint 9 (Milestone 9: Factory 2.0)
// 1. Factory 2.0 Database Schema & Repository (dHash, Hamming distance, duplicates)
// 2. 4-Pass OCR, KaTeX Audit with 100% Compilation Guarantee & Numeric Grounding
// 3. Stored XSS Sanitization Preserving Math
// 4. Mandatory Human Review Queue & Publishing Flow (Never Auto-Publish)
// 5. Content Takedown & Copyright Enforcement Flow

import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const testToken = '123456:SPRINT9-TEST-TOKEN';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint9-test-'));
const testDbPath = path.join(tmpDir, 'sprint9_test.db');

process.env.BOT_TOKEN = testToken;
process.env.STATE_DB_PATH = testDbPath;
process.env.PORT = '0';
process.env.ADMIN_CHAT_ID = '999999';

const {
  server,
  db,
  factoryRepo
} = await import('../server.js');

const { mintInitData } = await import('../../scripts/dev_initdata.js');
const {
  runQualityGate,
  auditAndHealKaTeXWithDrop,
  verifyNumericAndUnitGrounding,
  sanitizeTextPreservingMath,
  sanitizeCoursePackage,
  findBrokenLatexFormulas,
  validateCoursePackage,
  runFactoryPipeline
} = await import('../../factory/generate.js');

let baseUrl = '';

before(async () => {
  const createdContent = path.resolve('server/content/fluid_mechanics_01.json');
  if (fs.existsSync(createdContent)) {
    try { fs.unlinkSync(createdContent); } catch (_) {}
  }
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const createdContent = path.resolve('server/content/fluid_mechanics_01.json');
    if (fs.existsSync(createdContent)) fs.unlinkSync(createdContent);
  } catch (_) {}
});

describe('Story S9-1: Factory 2.0 Database Repository & dHash Deduplication', () => {
  it('computes exact 64-bit Hamming distance between hex hashes', () => {
    const h1 = 'ffff0000ffff0000';
    const h2 = 'ffff0000ffff0000';
    assert.equal(factoryRepo.computeHammingDistance(h1, h2), 0);

    // 1 bit flip
    const h3 = 'ffff0000ffff0001';
    assert.equal(factoryRepo.computeHammingDistance(h1, h3), 1);

    // 4 bit flips (boundary for duplicate detection)
    const h4 = 'ffff0000ffff000f';
    assert.equal(factoryRepo.computeHammingDistance(h1, h4), 4);

    // 5 bit flips (distinct)
    const h5 = 'ffff0000ffff001f';
    assert.equal(factoryRepo.computeHammingDistance(h1, h5), 5);

    // Invalid / empty hashes return 64
    assert.equal(factoryRepo.computeHammingDistance(null, h1), 64);
    assert.equal(factoryRepo.computeHammingDistance('', ''), 64);
  });

  it('detects duplicate source across different creators via SHA-256 and dHash Hamming distance <= 4', () => {
    const creatorA = 'creator_alice_101';
    const creatorB = 'creator_bob_202';

    const jobId = 'job_test_dedup_01';
    factoryRepo.createFactoryJob(db, {
      id: jobId,
      creatorId: creatorA,
      courseSlug: 'course_thermo_a',
      title: 'ترمودینامیک مهندسی',
      category: 'مهندسی مکانیک'
    });

    const pageDhash = '1234567890abcdef';
    const pageSha = 'sha256_exact_hash_test_123';
    factoryRepo.addFactoryPages(db, jobId, [{
      pageNum: 1,
      imageSha256: pageSha,
      dhash: pageDhash,
      blurScore: 75.0,
      exposureScore: 120.0
    }]);

    // Move job to human_review so it participates in duplicate checking
    factoryRepo.advanceJobState(db, jobId, 'human_review');

    // 1. Same creator A submitting same page is NOT flagged as piracy against themselves
    const checkSame = factoryRepo.checkDuplicateSource(db, {
      imageSha256: pageSha,
      dhash: pageDhash,
      creatorId: creatorA
    });
    assert.equal(checkSame.duplicate, false, 'Same creator must not be blocked against their own work');

    // 2. Creator B submitting exact same SHA-256
    const checkSha = factoryRepo.checkDuplicateSource(db, {
      imageSha256: pageSha,
      dhash: '0000000000000000',
      creatorId: creatorB
    });
    assert.equal(checkSha.duplicate, true);
    assert.equal(checkSha.reason, 'exact_sha256');

    // 3. Creator B submitting near-duplicate image (dHash Hamming distance = 2 <= 4)
    // 0x1234567890abcdef ^ 0x1234567890abcdec -> 0x0000000000000023 -> 3 bits diff
    const nearDhash = '1234567890abcdec';
    const dist = factoryRepo.computeHammingDistance(pageDhash, nearDhash);
    assert.ok(dist <= 4 && dist > 0, `Hamming distance was ${dist}`);

    const checkDhash = factoryRepo.checkDuplicateSource(db, {
      imageSha256: 'sha256_different_crop_999',
      dhash: nearDhash,
      creatorId: creatorB
    });
    assert.equal(checkDhash.duplicate, true);
    assert.equal(checkDhash.reason, 'dhash_similarity');
    assert.equal(checkDhash.matchedCourse, 'course_thermo_a');

    // 4. Creator B submitting distinct image (dHash distance > 4)
    const distinctDhash = 'ffffffffffffffff';
    const checkDistinct = factoryRepo.checkDuplicateSource(db, {
      imageSha256: 'sha256_unique_000',
      dhash: distinctDhash,
      creatorId: creatorB
    });
    assert.equal(checkDistinct.duplicate, false);
  });
});

describe('Story S9-2: Quality Gate, KaTeX 100% Audit, Grounding & XSS Neutralization', () => {
  it('Quality Gate rejects blurry (blur < 35) or poor-exposure (< 20 or > 240) pages with retake guidance', () => {
    const pages = [
      { pageNum: 1, blurScore: 60.5, exposureScore: 120.0 }, // Pass
      { pageNum: 2, blurScore: 22.0, exposureScore: 110.0 }, // Fail (blurry)
      { pageNum: 3, blurScore: 55.0, exposureScore: 15.0 },  // Fail (underexposed)
      { pageNum: 4, blurScore: 70.0, exposureScore: 245.0 }  // Fail (overexposed)
    ];

    const qg = runQualityGate(pages);
    assert.equal(qg.ok, false);
    assert.deepEqual(qg.retakePages, [2, 3, 4]);
    assert.ok(qg.reasons[2].includes('blurry'));
    assert.ok(qg.reasons[3].includes('underexposed'));
    assert.ok(qg.reasons[4].includes('overexposed'));

    // All clean pages pass
    const cleanPages = [
      { pageNum: 1, blurScore: 45.0, exposureScore: 80.0 },
      { pageNum: 2, blurScore: 90.0, exposureScore: 140.0 }
    ];
    const qgPass = runQualityGate(cleanPages);
    assert.equal(qgPass.ok, true);
    assert.equal(qgPass.retakePages.length, 0);
  });

  it('KaTeX Audit drops or heals broken LaTeX to guarantee 100% KaTeX compilation success', async () => {
    const brokenPkg = {
      id: 'test_broken_math',
      title: 'تست ریاضیات',
      summary_cheat_sheet: [
        {
          id: 's1',
          topic: 'فرمول سالم',
          key_points: ['رابطه اولیه'],
          formula_latex: '\\Delta U = Q - W', // Valid
          source_page: 1
        },
        {
          id: 's2',
          topic: 'فرمول معیوب',
          key_points: ['رابطه خراب $\\frac{x}{y$ بدون کروشه'], // Broken inline
          formula_latex: '\\sqrt[ missing', // Broken formula
          source_page: 1
        }
      ],
      flashcards: [
        {
          id: 'fc1',
          front: 'پرسش با فرمول معیوب $\\int_0^1 x dx$', // Valid
          back: 'پاسخ با فرمول ناقص $x^2 + $', // Broken inline
          is_locked: false,
          source_page: 1
        }
      ],
      exam_questions: []
    };

    const initialBroken = findBrokenLatexFormulas(brokenPkg);
    assert.ok(initialBroken.length > 0, 'Must initially detect broken formulas');

    // Run audit with drop
    const healedPkg = await auditAndHealKaTeXWithDrop(brokenPkg, 1);
    const remainingBroken = findBrokenLatexFormulas(healedPkg);

    assert.equal(remainingBroken.length, 0, '100% of remaining formulas MUST compile cleanly in KaTeX');
  });

  it('Numeric & unit grounding tags ungrounded numbers or low-confidence pages as needsReview', () => {
    const courseObj = {
      id: 'grounding_test',
      title: 'تست تطابق عددی',
      summary_cheat_sheet: [],
      flashcards: [
        {
          id: 'fc1',
          front: 'دمای فرایند چقدر است؟',
          back: 'دمای اندازه گیری شده برابر 500 درجه کلوین است.',
          source_page: 1
        },
        {
          id: 'fc2',
          front: 'فشار مخزن چقدر است؟',
          back: 'فشار برابر 999 پاسکال است.', // 999 does NOT exist in page 1 transcription!
          source_page: 1
        }
      ],
      exam_questions: []
    };

    const pages = [
      {
        pageNum: 1,
        confidence: 0.95,
        transcription: {
          blocks: [
            { type: 'text', content: 'در آزمایش دمای ثبت شده ۵۰۰ کلوین بود.' } // Persian digits 500
          ]
        }
      }
    ];

    const report = verifyNumericAndUnitGrounding(courseObj, pages);
    assert.equal(report.ok, false);
    assert.equal(report.flaggedItems.length, 1);
    assert.equal(courseObj.flashcards[0].needsReview, false);
    assert.equal(courseObj.flashcards[1].needsReview, true);
    assert.ok(courseObj.flashcards[1].reviewReason.includes('999'));
  });

  it('neutralizes stored XSS injection while strictly preserving LaTeX math syntax', () => {
    const maliciousInput = 'نکته مهم: <script>alert("xss")</script> فرمول $E = m c^2$ و رابطه $x < y$ همراه با <img src=x onerror=steal()>';
    const sanitized = sanitizeTextPreservingMath(maliciousInput);

    // Dangerous tags MUST be escaped
    assert.ok(!sanitized.includes('<script>'));
    assert.ok(sanitized.includes('&lt;script&gt;'));
    assert.ok(!sanitized.includes('<img'));
    assert.ok(sanitized.includes('&lt;img'));

    // KaTeX math segments MUST remain intact
    assert.ok(sanitized.includes('$E = m c^2$'));
    assert.ok(sanitized.includes('$x < y$'));
  });
});

describe('Story S9-3: Factory Endpoints, Human Review Gate & Content Takedown', () => {
  const creatorId = 888777;
  const creatorAuth = mintInitData({ id: creatorId, first_name: 'Reza' }, testToken);

  it('POST /api/factory/jobs rejects blurry pages with 422 QUALITY_GATE_FAILED', async () => {
    const res = await fetch(`${baseUrl}/api/factory/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': creatorAuth
      },
      body: JSON.stringify({
        title: 'جزوه دست‌نویس فیزیک',
        pages: [
          { pageNum: 1, blurScore: 18.0, exposureScore: 100.0, dhash: '1111222233334444', imageSha256: 'sha_blur_1' }
        ]
      })
    });

    assert.equal(res.status, 422);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.code, 'QUALITY_GATE_FAILED');
    assert.deepEqual(data.retakePages, [1]);
  });

  it('POST /api/factory/jobs creates job in state human_review and NEVER auto-publishes to /api/courses', async () => {
    const res = await fetch(`${baseUrl}/api/factory/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': creatorAuth
      },
      body: JSON.stringify({
        courseSlug: 'fluid_mechanics_01',
        title: 'مکانیک سیالات پیشرفته',
        priceToman: 49000,
        pages: [
          {
            pageNum: 1,
            blurScore: 65.0,
            exposureScore: 120.0,
            dhash: 'abcdef0123456789',
            imageSha256: 'sha_fluid_p1',
            transcription: {
              blocks: [
                { type: 'text', content: 'معادله ناویر استوکس و تغییر فشار برابر 50 پاسکال است.' },
                { type: 'formula', content: 'P_1 + \\frac{1}{2}\\rho v^2 = C' }
              ]
            }
          }
        ]
      })
    });

    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.state, 'human_review');
    assert.ok(data.jobId);
    assert.ok(data.draft);

    // CRITICAL INVARIANT: The course MUST NOT appear in /api/courses while in human_review!
    const catRes = await fetch(`${baseUrl}/api/courses`);
    const catData = await catRes.json();
    const foundInCatalog = (catData.courses || []).some((c) => c.slug === 'fluid_mechanics_01');
    assert.equal(foundInCatalog, false, 'Unapproved factory job must NOT appear in public catalog');

    // Duplicate check: Another creator trying to upload the same page gets 409 DUPLICATE_SOURCE
    const otherCreatorAuth = mintInitData({ id: 999111, first_name: 'Pirate' }, testToken);
    const dupRes = await fetch(`${baseUrl}/api/factory/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': otherCreatorAuth
      },
      body: JSON.stringify({
        courseSlug: 'pirated_course',
        title: 'جزوه کپی شده',
        pages: [
          { pageNum: 1, blurScore: 65.0, exposureScore: 120.0, dhash: 'abcdef0123456789', imageSha256: 'sha_fluid_p1' }
        ]
      })
    });
    assert.equal(dupRes.status, 409);
    const dupData = await dupRes.json();
    assert.equal(dupData.code, 'DUPLICATE_SOURCE');
  });

  it('POST /api/factory/jobs/:id/publish validates package, sanitizes XSS, and publishes to /api/courses', async () => {
    // 1. Get creator jobs
    const listRes = await fetch(`${baseUrl}/api/factory/jobs`, {
      headers: { 'X-Telegram-Init-Data': creatorAuth }
    });
    const listData = await listRes.json();
    assert.ok(listData.jobs.length > 0);
    const targetJob = listData.jobs[0];

    // 2. Creator reviews and submits edited draft with malicious HTML injection
    const draftWithXss = JSON.parse(JSON.stringify(targetJob.draft));
    draftWithXss.flashcards[0].front = 'پرسش اصلاح‌شده <script>alert("hacked")</script> با رابطه $P = 50 Pa$';

    const pubRes = await fetch(`${baseUrl}/api/factory/jobs/${targetJob.id}/publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': creatorAuth
      },
      body: JSON.stringify({ draft: draftWithXss })
    });

    assert.equal(pubRes.status, 200);
    const pubData = await pubRes.json();
    assert.equal(pubData.ok, true);
    assert.equal(pubData.state, 'published');

    // 3. The course now appears in /api/courses
    const catRes = await fetch(`${baseUrl}/api/courses`);
    const catData = await catRes.json();
    const publishedCourse = (catData.courses || []).find((c) => c.slug === targetJob.course_slug);
    assert.ok(publishedCourse, 'Course must now appear in catalog');

    // 4. GET /api/course serves sanitized content
    const courseRes = await fetch(`${baseUrl}/api/course?id=${targetJob.course_slug}`);
    assert.equal(courseRes.status, 200);
    const courseData = await courseRes.json();
    const firstFcFront = courseData.course.flashcards[0].front;

    assert.ok(!firstFcFront.includes('<script>'), 'Dangerous script tag must be sanitized');
    assert.ok(firstFcFront.includes('&lt;script&gt;'));
    assert.ok(firstFcFront.includes('$P = 50 Pa$'), 'KaTeX math must remain intact');
  });

  it('Content Takedown flow: reporting and approving takedown immediately suppresses course from catalog', async () => {
    // 1. Submit takedown request
    const takeRes = await fetch(`${baseUrl}/api/takedown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courseId: 'fluid_mechanics_01',
        reason: 'کپی‌رایت غیرمجاز از جزوه دست‌نویس استاد شریف'
      })
    });
    assert.equal(takeRes.status, 200);
    const takeData = await takeRes.json();
    assert.ok(takeData.takedownId);
    assert.equal(takeData.status, 'pending');

    // 2. Admin approves takedown request
    factoryRepo.resolveTakedownRequest(db, {
      id: takeData.takedownId,
      approve: true
    });

    // Verify DB flag
    assert.equal(factoryRepo.isCourseTakedown(db, 'fluid_mechanics_01'), true);

    // 3. Course is immediately hidden from /api/courses
    const catRes = await fetch(`${baseUrl}/api/courses`);
    const catData = await catRes.json();
    const found = (catData.courses || []).some((c) => c.slug === 'fluid_mechanics_01');
    assert.equal(found, false, 'Takedown course must be suppressed from /api/courses');

    // 4. Direct GET /api/course returns 404 with COURSE_TAKEDOWN
    const courseRes = await fetch(`${baseUrl}/api/course?id=fluid_mechanics_01`);
    assert.equal(courseRes.status, 404);
    const errData = await courseRes.json();
    assert.equal(errData.code, 'COURSE_TAKEDOWN');
  });
});
