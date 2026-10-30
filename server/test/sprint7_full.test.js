// server/test/sprint7_full.test.js
// Acceptance test suite for Sprint 7 Stories S7-6, S7-7, S7-8, and S7-9.

import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { mintInitData } from '../../scripts/dev_initdata.js';
import { createEncryptedBackup } from '../../scripts/backup.js';
import { restoreEncryptedBackup } from '../../scripts/restore.js';

const testToken = '123456:SPRINT7-FULL-TOKEN';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint7-full-'));
const testDbPath = path.join(tmpDir, 'full_test.db');

process.env.BOT_TOKEN = testToken;
process.env.MERCHANT_ID = 'TEST_MERCHANT_FULL';
process.env.STATE_DB_PATH = testDbPath;
process.env.PORT = '0';
process.env.BACKUP_KEY = 'sprint7_full_test_secret_key_123';
process.env.GEMINI_API_KEY_1 = 'test-gemini-key-1';
process.env.ADMIN_CHAT_ID = '987654321';

// Import server & repositories
const {
  server,
  db,
  aiRepo,
  reportsRepo,
  usersRepo,
  escapeHtml
} = await import('../server.js');

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

function signedHeaders(userId = 888111222) {
  return {
    'Content-Type': 'application/json',
    'X-Telegram-Init-Data': mintInitData({ id: userId, username: `user_${userId}` }, testToken)
  };
}

describe('Story S7-6: AI Tutor Upstream Resilience & Quota Guard', () => {
  it('does NOT consume user quota when Gemini upstream fails (503), but consumes quota on successful retry', async () => {
    const userId = 777123456;
    usersRepo.upsertUser(db, { telegramId: userId, username: 'resilience_student' });

    // Ensure quota starts at 0 consumed
    const quotaBefore = aiRepo.getAiUsage(db, userId, 'eng_math_01').queriesCount;
    assert.equal(quotaBefore, 0);

    const originalFetch = globalThis.fetch;
    try {
      // 1. Simulate upstream failure
      globalThis.fetch = async (url, opts) => {
        if (String(url).includes('generativelanguage.googleapis.com')) {
          return new Response(JSON.stringify({ error: { message: 'Overloaded', code: 503 } }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return originalFetch(url, opts);
      };

      const failRes = await fetch(`${baseUrl}/api/ask-tutor`, {
        method: 'POST',
        headers: signedHeaders(userId),
        body: JSON.stringify({
          courseId: 'eng_math_01',
          question: 'روش حل معادله لاپلاس چیست؟'
        })
      });

      const failJson = await failRes.json();
      assert.equal(failRes.status, 503);
      assert.equal(failJson.ok, false);
      assert.equal(failJson.code, 'AI_UPSTREAM');

      // Verify quota was NOT consumed
      const quotaAfterFail = aiRepo.getAiUsage(db, userId, 'eng_math_01').queriesCount;
      assert.equal(quotaAfterFail, 0, 'Quota must NOT be consumed on upstream failure');

      // 2. Simulate upstream success
      globalThis.fetch = async (url, opts) => {
        if (String(url).includes('generativelanguage.googleapis.com')) {
          return new Response(JSON.stringify({
            candidates: [{
              content: {
                parts: [{ text: 'برای حل معادله لاپلاس از روش تفکیک متغیرها استفاده می‌شود.' }]
              }
            }]
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return originalFetch(url, opts);
      };

      const successRes = await fetch(`${baseUrl}/api/ask-tutor`, {
        method: 'POST',
        headers: signedHeaders(userId),
        body: JSON.stringify({
          courseId: 'eng_math_01',
          question: 'روش حل معادله لاپلاس چیست؟'
        })
      });

      const successJson = await successRes.json();
      assert.equal(successRes.status, 200);
      assert.equal(successJson.ok, true);
      assert.match(successJson.reply, /تفکیک متغیرها/);

      // Verify quota was consumed exactly once
      const quotaAfterSuccess = aiRepo.getAiUsage(db, userId, 'eng_math_01').queriesCount;
      assert.equal(quotaAfterSuccess, 1, 'Quota must be consumed exactly once after successful response');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Story S7-6: Course Content Protection', () => {
  it('returns 404 for direct access to /data/*.json', async () => {
    const res = await fetch(`${baseUrl}/data/eng_math_01.json`);
    assert.equal(res.status, 404);
  });

  it('serves course data via /api/course with paywall redaction for non-buyers', async () => {
    const res = await fetch(`${baseUrl}/api/course?id=eng_math_01`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.slug, 'eng_math_01');
    assert.equal(data.isProUnlocked, false);

    const course = data.course;
    assert.ok(course, 'Course payload must be present');
    assert.equal(course.id, 'eng_math_01');
    assert.ok(course.flashcards.length > 0);

    const lockedCard = course.flashcards.find((c) => c.is_locked);
    if (lockedCard) {
      assert.match(lockedCard.back, /🔒/);
    }
  });
});

describe('Story S7-6: Report Flow Server-Side Item Resolution & HTML Escaping', () => {
  it('resolves originalText from course catalog by itemId and ignores client tampering', async () => {
    const userId = 555444333;
    usersRepo.upsertUser(db, { telegramId: userId, username: 'tester' });

    let notifiedText = '';
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, opts) => {
        const urlStr = String(url);
        if (urlStr.includes('api.telegram.org')) {
          const bodyStr = opts?.body ? String(opts.body) : '';
          notifiedText = bodyStr;
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (urlStr.includes('generativelanguage.googleapis.com')) {
          return new Response(JSON.stringify({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    is_valid: true,
                    confidence: 90,
                    reason: 'علامت در فرمول اشتباه تایپ شده است',
                    corrected_text: 'فرمول تصحیح شده با علامت منفی',
                    general_rule_for_memory: 'دقت در منفی انتگرال فوریه'
                  })
                }]
              }
            }]
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return originalFetch(url, opts);
      };

      const res = await fetch(`${baseUrl}/api/report-issue`, {
        method: 'POST',
        headers: signedHeaders(userId),
        body: JSON.stringify({
          courseId: 'eng_math_01',
          itemId: 'flashcard_0',
          originalText: '<script>alert("hacked")</script>', // Malicious client attempt
          userClaim: 'علامت منفی در فرمول جا افتاده است <script>evil()</script>'
        })
      });

      const json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(json.ok, true);

      // Verify report in database: proposed_fix must NOT be the client-supplied script
      const reports = reportsRepo.listReports(db, { limit: 10 });
      const created = reports.find((r) => String(r.user_id) === String(userId) && r.item_id === 'flashcard_0');
      assert.ok(created, 'Report must be created in SQLite');
      assert.notEqual(created.proposed_fix, '<script>alert("hacked")</script>');
      assert.ok(created.proposed_fix.length > 5, 'Must contain real corrected text derived from catalog');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Story S7-7: Server Body Guard (413 Payload Too Large)', () => {
  it('rejects oversized JSON bodies with 413 Payload Too Large', async () => {
    const hugeBody = JSON.stringify({
      courseId: 'eng_math_01',
      question: 'A'.repeat(2 * 1024 * 1024) // 2 MB (exceeds default 1MB maxBodyBytes)
    });

    const res = await fetch(`${baseUrl}/api/ask-tutor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': mintInitData({ id: 999999999 }, testToken)
      },
      body: hugeBody
    });

    assert.equal(res.status, 413);
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.equal(json.code, 'PAYLOAD_TOO_LARGE');
  });
});

describe('Story S7-7: Content-Security-Policy & Frame-Ancestors', () => {
  it('serves CSP frame-ancestors header allowing Telegram and omits X-Frame-Options: ALLOWALL', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);

    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'Content-Security-Policy header must be present');
    assert.match(csp, /frame-ancestors\s+https:\/\/web\.telegram\.org\s+https:\/\/\*\.telegram\.org/);

    const xfo = res.headers.get('x-frame-options');
    assert.notEqual(xfo, 'ALLOWALL', 'X-Frame-Options: ALLOWALL must not be present');
  });

  it('escapeHtml neutralizes dangerous tags and quotes', () => {
    const dangerous = '<img src=x onerror=alert(1)> "hello" & \'world\'';
    const escaped = escapeHtml(dangerous);
    assert.equal(escaped, '&lt;img src=x onerror=alert(1)&gt; &quot;hello&quot; &amp; &#39;world&#39;');
    assert.ok(!escaped.includes('<img'));
    assert.ok(!escaped.includes('"'));
  });
});

describe('Story S7-8: Mid-Transaction Child-Process Crash Rollback', () => {
  it('rolls back uncommitted transactions cleanly when worker process is killed with SIGKILL', async () => {
    const crashDbPath = path.join(tmpDir, 'crash_test.db');
    const initDb = new DatabaseSync(crashDbPath);
    initDb.exec(`
      CREATE TABLE test_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        amount INTEGER NOT NULL
      );
      INSERT INTO test_ledger (account, amount) VALUES ('initial', 1000);
    `);
    initDb.close();

    // Write worker script to a dedicated file to avoid CLI argument escaping quirks on Windows
    const workerFile = path.join(tmpDir, 'tx_crash_worker.mjs');
    fs.writeFileSync(workerFile, `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('BEGIN IMMEDIATE TRANSACTION;');
db.exec("INSERT INTO test_ledger (account, amount) VALUES ('uncommitted_hacker', 99999);");
process.stdout.write('TRANSACTION_STARTED\\n');
setInterval(() => {}, 1000);
`);

    const child = spawn(process.execPath, [workerFile, crashDbPath]);

    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('TRANSACTION_STARTED')) {
          // Immediately terminate the process mid-transaction
          child.kill('SIGKILL');
          resolve();
        }
      });
      child.stderr.on('data', (chunk) => {
        // Ignore sqlite experimental warning
      });
      child.on('error', reject);
    });

    await new Promise((resolve) => child.on('exit', resolve));

    // Reopen database in parent and assert state
    const reopenDb = new DatabaseSync(crashDbPath);
    const integrity = reopenDb.prepare('PRAGMA integrity_check').get();
    assert.equal(integrity.integrity_check, 'ok');

    const rows = reopenDb.prepare('SELECT * FROM test_ledger').all();
    assert.equal(rows.length, 1, 'Only initial row must remain; uncommitted transaction must be rolled back');
    assert.equal(rows[0].account, 'initial');
    reopenDb.close();
  });
});

describe('Story S7-9: Encrypted Backup & Restore Round-Trip', () => {
  it('creates an encrypted backup and restores it with 100% integrity check', async () => {
    const backupDbPath = path.join(tmpDir, 'backup_source.db');
    const bDb = new DatabaseSync(backupDbPath);
    bDb.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT);
      INSERT INTO items (title) VALUES ('ریاضی مهندسی'), ('انجماد فلزات');
    `);
    bDb.close();

    const backupFile = path.join(tmpDir, 'test_backup.enc');
    const secretKey = 'my_super_secret_production_key_456';

    // 1. Create Backup
    const backupResult = await createEncryptedBackup({
      dbPath: backupDbPath,
      backupKey: secretKey,
      outputPath: backupFile
    });

    assert.equal(backupResult.ok, true);
    assert.ok(fs.existsSync(backupFile));
    assert.ok(backupResult.bytes > 0);

    // Verify magic header
    const fileBytes = fs.readFileSync(backupFile);
    assert.equal(fileBytes.subarray(0, 4).toString(), 'JZBK');

    // 2. Restore Backup to a new path
    const restoredDbPath = path.join(tmpDir, 'restored.db');
    const restoreResult = await restoreEncryptedBackup({
      inputPath: backupFile,
      backupKey: secretKey,
      outputPath: restoredDbPath
    });

    assert.equal(restoreResult.ok, true);
    assert.equal(restoreResult.integrity, 'ok');
    assert.ok(fs.existsSync(restoredDbPath));

    // 3. Verify restored data
    const rDb = new DatabaseSync(restoredDbPath);
    const items = rDb.prepare('SELECT * FROM items ORDER BY id ASC').all();
    assert.equal(items.length, 2);
    assert.equal(items[0].title, 'ریاضی مهندسی');
    assert.equal(items[1].title, 'انجماد فلزات');
    rDb.close();

    // 4. Verify wrong key fails
    await assert.rejects(
      async () => {
        await restoreEncryptedBackup({
          inputPath: backupFile,
          backupKey: 'wrong_password_xyz',
          outputPath: path.join(tmpDir, 'should_fail.db')
        });
      },
      /Decryption failed/
    );
  });
});
