import { DatabaseSync } from 'node:sqlite';

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

// Synchronous-only transaction helper (no await inside fn!) -> no interleaving possible.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

export function migrate(db) {
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v < 1) {
    tx(db, () => {
      db.exec(`
        CREATE TABLE users(
          telegram_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT,
          created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL) STRICT;
        CREATE TABLE sales(
          id INTEGER PRIMARY KEY, buyer_id INTEGER NOT NULL, course_id TEXT NOT NULL, creator_id TEXT NOT NULL,
          price_toman INTEGER NOT NULL CHECK(price_toman > 0),
          creator_share_toman INTEGER NOT NULL, platform_share_toman INTEGER NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('zarinpal','zibal','manual_receipt','demo')),
          payment_ref TEXT NOT NULL UNIQUE,                    -- idempotency key (authority / receipt id)
          created_at INTEGER NOT NULL) STRICT;
        CREATE TABLE purchases(
          buyer_id INTEGER NOT NULL, course_id TEXT NOT NULL, sale_id INTEGER NOT NULL REFERENCES sales(id),
          created_at INTEGER NOT NULL, PRIMARY KEY(buyer_id, course_id)) STRICT;
        CREATE TABLE creator_ledger(
          id INTEGER PRIMARY KEY, creator_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('sale_credit','payout_hold','payout_paid','payout_release','adjustment')),
          amount_toman INTEGER NOT NULL,                       -- signed
          ref TEXT NOT NULL, created_at INTEGER NOT NULL,
          UNIQUE(kind, ref)) STRICT;                           -- idempotent per event
        CREATE INDEX ledger_creator ON creator_ledger(creator_id);
        PRAGMA user_version = 1;
      `);
    });
  }
}

export function splitPrice(priceToman) {
  const creator = Math.floor((priceToman * 70) / 100);
  return { creator, platform: priceToman - creator };
}

// Atomic + idempotent sale recording. Returns {duplicate:boolean, ...}.
export function recordSale(db, { buyerId, courseId, creatorId, priceToman, source, paymentRef, now = Date.now() }) {
  return tx(db, () => {
    const existing = db.prepare('SELECT id FROM sales WHERE payment_ref = ?').get(paymentRef);
    if (existing) return { duplicate: true, saleId: existing.id };
    const { creator, platform } = splitPrice(priceToman);
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO sales(buyer_id,course_id,creator_id,price_toman,creator_share_toman,platform_share_toman,source,payment_ref,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`).run(buyerId, courseId, creatorId, priceToman, creator, platform, source, paymentRef, now);
    db.prepare('INSERT OR IGNORE INTO purchases(buyer_id,course_id,sale_id,created_at) VALUES(?,?,?,?)')
      .run(buyerId, courseId, lastInsertRowid, now);
    db.prepare('INSERT INTO creator_ledger(creator_id,kind,amount_toman,ref,created_at) VALUES(?,?,?,?,?)')
      .run(creatorId, 'sale_credit', creator, `sale:${lastInsertRowid}`, now);
    return { duplicate: false, saleId: Number(lastInsertRowid), creatorShare: creator };
  });
}

export const balanceOf = (db, creatorId) =>
  db.prepare('SELECT COALESCE(SUM(amount_toman),0) AS b FROM creator_ledger WHERE creator_id = ?').get(creatorId).b;

// Payout request RESERVES funds atomically: cannot exceed available balance, cannot be requested twice.
export function requestPayout(db, { creatorId, amountToman, payoutId, now = Date.now() }) {
  return tx(db, () => {
    const bal = balanceOf(db, creatorId);
    if (!Number.isInteger(amountToman) || amountToman <= 0 || amountToman > bal) return { ok: false, reason: 'insufficient', balance: bal };
    db.prepare('INSERT INTO creator_ledger(creator_id,kind,amount_toman,ref,created_at) VALUES(?,?,?,?,?)')
      .run(creatorId, 'payout_hold', -amountToman, payoutId, now);
    return { ok: true, balance: bal - amountToman };
  });
}
