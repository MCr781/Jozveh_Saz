import crypto from 'node:crypto';
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

export function getCreatorSheba(db, creatorId) {
  const row = db.prepare('SELECT sheba, bank_name, updated_at FROM creator_profiles WHERE creator_id = ?').get(String(creatorId));
  if (row) {
    return {
      sheba: row.sheba,
      bankName: row.bank_name,
      updatedAt: Number(row.updated_at)
    };
  }
  return null;
}

export function recordCreatorSheba(db, { creatorId, sheba, bankName = '', now = Date.now() }) {
  const cid = String(creatorId);
  const cleanSheba = String(sheba || '').replace(/[\s-]/g, '').toUpperCase();
  const prior = getCreatorSheba(db, cid);

  const isChanged = Boolean(prior && prior.sheba && prior.sheba.toUpperCase() !== cleanSheba);
  const previousSheba = prior ? prior.sheba : null;
  const previousBank = prior ? prior.bankName : null;

  tx(db, () => {
    db.prepare(`
      INSERT INTO creator_profiles(creator_id, sheba, bank_name, updated_at)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(creator_id) DO UPDATE SET
        sheba = excluded.sheba,
        bank_name = excluded.bank_name,
        updated_at = excluded.updated_at
    `).run(cid, cleanSheba, bankName, now);

    const numId = Number(cid);
    if (Number.isSafeInteger(numId) && numId > 0) {
      try {
        db.prepare('UPDATE users SET sheba = ?, sheba_updated_at = ? WHERE telegram_id = ?').run(cleanSheba, now, numId);
      } catch (_) {}
    }
  });

  return {
    isChanged,
    previousSheba,
    previousBank,
    bankName,
    currentSheba: cleanSheba,
    updatedAt: now
  };
}

export function requestPayout(db, { creatorId, sheba, amountToman, payoutId, now = Date.now(), minPayoutToman = 0 }) {
  return tx(db, () => {
    if (hasPendingPayout(db, creatorId)) {
      return { ok: false, reason: 'pending_exists' };
    }

    const bal = balanceOf(db, creatorId);
    if (!Number.isInteger(amountToman) || amountToman <= 0 || amountToman > bal) {
      return { ok: false, reason: 'insufficient', balance: bal };
    }

    if (minPayoutToman > 0 && amountToman < minPayoutToman) {
      return { ok: false, reason: 'below_minimum', minPayoutToman, balance: bal };
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

export function reconcileStalePaymentIntents(db, { now = Date.now(), maxAgeMs = 15 * 60 * 1000 } = {}) {
  const threshold = now - maxAgeMs;
  return tx(db, () => {
    const stale = db.prepare(`
      SELECT authority, user_id, course_id, amount_toman, created_at
      FROM payment_intents
      WHERE state IN ('created', 'redirected') AND created_at <= ?
    `).all(threshold);

    const expiredAuthorities = [];
    for (const intent of stale) {
      db.prepare(`
        UPDATE payment_intents
        SET state = 'expired', updated_at = ?
        WHERE authority = ?
      `).run(now, intent.authority);
      expiredAuthorities.push(intent.authority);
    }

    return {
      reconciledCount: expiredAuthorities.length,
      expiredAuthorities
    };
  });
}

export function verifyLedgerInvariant(db) {
  const salesRow = db.prepare(`
    SELECT
      COALESCE(SUM(price_toman), 0) AS total_sales_price,
      COALESCE(SUM(creator_share_toman), 0) AS total_creator_share,
      COALESCE(SUM(platform_share_toman), 0) AS total_platform_share
    FROM sales
  `).get();

  const ledgerRow = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN kind = 'sale_credit' THEN amount_toman ELSE 0 END), 0) AS total_sale_credits,
      COALESCE(SUM(CASE WHEN kind = 'payout_hold' THEN amount_toman ELSE 0 END), 0) AS total_payout_holds,
      COALESCE(SUM(CASE WHEN kind = 'payout_release' THEN amount_toman ELSE 0 END), 0) AS total_payout_releases,
      COALESCE(SUM(amount_toman), 0) AS net_ledger_balance
    FROM creator_ledger
  `).get();

  const payoutsRow = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'pending' THEN amount_toman ELSE 0 END), 0) AS pending_payouts,
      COALESCE(SUM(CASE WHEN status = 'approved' THEN amount_toman ELSE 0 END), 0) AS approved_payouts,
      COALESCE(SUM(CASE WHEN status = 'rejected' THEN amount_toman ELSE 0 END), 0) AS rejected_payouts
    FROM payouts
  `).get();

  const totalCreatorShare = Number(salesRow.total_creator_share);
  const totalSaleCredits = Number(ledgerRow.total_sale_credits);
  const netLedgerBalance = Number(ledgerRow.net_ledger_balance);
  const pendingPayouts = Number(payoutsRow.pending_payouts);
  const approvedPayouts = Number(payoutsRow.approved_payouts);

  // Invariant 1: Total creator share from sales must match sale_credit entries in ledger
  const creditDiff = Math.abs(totalCreatorShare - totalSaleCredits);

  // Invariant 2: Net ledger balance + held pending payouts + approved payouts must equal total sale credits
  const ledgerReconciled = netLedgerBalance + pendingPayouts + approvedPayouts;
  const balanceDiff = Math.abs(ledgerReconciled - totalSaleCredits);

  const totalDiff = creditDiff + balanceDiff;

  return {
    ok: totalDiff === 0,
    diff: totalDiff,
    creditDiff,
    balanceDiff,
    details: {
      totalSalesPrice: Number(salesRow.total_sales_price),
      totalCreatorShare,
      totalPlatformShare: Number(salesRow.total_platform_share),
      totalSaleCredits,
      netLedgerBalance,
      pendingPayouts,
      approvedPayouts
    }
  };
}

export function createSquadBuy(db, { courseId, initiatorId, originalPriceToman, discountedPriceToman, now = Date.now() }) {
  const existing = db.prepare(`
    SELECT * FROM squad_buys
    WHERE course_id = ? AND initiator_id = ? AND status = 'waiting_partner' AND created_at > ?
    ORDER BY created_at DESC LIMIT 1
  `).get(courseId, initiatorId, now - 48 * 3600 * 1000);

  if (existing) {
    return existing;
  }

  const code = `squad_${crypto.randomBytes(5).toString('hex')}`;
  db.prepare(`
    INSERT INTO squad_buys(code, course_id, initiator_id, original_price_toman, discounted_price_toman, status, created_at)
    VALUES(?, ?, ?, ?, ?, 'waiting_partner', ?)
  `).run(code, courseId, initiatorId, originalPriceToman, discountedPriceToman, now);

  return {
    code,
    course_id: courseId,
    initiator_id: initiatorId,
    partner_id: null,
    original_price_toman: originalPriceToman,
    discounted_price_toman: discountedPriceToman,
    status: 'waiting_partner',
    created_at: now,
    completed_at: null
  };
}

export function getSquadBuy(db, code) {
  if (!code) return null;
  return db.prepare('SELECT * FROM squad_buys WHERE code = ?').get(code);
}

export function completeSquadBuy(db, { code, partnerId, now = Date.now() }) {
  return tx(db, () => {
    const squad = db.prepare('SELECT * FROM squad_buys WHERE code = ?').get(code);
    if (!squad) {
      throw new Error('SQUAD_NOT_FOUND');
    }
    if (squad.status === 'completed') {
      return squad;
    }
    if (squad.status !== 'waiting_partner') {
      throw new Error('SQUAD_NOT_AVAILABLE');
    }
    db.prepare(`
      UPDATE squad_buys
      SET status = 'completed', partner_id = ?, completed_at = ?
      WHERE code = ?
    `).run(partnerId, now, code);
    return {
      ...squad,
      status: 'completed',
      partner_id: partnerId,
      completed_at: now
    };
  });
}
