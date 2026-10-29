import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { validateConfig, loadConfig } from '../config.js';
import { verifyInitData, requireUser, optionalUser, HttpError } from '../auth.js';
import { mintInitData } from '../../scripts/dev_initdata.js';
import { openDb, migrate, tx, balanceOf, splitPrice, recordSale } from '../db.js';
import * as commerceRepo from '../repo/commerce.js';
import { createFakeGateway } from './fake_gateway.js';
import { migrateJson } from '../migrate_json.js';

// Setup isolated temp environment for DB tests
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint7-test-'));
const testToken = '123456:SPRINT7-TEST-TOKEN';
process.env.BOT_TOKEN = testToken;
process.env.MERCHANT_ID = 'test-merchant-id';
process.env.STATE_DB_PATH = path.join(tmpDir, 'state.json');

describe('Story S7-1: Configuration Validation & Health', () => {
  it('rejects missing BOT_TOKEN in production', () => {
    const res = validateConfig({ NODE_ENV: 'production', BOT_TOKEN: '' });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes('BOT_TOKEN')));
  });

  it('rejects ALLOW_DEMO_PAYMENTS in production', () => {
    const res = validateConfig({
      NODE_ENV: 'production',
      BOT_TOKEN: 'token',
      MERCHANT_ID: 'real-merchant',
      ALLOW_DEMO_PAYMENTS: '1'
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes('ALLOW_DEMO_PAYMENTS')));
  });

  it('rejects demo or empty MERCHANT_ID in production', () => {
    const resDemo = validateConfig({
      NODE_ENV: 'production',
      BOT_TOKEN: 'token',
      MERCHANT_ID: 'demo'
    });
    assert.equal(resDemo.valid, false);
    assert.ok(resDemo.errors.some((e) => e.includes('MERCHANT_ID')));

    const resPlaceholder = validateConfig({
      NODE_ENV: 'production',
      BOT_TOKEN: 'token',
      MERCHANT_ID: 'YOUR_MERCHANT_ID'
    });
    assert.equal(resPlaceholder.valid, false);
  });

  it('rejects relative STATE_DB_PATH in production', () => {
    const res = validateConfig({
      NODE_ENV: 'production',
      BOT_TOKEN: 'token',
      MERCHANT_ID: 'real-id',
      STATE_DB_PATH: 'server/test.db'
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes('STATE_DB_PATH must be an absolute path')));
  });

  it('loadConfig returns a frozen config object with defaults', () => {
    const cfg = loadConfig({ NODE_ENV: 'development' });
    assert.ok(Object.isFrozen(cfg));
    assert.equal(cfg.geminiModel, 'gemini-2.5-flash');
    assert.equal(cfg.port, 3000);
    assert.ok(cfg.stateDbPath.endsWith('jozveh.db') || cfg.stateDbPath.endsWith('.db'));
  });
});

describe('Story S7-2: Authentication Module & dev_initdata', () => {
  const botToken = '123456:AUTH-TEST-TOKEN';

  it('mintInitData produces valid Telegram initData query string', () => {
    const raw = mintInitData({ id: 1001, first_name: 'Ali' }, botToken);
    const verified = verifyInitData(raw, botToken);
    assert.equal(verified.ok, true);
    assert.equal(verified.user.id, 1001);
    assert.equal(verified.user.first_name, 'Ali');
  });

  it('verifyInitData rejects tampered string with bad_signature', () => {
    const raw = mintInitData({ id: 1001 }, botToken);
    const tampered = raw.replace('1001', '1002');
    const verified = verifyInitData(tampered, botToken);
    assert.equal(verified.ok, false);
    assert.equal(verified.reason, 'bad_signature');
  });

  it('verifyInitData rejects expired initData', () => {
    const pastDate = Math.floor(Date.now() / 1000) - 90000;
    const raw = mintInitData({ id: 1001, auth_date: pastDate }, botToken);
    const verified = verifyInitData(raw, botToken, { maxAgeSec: 86400 });
    assert.equal(verified.ok, false);
    assert.equal(verified.reason, 'expired');
  });

  it('verifyInitData rejects initData from the future (> 60s)', () => {
    const futureDate = Math.floor(Date.now() / 1000) + 120;
    const raw = mintInitData({ id: 1001, auth_date: futureDate }, botToken);
    const verified = verifyInitData(raw, botToken);
    assert.equal(verified.ok, false);
    assert.equal(verified.reason, 'from_future');
  });

  it('requireUser enforces money max age TTL when requested', () => {
    // 2 hours old: valid for normal routes (86400s), expired for money routes (3600s)
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
    const raw = mintInitData({ id: 1001, auth_date: twoHoursAgo }, botToken);

    const reqStudy = { headers: { 'x-telegram-init-data': raw } };
    const userStudy = requireUser(reqStudy, { money: false, botToken });
    assert.equal(userStudy.id, 1001);

    const reqMoney = { headers: { 'x-telegram-init-data': raw } };
    assert.throws(
      () => requireUser(reqMoney, { money: true, botToken }),
      (err) => err instanceof HttpError && err.code === 'expired'
    );
  });

  it('optionalUser returns null for missing header, user for valid header', () => {
    const emptyReq = { headers: {} };
    assert.equal(optionalUser(emptyReq, { botToken }), null);

    const raw = mintInitData({ id: 555 }, botToken);
    const authedReq = { headers: { authorization: `tma ${raw}` } };
    const user = optionalUser(authedReq, { botToken });
    assert.equal(user.id, 555);
  });
});

describe('Story S7-3 & S7-5: Transactional Commerce & Concurrency', () => {
  let fakeGateway;
  let gatewayHandle;
  let appServer;
  let serverBaseUrl;
  let serverDb;
  let serverDBFacade;

  before(async () => {
    // Start Fake Zarinpal Gateway
    fakeGateway = createFakeGateway();
    gatewayHandle = await fakeGateway.listen(0);
    process.env.ZARINPAL_BASE = gatewayHandle.url;
    process.env.MERCHANT_ID = 'test-merchant-uuid';
    process.env.ALLOW_DEMO_PAYMENTS = '0';

    // Import main server & DB
    const { server, db, DB } = await import(pathToFileURL(path.resolve('server/server.js')).href);
    appServer = server;
    serverDb = db;
    serverDBFacade = DB;

    if (!appServer.listening) {
      await new Promise((resolve) => appServer.listen(0, resolve));
    }
    const { port } = appServer.address();
    serverBaseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (gatewayHandle) await gatewayHandle.close();
    if (appServer && appServer.listening) {
      await new Promise((resolve) => appServer.close(resolve));
    }
  });

  it('50 concurrent /api/payment/verify requests produce EXACTLY 1 sale and 1 creator credit', async () => {
    const authority = `AUTH_CONCURRENCY_${crypto.randomUUID().slice(0, 8)}`;
    const buyerUserId = 99901;
    const courseId = 'sample_course';
    const amountToman = 59000;

    // Register pending payment intent in DB facade & SQLite
    serverDBFacade.pendingPayments = serverDBFacade.pendingPayments || {};
    serverDBFacade.pendingPayments[authority] = {
      userId: String(buyerUserId),
      courseId,
      amount: amountToman,
      state: 'pending',
      createdAt: Date.now()
    };
    commerceRepo.createPaymentIntent(serverDb, {
      authority,
      userId: buyerUserId,
      courseId,
      amountToman,
      state: 'created'
    });

    // Fire 50 concurrent verify requests
    const verifyUrl = `${serverBaseUrl}/api/payment/verify?Authority=${authority}&Status=OK`;
    const requests = Array.from({ length: 50 }, () =>
      fetch(verifyUrl, { redirect: 'manual' }).then((r) => r.status)
    );

    const statuses = await Promise.all(requests);

    // Exactly 1 request should be 200 (or 302 redirect), 49 should be 409 Conflict
    const successCount = statuses.filter((s) => s === 200 || s === 302).length;
    const rejectedCount = statuses.filter((s) => s === 409).length;

    assert.equal(successCount, 1, `Expected exactly 1 successful verification, got ${successCount}`);
    assert.equal(rejectedCount, 49, `Expected exactly 49 rejected requests, got ${rejectedCount}`);

    // Verify DB integrity: exactly 1 sale row with this payment_ref
    const sales = serverDb.prepare('SELECT * FROM sales WHERE payment_ref = ?').all(authority);
    assert.equal(sales.length, 1, 'Expected exactly 1 row in sales table');

    // Verify creator ledger: exactly 1 sale credit for this authority
    const ledgerRows = serverDb.prepare("SELECT * FROM creator_ledger WHERE ref = ? AND kind = 'sale_credit'").all(`sale:${sales[0].id}`);
    assert.equal(ledgerRows.length, 1, 'Expected exactly 1 row in creator_ledger table');

    // Verify creator share is 70% of 59,000 = 41,300
    const expectedShare = Math.floor((59000 * 70) / 100);
    assert.equal(Number(ledgerRows[0].amount_toman), expectedShare);
  });

  it('replaying admin payout approval 20 times is idempotent and modifies ledger once', () => {
    const memDb = openDb(':memory:');
    migrate(memDb);

    const creatorId = 'creator_test_payout';
    // Seed initial balance: 100,000 Toman
    memDb.prepare(`
      INSERT INTO creator_ledger(creator_id, kind, amount_toman, ref, created_at)
      VALUES(?, 'sale_credit', 100000, 'ref_initial', ?)
    `).run(creatorId, Date.now());

    assert.equal(balanceOf(memDb, creatorId), 100000);

    // Request payout of 60,000
    const payoutId = `payout_${crypto.randomUUID()}`;
    const reqRes = commerceRepo.requestPayout(memDb, {
      creatorId,
      sheba: 'IR017000000012345678901234',
      amountToman: 60000,
      payoutId
    });
    assert.equal(reqRes.ok, true);
    // After request, available balance should be 40,000
    assert.equal(balanceOf(memDb, creatorId), 40000);

    // Replay approval 20 times
    const results = [];
    for (let i = 0; i < 20; i++) {
      results.push(commerceRepo.resolvePayout(memDb, { payoutId, approve: true }));
    }

    // First call succeeds, remaining 19 return duplicate
    assert.equal(results[0].ok, true);
    for (let i = 1; i < 20; i++) {
      assert.equal(results[i].ok, false);
      assert.equal(results[i].duplicate, true);
    }

    // Balance remains 40,000, exactly 1 payout record exists
    assert.equal(balanceOf(memDb, creatorId), 40000);
    const paidRecords = memDb.prepare("SELECT * FROM creator_ledger WHERE ref = ?").all(`paid:${payoutId}`);
    assert.equal(paidRecords.length, 1);
  });
});

describe('Story S7-4: JSON to SQLite Migration', () => {
  it('aborts with exit code 2 when encountering corrupt or unparsable JSON', () => {
    const corruptFile = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(corruptFile, '{ invalid: json content ...');

    const result = spawnSync('node', ['server/migrate_json.js', '--source', corruptFile], {
      encoding: 'utf8'
    });

    assert.equal(result.status, 2, `Expected exit code 2, got ${result.status}`);
  });

  it('quarantines demo and guest entries, recomputes creator balances, and is idempotent', () => {
    const jsonPath = path.join(tmpDir, 'mock_state.json');
    const targetDbPath = path.join(tmpDir, 'migrated_test.db');

    const mockData = {
      purchases: {
        'guest_sample_course': true,
        '10001_sample_course': true
      },
      creatorEarnings: {
        '9999': {
          balanceToman: 999999, // Intentional fake balance: should be recomputed from history!
          history: [
            {
              buyerUserId: 'guest', // Should be quarantined
              courseId: 'sample_course',
              priceToman: 59000
            },
            {
              buyerUserId: '10001', // Valid sale
              courseId: 'sample_course',
              priceToman: 59000
            }
          ]
        },
        'creator_demo_1': {
          history: [
            { buyerUserId: '10001', courseId: 'sample_course', priceToman: 59000 } // Demo creator: quarantined!
          ]
        }
      }
    };
    fs.writeFileSync(jsonPath, JSON.stringify(mockData, null, 2));

    // 1. Dry run
    const dryResult = migrateJson({
      inputPath: jsonPath,
      dbPath: targetDbPath,
      dryRun: true
    });
    assert.equal(dryResult.ok, true);
    assert.ok(dryResult.report.quarantinedCount >= 2);
    assert.equal(fs.existsSync(targetDbPath), false, 'Dry run must not create target DB');

    // 2. Apply migration
    const applyResult = migrateJson({
      inputPath: jsonPath,
      dbPath: targetDbPath,
      dryRun: false
    });
    assert.equal(applyResult.ok, true);
    assert.ok(fs.existsSync(targetDbPath));

    // Check DB contents
    const migratedDb = openDb(targetDbPath);
    const validSales = migratedDb.prepare('SELECT * FROM sales').all();
    assert.equal(validSales.length, 1);
    assert.equal(validSales[0].buyer_id, 10001);

    const quarantined = migratedDb.prepare('SELECT * FROM legacy_quarantine').all();
    assert.ok(quarantined.length >= 2);

    // Recomputed balance: 70% of 59,000 = 41,300 (NOT the fake 999,999)
    const bal = balanceOf(migratedDb, '9999');
    assert.equal(bal, 41300);

    // 3. Second run without --force must refuse to run because DB is not empty
    const secondRun = migrateJson({
      inputPath: jsonPath,
      dbPath: targetDbPath,
      dryRun: false,
      force: false
    });
    assert.equal(secondRun.ok, false);
    assert.equal(secondRun.reason, 'db_not_empty');
  });
});
