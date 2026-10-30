import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_V1, SCHEMA_V2 } from './schema.js';

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  return db;
}

/**
 * Synchronous transaction helper: BEGIN IMMEDIATE / COMMIT / ROLLBACK.
 * No async or await permitted inside.
 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {}
    throw err;
  }
}

/**
 * Applies SQLite schema migrations tracking user_version.
 */
export function migrate(db) {
  const versionRow = db.prepare('PRAGMA user_version').get();
  const v = versionRow ? Number(versionRow.user_version) : 0;
  if (v < 1) {
    tx(db, () => {
      db.exec(SCHEMA_V1);
      db.exec('PRAGMA user_version = 1;');
    });
  }
  if (v < 2) {
    tx(db, () => {
      db.exec(SCHEMA_V2);
      try {
        db.exec('ALTER TABLE users ADD COLUMN sheba TEXT;');
      } catch (_) {}
      try {
        db.exec('ALTER TABLE users ADD COLUMN sheba_updated_at INTEGER;');
      } catch (_) {}
      db.exec('PRAGMA user_version = 2;');
    });
  }
}

/**
 * Splits price: 70% creator, 30% platform. Sums exactly.
 */
export function splitPrice(priceToman) {
  const creator = Math.floor((priceToman * 70) / 100);
  return { creator, platform: priceToman - creator };
}

/**
 * Atomically records sale, buyer purchase, and creator ledger credit.
 * Idempotent on paymentRef.
 */
export function recordSale(db, { buyerId, courseId, creatorId, priceToman, source, paymentRef, now = Date.now() }) {
  return tx(db, () => {
    const existing = db.prepare('SELECT id, creator_share_toman FROM sales WHERE payment_ref = ?').get(paymentRef);
    if (existing) {
      return { duplicate: true, saleId: existing.id, creatorShare: existing.creator_share_toman };
    }

    const { creator, platform } = splitPrice(priceToman);
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO sales(buyer_id, course_id, creator_id, price_toman, creator_share_toman, platform_share_toman, source, payment_ref, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(buyerId, courseId, creatorId, priceToman, creator, platform, source, paymentRef, now);

    db.prepare(`
      INSERT OR IGNORE INTO purchases(buyer_id, course_id, sale_id, created_at)
      VALUES(?, ?, ?, ?)
    `).run(buyerId, courseId, lastInsertRowid, now);

    db.prepare(`
      INSERT INTO creator_ledger(creator_id, kind, amount_toman, ref, created_at)
      VALUES(?, ?, ?, ?, ?)
    `).run(creatorId, 'sale_credit', creator, `sale:${lastInsertRowid}`, now);

    return { duplicate: false, saleId: Number(lastInsertRowid), creatorShare: creator };
  });
}

/**
 * Computes available creator balance from ledger.
 */
export function balanceOf(db, creatorId) {
  const row = db.prepare('SELECT COALESCE(SUM(amount_toman), 0) AS b FROM creator_ledger WHERE creator_id = ?').get(creatorId);
  return row ? Number(row.b) : 0;
}

/**
 * Payout request reserves funds atomically in creator_ledger (payout_hold).
 */
export function requestPayout(db, { creatorId, amountToman, payoutId, now = Date.now() }) {
  return tx(db, () => {
    const bal = balanceOf(db, creatorId);
    if (!Number.isInteger(amountToman) || amountToman <= 0 || amountToman > bal) {
      return { ok: false, reason: 'insufficient', balance: bal };
    }

    db.prepare(`
      INSERT INTO creator_ledger(creator_id, kind, amount_toman, ref, created_at)
      VALUES(?, ?, ?, ?, ?)
    `).run(creatorId, 'payout_hold', -amountToman, payoutId, now);

    return { ok: true, balance: bal - amountToman };
  });
}
