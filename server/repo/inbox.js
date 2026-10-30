import { tx } from '../db.js';

/**
 * Idempotent Telegram Update Inbox & Deduplication Repository.
 */

export function claimUpdate(db, updateId, now = Date.now()) {
  const numericId = Number(updateId);
  if (!Number.isSafeInteger(numericId)) {
    return { duplicate: false, updateId };
  }

  return tx(db, () => {
    const res = db.prepare(`
      INSERT OR IGNORE INTO tg_inbox(update_id, status, received_at)
      VALUES(?, 'received', ?)
    `).run(numericId, now);

    if (res.changes === 0) {
      const existing = db.prepare('SELECT status, received_at, processed_at FROM tg_inbox WHERE update_id = ?').get(numericId);
      return { duplicate: true, updateId: numericId, status: existing?.status || 'received' };
    }

    return { duplicate: false, updateId: numericId, status: 'received' };
  });
}

export function markUpdateProcessed(db, updateId, now = Date.now()) {
  const numericId = Number(updateId);
  db.prepare(`
    UPDATE tg_inbox
    SET status = 'processed', processed_at = ?
    WHERE update_id = ?
  `).run(now, numericId);
}

export function markUpdateFailed(db, updateId, now = Date.now()) {
  const numericId = Number(updateId);
  db.prepare(`
    UPDATE tg_inbox
    SET status = 'failed', processed_at = ?
    WHERE update_id = ?
  `).run(now, numericId);
}

export function claimCallback(db, callbackId, now = Date.now()) {
  const idStr = String(callbackId || '');
  if (!idStr) return { duplicate: false, callbackId: idStr };

  return tx(db, () => {
    const res = db.prepare(`
      INSERT OR IGNORE INTO tg_callbacks(callback_id, created_at)
      VALUES(?, ?)
    `).run(idStr, now);

    if (res.changes === 0) {
      return { duplicate: true, callbackId: idStr };
    }

    return { duplicate: false, callbackId: idStr };
  });
}

export function getLastUpdateId(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'tg_last_update_id'").get();
  return row ? Number(row.value) || 0 : 0;
}

export function setLastUpdateId(db, updateId) {
  const numericId = Number(updateId) || 0;
  db.prepare(`
    INSERT INTO meta(key, value)
    VALUES('tg_last_update_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(numericId));
}

export function getInboxStatus(db, updateId) {
  const numericId = Number(updateId);
  return db.prepare('SELECT * FROM tg_inbox WHERE update_id = ?').get(numericId);
}
