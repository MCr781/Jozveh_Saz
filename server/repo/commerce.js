import { tx, splitPrice, recordSale as recordSaleCore, balanceOf } from '../db.js';

export { splitPrice, balanceOf };

export function recordSale(db, params) {
  return recordSaleCore(db, params);
}

export function hasPurchased(db, buyerId, courseId) {
  const row = db.prepare('SELECT 1 FROM purchases WHERE buyer_id = ? AND course_id = ?').get(buyerId, courseId);
  return Boolean(row);
}

export function getAllPurchases(db) {
  return db.prepare('SELECT buyer_id, course_id, sale_id, created_at FROM purchases').all();
}

export function getCreatorStats(db, creatorId) {
  const balanceToman = balanceOf(db, creatorId);

  // Held funds in pending payouts
  const heldRow = db.prepare(`
    SELECT COALESCE(SUM(amount_toman), 0) AS held
    FROM payouts
    WHERE creator_id = ? AND status = 'pending'
  `).get(creatorId);
  const heldToman = heldRow ? Number(heldRow.held) : 0;

  // Sales count
  const salesCountRow = db.prepare('SELECT COUNT(*) AS count FROM sales WHERE creator_id = ?').get(creatorId);
  const salesCount = salesCountRow ? Number(salesCountRow.count) : 0;

  // Sales history (clean of buyerUserId for IDOR protection)
  const salesRows = db.prepare(`
    SELECT id, course_id, price_toman, creator_share_toman, created_at AS timestamp
    FROM sales
    WHERE creator_id = ?
    ORDER BY created_at DESC
    LIMIT 100
  `).all(creatorId);

  return {
    creatorId,
    balanceToman,
    heldToman,
    salesCount,
    history: salesRows.map((r) => ({
      courseId: r.course_id,
      priceToman: Number(r.price_toman),
      creatorShareToman: Number(r.creator_share_toman),
      timestamp: Number(r.timestamp)
    }))
  };
}

export function createPaymentIntent(db, { authority, userId, courseId, amountToman, state = 'created', now = Date.now() }) {
  db.prepare(`
    INSERT INTO payment_intents(authority, user_id, course_id, amount_toman, state, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(authority) DO UPDATE SET
      state = excluded.state,
      updated_at = excluded.updated_at
  `).run(authority, userId, courseId, amountToman, state, now, now);
}

export function getPaymentIntent(db, authority) {
  return db.prepare('SELECT * FROM payment_intents WHERE authority = ?').get(authority);
}

export function setPaymentIntentState(db, authority, state, now = Date.now()) {
  const res = db.prepare(`
    UPDATE payment_intents
    SET state = ?, updated_at = ?
    WHERE authority = ?
  `).run(state, now, authority);
  return res.changes > 0;
}

export function hasPendingPayout(db, creatorId) {
  const row = db.prepare(`
    SELECT 1 FROM payouts WHERE creator_id = ? AND status = 'pending' LIMIT 1
  `).get(creatorId);
  return Boolean(row);
}

export function requestPayout(db, { creatorId, sheba, amountToman, payoutId, now = Date.now() }) {
  return tx(db, () => {
    if (hasPendingPayout(db, creatorId)) {
      return { ok: false, reason: 'pending_exists' };
    }

    const bal = balanceOf(db, creatorId);
    if (!Number.isInteger(amountToman) || amountToman <= 0 || amountToman > bal) {
      return { ok: false, reason: 'insufficient', balance: bal };
    }

    db.prepare(`
      INSERT INTO payouts(payout_id, creator_id, sheba, amount_toman, status, created_at)
      VALUES(?, ?, ?, ?, 'pending', ?)
    `).run(payoutId, creatorId, sheba, amountToman, now);

    db.prepare(`
      INSERT INTO creator_ledger(creator_id, kind, amount_toman, ref, created_at)
      VALUES(?, 'payout_hold', ?, ?, ?)
    `).run(creatorId, -amountToman, payoutId, now);

    return { ok: true, payoutId, balance: bal - amountToman };
  });
}

export function resolvePayout(db, { payoutId, approve, now = Date.now() }) {
  return tx(db, () => {
    const payout = db.prepare('SELECT * FROM payouts WHERE payout_id = ?').get(payoutId);
    if (!payout || payout.status !== 'pending') {
      return { ok: false, duplicate: true, status: payout?.status };
    }

    const targetStatus = approve ? 'approved' : 'rejected';
    db.prepare(`
      UPDATE payouts
      SET status = ?, resolved_at = ?
      WHERE payout_id = ?
    `).run(targetStatus, now, payoutId);

    if (approve) {
      db.prepare(`
        INSERT INTO creator_ledger(creator_id, kind, amount_toman, ref, created_at)
        VALUES(?, 'payout_paid', 0, ?, ?)
        ON CONFLICT(kind, ref) DO NOTHING
      `).run(payout.creator_id, `paid:${payoutId}`, now);
    } else {
      // Release held funds back to balance
      db.prepare(`
        INSERT INTO creator_ledger(creator_id, kind, amount_toman, ref, created_at)
        VALUES(?, 'payout_release', ?, ?, ?)
      `).run(payout.creator_id, Number(payout.amount_toman), `release:${payoutId}`, now);
    }

    return { ok: true, payoutId, status: targetStatus, amountToman: Number(payout.amount_toman), creatorId: payout.creator_id, sheba: payout.sheba };
  });
}

export function createReceipt(db, { receiptId, userId, courseId, now = Date.now() }) {
  db.prepare(`
    INSERT INTO receipts(receipt_id, user_id, course_id, status, created_at)
    VALUES(?, ?, ?, 'pending', ?)
  `).run(receiptId, userId, courseId, now);
}

export function getReceipt(db, receiptId) {
  return db.prepare('SELECT * FROM receipts WHERE receipt_id = ?').get(receiptId);
}

export function resolveReceipt(db, { receiptId, approve, creatorId = 'creator_demo_1', priceToman = 59000, now = Date.now() }) {
  return tx(db, () => {
    const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_id = ?').get(receiptId);
    if (!receipt || receipt.status !== 'pending') {
      return { ok: false, duplicate: true, status: receipt?.status };
    }

    const targetStatus = approve ? 'approved' : 'rejected';
    db.prepare(`
      UPDATE receipts
      SET status = ?, resolved_at = ?
      WHERE receipt_id = ?
    `).run(targetStatus, now, receiptId);

    let saleResult = null;
    if (approve) {
      saleResult = recordSaleCore(db, {
        buyerId: receipt.user_id,
        courseId: receipt.course_id,
        creatorId,
        priceToman,
        source: 'manual_receipt',
        paymentRef: `receipt:${receiptId}`,
        now
      });
    }

    return {
      ok: true,
      receiptId,
      status: targetStatus,
      userId: receipt.user_id,
      courseId: receipt.course_id,
      saleResult
    };
  });
}
