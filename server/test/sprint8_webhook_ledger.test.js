// server/test/sprint8_webhook_ledger.test.js
// Acceptance test suite for Sprint 8 (Milestone 8)
// 1. Idempotent Telegram Update Inbox & Webhook Engine
// 2. Bank Identification, Payout Minimums & Sheba Cooling-Off
// 3. Payment Reconciliation & Financial Ledger Invariant Audit
// 4. Zero-Cost Render Ephemeral Backup & Fallback Key

import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const testToken = '123456:SPRINT8-TEST-TOKEN';
const webhookSecret = 'super_secret_webhook_token_xyz_999';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint8-test-'));
const testDbPath = path.join(tmpDir, 'sprint8_test.db');

process.env.BOT_TOKEN = testToken;
process.env.WEBHOOK_SECRET = webhookSecret;
process.env.STATE_DB_PATH = testDbPath;
process.env.PORT = '0';
process.env.MIN_PAYOUT_TOMAN = '50000';
delete process.env.BACKUP_KEY; // Verify fallback generation

const {
  server,
  db,
  commerceRepo,
  inboxRepo
} = await import('../server.js');

const { config, loadConfig } = await import('../config.js');

const { handleUpdate } = await import('../bot.js');
const { openDb, migrate } = await import('../db.js');
const { getShebaBankName, shebaBankCode, isValidSheba } = await import('../sheba.js');
const { createEncryptedBackup } = await import('../../scripts/backup.js');
const { restoreEncryptedBackup } = await import('../../scripts/restore.js');

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

describe('Story S8-1: Idempotent Telegram Inbox & Deduplication Engine', () => {
  it('replaying the exact same update_id 100 times executes the handler exactly once', async () => {
    const updateId = 888001;
    const testUpdate = {
      update_id: updateId,
      message: {
        message_id: 1,
        chat: { id: 777001 },
        from: { id: 777001, username: 'student_tester' },
        text: '/start'
      }
    };

    // Fire 100 concurrent or rapid invocations of handleUpdate
    const results = await Promise.all(
      Array.from({ length: 100 }, () => handleUpdate(testUpdate))
    );

    const nonDuplicates = results.filter((r) => !r.duplicate);
    const duplicates = results.filter((r) => r.duplicate);

    assert.equal(nonDuplicates.length, 1, 'Exactly one invocation must claim and process the update');
    assert.equal(duplicates.length, 99, 'All other 99 invocations must be recognized as duplicate');

    // Verify database state: exactly 1 entry in tg_inbox with status 'processed'
    const status = inboxRepo.getInboxStatus(db, updateId);
    assert.ok(status, 'Inbox status row must exist');
    assert.equal(status.status, 'processed');

    const totalRows = db.prepare('SELECT COUNT(*) AS c FROM tg_inbox WHERE update_id = ?').get(updateId);
    assert.equal(totalRows.c, 1);
  });

  it('replaying the exact same callback_query.id deduplicates callbacks atomically', async () => {
    const cbId = 'cb_query_unique_999';
    const firstClaim = inboxRepo.claimCallback(db, cbId);
    assert.equal(firstClaim.duplicate, false);

    for (let i = 0; i < 20; i++) {
      const replayed = inboxRepo.claimCallback(db, cbId);
      assert.equal(replayed.duplicate, true);
    }
  });

  it('persists and loads polling lastUpdateId in the meta table', () => {
    inboxRepo.setLastUpdateId(db, 994411);
    const loaded = inboxRepo.getLastUpdateId(db);
    assert.equal(loaded, 994411);

    inboxRepo.setLastUpdateId(db, 994412);
    assert.equal(inboxRepo.getLastUpdateId(db), 994412);
  });
});

describe('Story S8-1: Webhook Endpoint & Secret Authentication', () => {
  it('rejects POST /api/telegram-webhook without or with wrong secret token with 401', async () => {
    // Missing header
    const resNoToken = await fetch(`${baseUrl}/api/telegram-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ update_id: 100001 })
    });
    assert.equal(resNoToken.status, 401);

    // Wrong header
    const resWrongToken = await fetch(`${baseUrl}/api/telegram-webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'wrong_invalid_secret_token'
      },
      body: JSON.stringify({ update_id: 100002 })
    });
    assert.equal(resWrongToken.status, 401);
  });

  it('accepts valid secret token and returns 200 immediately, deduplicating 50 concurrent requests', async () => {
    const updateId = 100050;
    const payload = JSON.stringify({
      update_id: updateId,
      message: {
        message_id: 50,
        chat: { id: 777050 },
        from: { id: 777050 },
        text: '/start'
      }
    });

    const requests = Array.from({ length: 50 }, () =>
      fetch(`${baseUrl}/api/telegram-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': webhookSecret
        },
        body: payload
      })
    );

    const responses = await Promise.all(requests);
    for (const res of responses) {
      assert.equal(res.status, 200);
    }

    const bodies = await Promise.all(responses.map((r) => r.json()));
    const firstAccepted = bodies.filter((b) => b.ok && !b.duplicate);
    const duplicates = bodies.filter((b) => b.ok && b.duplicate);

    assert.equal(firstAccepted.length, 1);
    assert.equal(duplicates.length, 49);
  });
});

describe('Story S8-2: Bank Identification, Payout Minimums & Sheba Cooling-Off', () => {
  it('resolves Iranian bank names from standard IBAN codes accurately with fallback', () => {
    assert.equal(getShebaBankName('IR010170000000123456789012'), 'بانک ملی ایران');
    assert.equal(getShebaBankName('IR010120000000123456789012'), 'بانک ملت');
    assert.equal(getShebaBankName('IR010560000000123456789012'), 'بانک سامان');
    assert.equal(getShebaBankName('IR010570000000123456789012'), 'بانک پاسارگاد');
    assert.equal(getShebaBankName('IR010180000000123456789012'), 'بانک تجارت');
    assert.equal(getShebaBankName('IR010190000000123456789012'), 'بانک صادرات ایران');
    assert.equal(getShebaBankName('IR010150000000123456789012'), 'بانک سپه');
    assert.equal(getShebaBankName('IR010160000000123456789012'), 'بانک کشاورزی');
    assert.equal(getShebaBankName('IR010140000000123456789012'), 'بانک مسکن');
    assert.equal(getShebaBankName('IR010620000000123456789012'), 'بانک آینده');
    assert.equal(getShebaBankName('IR010700000000123456789012'), 'بانک قرض‌الحسنه رسالت');

    // Unknown code falls back cleanly
    assert.equal(getShebaBankName('IR019990000000123456789012'), 'بانک عضو شبکه شتاب');
  });

  it('rejects payouts below MIN_PAYOUT_TOMAN (50,000 Toman)', () => {
    const creatorId = 'creator_low_balance';
    // Seed 100,000 balance
    commerceRepo.recordSale(db, {
      buyerId: 101,
      courseId: 'eng_math_01',
      creatorId,
      priceToman: 100000,
      source: 'zarinpal',
      paymentRef: 'ref_low_test'
    });

    const goodShebaMelli = (() => {
      const b = '0170000000123456789012';
      return 'IR' + String(98n - (BigInt(b + '182700') % 97n)).padStart(2, '0') + b;
    })();

    // Attempt payout of 30,000 Toman (below 50,000 threshold)
    const lowRes = commerceRepo.requestPayout(db, {
      creatorId,
      sheba: goodShebaMelli,
      amountToman: 30000,
      payoutId: 'payout_too_low',
      minPayoutToman: 50000
    });

    assert.equal(lowRes.ok, false);
    assert.equal(lowRes.reason, 'below_minimum');

    // Attempt payout of 60,000 Toman (above threshold) -> succeeds
    const validRes = commerceRepo.requestPayout(db, {
      creatorId,
      sheba: goodShebaMelli,
      amountToman: 60000,
      payoutId: 'payout_valid_amt',
      minPayoutToman: 50000
    });
    assert.equal(validRes.ok, true);
  });

  it('detects Sheba change for creator and records previous Sheba for security audit', () => {
    const creatorId = 'creator_sheba_tracker';
    const sheba1 = (() => {
      const b = '0170000000123456789012'; // Melli
      return 'IR' + String(98n - (BigInt(b + '182700') % 97n)).padStart(2, '0') + b;
    })();
    const sheba2 = (() => {
      const b = '0120000000123456789012'; // Mellat
      return 'IR' + String(98n - (BigInt(b + '182700') % 97n)).padStart(2, '0') + b;
    })();

    // Initial registration
    const r1 = commerceRepo.recordCreatorSheba(db, {
      creatorId,
      sheba: sheba1,
      bankName: getShebaBankName(sheba1)
    });
    assert.equal(r1.isChanged, false);
    assert.equal(r1.previousSheba, null);
    assert.equal(r1.bankName, 'بانک ملی ایران');

    // Same Sheba again -> not changed
    const rSame = commerceRepo.recordCreatorSheba(db, {
      creatorId,
      sheba: sheba1,
      bankName: getShebaBankName(sheba1)
    });
    assert.equal(rSame.isChanged, false);

    // Changed Sheba -> flags isChanged: true
    const r2 = commerceRepo.recordCreatorSheba(db, {
      creatorId,
      sheba: sheba2,
      bankName: getShebaBankName(sheba2)
    });
    assert.equal(r2.isChanged, true);
    assert.equal(r2.previousSheba, sheba1);
    assert.equal(r2.bankName, 'بانک ملت');
  });
});

describe('Story S8-3: Payment Reconciliation & Ledger Invariant Audit', () => {
  it('reconciles stale payment intents older than maxAgeMs to expired', () => {
    const now = Date.now();
    // 1. Create a stale intent (25 minutes old)
    commerceRepo.createPaymentIntent(db, {
      authority: 'auth_stale_25m',
      userId: 501,
      courseId: 'eng_math_01',
      amountToman: 65000,
      state: 'redirected',
      now: now - 25 * 60 * 1000
    });

    // 2. Create a fresh intent (3 minutes old)
    commerceRepo.createPaymentIntent(db, {
      authority: 'auth_fresh_3m',
      userId: 502,
      courseId: 'eng_math_01',
      amountToman: 65000,
      state: 'redirected',
      now: now - 3 * 60 * 1000
    });

    // Run reconciliation with 15-minute threshold
    const res = commerceRepo.reconcileStalePaymentIntents(db, { now, maxAgeMs: 15 * 60 * 1000 });
    assert.equal(res.reconciledCount, 1);
    assert.deepEqual(res.expiredAuthorities, ['auth_stale_25m']);

    const staleIntent = commerceRepo.getPaymentIntent(db, 'auth_stale_25m');
    assert.equal(staleIntent.state, 'expired');

    const freshIntent = commerceRepo.getPaymentIntent(db, 'auth_fresh_3m');
    assert.equal(freshIntent.state, 'redirected');
  });

  it('verifyLedgerInvariant asserts zero discrepancy across sales, creator ledger, and payouts', () => {
    const isolatedDb = new DatabaseSync(path.join(tmpDir, 'ledger_test.db'));
    migrate(isolatedDb);

    // Record 3 sales for cr_ledger_1
    commerceRepo.recordSale(isolatedDb, {
      buyerId: 1, courseId: 'eng_math_01', creatorId: 'cr_ledger_1',
      priceToman: 100000, source: 'zarinpal', paymentRef: 'sale_1'
    });
    commerceRepo.recordSale(isolatedDb, {
      buyerId: 2, courseId: 'eng_math_01', creatorId: 'cr_ledger_1',
      priceToman: 50000, source: 'zarinpal', paymentRef: 'sale_2'
    });
    // Sale for cr_ledger_2
    commerceRepo.recordSale(isolatedDb, {
      buyerId: 3, courseId: 'eng_math_01', creatorId: 'cr_ledger_2',
      priceToman: 70000, source: 'zarinpal', paymentRef: 'sale_3'
    });

    // Request payout 1 (approved)
    const p1 = commerceRepo.requestPayout(isolatedDb, {
      creatorId: 'cr_ledger_1', sheba: 'IR010170000000123456789012',
      amountToman: 50000, payoutId: 'payout_inv_1'
    });
    assert.equal(p1.ok, true);
    commerceRepo.resolvePayout(isolatedDb, { payoutId: 'payout_inv_1', approve: true });

    // Request payout 2 (rejected, released)
    const p2 = commerceRepo.requestPayout(isolatedDb, {
      creatorId: 'cr_ledger_1', sheba: 'IR010170000000123456789012',
      amountToman: 30000, payoutId: 'payout_inv_2'
    });
    assert.equal(p2.ok, true);
    commerceRepo.resolvePayout(isolatedDb, { payoutId: 'payout_inv_2', approve: false });

    // Request payout 3 (still pending hold)
    const p3 = commerceRepo.requestPayout(isolatedDb, {
      creatorId: 'cr_ledger_2', sheba: 'IR010120000000123456789012',
      amountToman: 40000, payoutId: 'payout_inv_3'
    });
    assert.equal(p3.ok, true);

    // Check invariant
    const audit = commerceRepo.verifyLedgerInvariant(isolatedDb);
    assert.equal(audit.ok, true, 'Ledger invariant must hold with 0 discrepancy');
    assert.equal(audit.diff, 0);
    assert.equal(audit.creditDiff, 0);
    assert.equal(audit.balanceDiff, 0);

    isolatedDb.close();
  });
});

describe('Story S8-4: Zero-Cost Render Ephemeral Backup & Deterministic Key', () => {
  it('derives a deterministic fallback BACKUP_KEY from BOT_TOKEN when BACKUP_KEY is omitted', async () => {
    // Verified that process.env.BACKUP_KEY was deleted before import
    assert.ok(config.backupKey, 'config.backupKey must have a non-empty fallback value');
    assert.equal(typeof config.backupKey, 'string');
    assert.equal(config.backupKey.length, 64, 'SHA-256 HMAC hex digest is 64 characters');

    // Verify round-trip backup and restore using the fallback key
    const snapPath = path.join(tmpDir, 'fallback_key_source.db');
    const sDb = new DatabaseSync(snapPath);
    sDb.exec("CREATE TABLE test_table(id INT, name TEXT); INSERT INTO test_table VALUES (1, 'render_ephemeral');");
    sDb.close();

    const backupFile = path.join(tmpDir, 'fallback_backup.enc');
    const bRes = await createEncryptedBackup({
      dbPath: snapPath,
      outputPath: backupFile
      // backupKey omitted -> uses deterministic fallback
    });
    assert.equal(bRes.ok, true);

    const restoreTarget = path.join(tmpDir, 'fallback_restored.db');
    const rRes = await restoreEncryptedBackup({
      inputPath: backupFile,
      outputPath: restoreTarget
      // backupKey omitted -> uses deterministic fallback
    });
    assert.equal(rRes.ok, true);
    assert.equal(rRes.integrity, 'ok');

    const verifyDb = new DatabaseSync(restoreTarget);
    const row = verifyDb.prepare('SELECT name FROM test_table WHERE id = 1').get();
    assert.equal(row.name, 'render_ephemeral');
    verifyDb.close();
  });
});
