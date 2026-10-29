import fs from 'node:fs';
import path from 'node:path';
import { openDb, migrate as migrateSchema, tx, splitPrice, balanceOf } from './db.js';
import { config } from './config.js';

function isDemoOrGuest(id) {
  if (id === null || id === undefined) return false;
  const s = String(id).trim().toLowerCase();
  return s === 'guest' || s.startsWith('demo_user') || s.startsWith('creator_demo');
}

/**
 * Migrates legacy state_db.json into SQLite.
 */
export function migrateJson({
  inputPath = path.resolve(process.cwd(), 'server/state_db.json'),
  dbPath = config.stateDbPath,
  dryRun = false,
  force = false
} = {}) {
  if (!fs.existsSync(inputPath)) {
    return { ok: false, reason: 'input_not_found', path: inputPath };
  }

  let raw = '';
  try {
    raw = fs.readFileSync(inputPath, 'utf8');
  } catch (err) {
    console.error('❌ Failed to read input JSON:', err.message);
    process.exit(2);
  }

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error('❌ Corrupt or unparsable JSON. Aborting with exit code 2:', err.message);
    process.exit(2);
  }

  if (!data || typeof data !== 'object') {
    console.error('❌ Invalid JSON root structure. Aborting with exit code 2.');
    process.exit(2);
  }

  const db = openDb(dryRun ? ':memory:' : dbPath);
  migrateSchema(db);

  // Safety check: refuse to run if sales exist, unless --force
  const salesCount = Number(db.prepare('SELECT COUNT(*) AS count FROM sales').get().count);
  if (salesCount > 0 && !force) {
    console.error(`❌ Target database already contains ${salesCount} sales. Refusing to migrate without --force.`);
    return { ok: false, reason: 'db_not_empty', salesCount };
  }

  const report = {
    migratedAt: new Date().toISOString(),
    inputPath,
    dbPath: dryRun ? ':memory:' : dbPath,
    dryRun,
    salesProcessed: 0,
    salesMigrated: 0,
    purchasesMigrated: 0,
    payoutsMigrated: 0,
    quarantinedCount: 0,
    quarantined: [],
    creatorBalances: {}
  };

  tx(db, () => {
    const now = Date.now();

    // 1. Process creatorEarnings history (Sales)
    const creatorEarnings = data.creatorEarnings || {};
    for (const [creatorId, rec] of Object.entries(creatorEarnings)) {
      const history = Array.isArray(rec?.history) ? rec.history : [];
      for (const item of history) {
        report.salesProcessed++;
        const buyerId = item.buyerUserId;
        const courseId = item.courseId || 'sample_course';
        const priceToman = Number(item.priceToman || 59000);

        if (isDemoOrGuest(buyerId) || isDemoOrGuest(creatorId)) {
          report.quarantinedCount++;
          const reason = isDemoOrGuest(buyerId) ? `demo/guest buyer (${buyerId})` : `demo creator (${creatorId})`;
          const qEntry = { entity: 'sale', creatorId, buyerId, courseId, priceToman, reason };
          report.quarantined.push(qEntry);
          db.prepare(`
            INSERT INTO legacy_quarantine(entity_type, raw_json, reason, created_at)
            VALUES('sale', ?, ?, ?)
          `).run(JSON.stringify(item), reason, now);
          continue;
        }

        const buyerNumeric = Number(buyerId);
        if (!Number.isSafeInteger(buyerNumeric) || buyerNumeric <= 0) {
          report.quarantinedCount++;
          const reason = `invalid buyer id (${buyerId})`;
          report.quarantined.push({ entity: 'sale', creatorId, buyerId, courseId, priceToman, reason });
          db.prepare(`
            INSERT INTO legacy_quarantine(entity_type, raw_json, reason, created_at)
            VALUES('sale', ?, ?, ?)
          `).run(JSON.stringify(item), reason, now);
          continue;
        }

        const paymentRef = item.paymentRef || `legacy_sale_${item.timestamp || now}_${buyerNumeric}_${courseId}`;
        const { creator, platform } = splitPrice(priceToman);
        const itemTime = Number(item.timestamp) || now;

        const { lastInsertRowid } = db.prepare(`
          INSERT INTO sales(buyer_id, course_id, creator_id, price_toman, creator_share_toman, platform_share_toman, source, payment_ref, created_at)
          VALUES(?, ?, ?, ?, ?, ?, 'manual_receipt', ?, ?)
          ON CONFLICT(payment_ref) DO NOTHING
        `).run(buyerNumeric, courseId, creatorId, priceToman, creator, platform, paymentRef, itemTime);

        if (lastInsertRowid) {
          report.salesMigrated++;
          db.prepare(`
            INSERT INTO purchases(buyer_id, course_id, sale_id, created_at)
            VALUES(?, ?, ?, ?)
            ON CONFLICT(buyer_id, course_id) DO NOTHING
          `).run(buyerNumeric, courseId, lastInsertRowid, itemTime);
          report.purchasesMigrated++;

          db.prepare(`
            INSERT INTO creator_ledger(creator_id, kind, amount_toman, ref, created_at)
            VALUES(?, 'sale_credit', ?, ?, ?)
            ON CONFLICT(kind, ref) DO NOTHING
          `).run(creatorId, creator, `sale:${lastInsertRowid}`, itemTime);
        }
      }
    }

    // 2. Process payout requests
    const payouts = data.payoutRequests || {};
    for (const [payoutId, p] of Object.entries(payouts)) {
      const creatorId = p.creatorId;
      const amount = Number(p.amount || 0);
      const sheba = String(p.sheba || '').trim();
      const status = p.status || 'pending';
      const created = Number(p.createdAt) || now;

      if (isDemoOrGuest(creatorId) || amount <= 0) {
        report.quarantinedCount++;
        const reason = isDemoOrGuest(creatorId) ? `demo creator payout (${creatorId})` : 'invalid amount';
        report.quarantined.push({ entity: 'payout', payoutId, creatorId, amount, reason });
        db.prepare(`
          INSERT INTO legacy_quarantine(entity_type, raw_json, reason, created_at)
          VALUES('payout', ?, ?, ?)
        `).run(JSON.stringify(p), reason, now);
        continue;
      }

      db.prepare(`
        INSERT INTO payouts(payout_id, creator_id, sheba, amount_toman, status, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(payout_id) DO NOTHING
      `).run(payoutId, creatorId, sheba, amount, status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : 'pending', created);

      report.payoutsMigrated++;

      if (status === 'pending') {
        db.prepare(`
          INSERT INTO creator_ledger(creator_id, kind, amount_toman, ref, created_at)
          VALUES(?, 'payout_hold', ?, ?, ?)
          ON CONFLICT(kind, ref) DO NOTHING
        `).run(creatorId, -amount, payoutId, created);
      } else if (status === 'approved') {
        db.prepare(`
          INSERT INTO creator_ledger(creator_id, kind, amount_toman, ref, created_at)
          VALUES(?, 'payout_hold', ?, ?, ?)
          ON CONFLICT(kind, ref) DO NOTHING
        `).run(creatorId, -amount, payoutId, created);

        db.prepare(`
          INSERT INTO creator_ledger(creator_id, kind, amount_toman, ref, created_at)
          VALUES(?, 'payout_paid', 0, ?, ?)
          ON CONFLICT(kind, ref) DO NOTHING
        `).run(creatorId, `paid:${payoutId}`, created);
      }
    }

    // 3. Summarize recomputed creator balances
    const creators = db.prepare('SELECT DISTINCT creator_id FROM creator_ledger').all();
    for (const c of creators) {
      report.creatorBalances[c.creator_id] = balanceOf(db, c.creator_id);
    }
  });

  // Write report
  const reportPath = path.resolve(process.cwd(), 'migration_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  // Archive original input if applied
  if (!dryRun) {
    try {
      const stamp = Date.now();
      const backupPath = `${inputPath}.migrated-${stamp}`;
      fs.copyFileSync(inputPath, backupPath);
      report.backupPath = backupPath;
    } catch (err) {
      console.warn('⚠️ Could not archive state_db.json:', err.message);
    }
  }

  return { ok: true, report };
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('migrate_json.js')) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const inputArg = args.find((a) => !a.startsWith('--'));

  const result = migrateJson({
    inputPath: inputArg ? path.resolve(process.cwd(), inputArg) : undefined,
    dryRun,
    force
  });

  if (!result.ok) {
    console.error(`❌ Migration failed: ${result.reason}`);
    process.exit(1);
  }

  console.log(`✅ Migration complete (${dryRun ? 'DRY-RUN' : 'APPLIED'}):`);
  console.log(`   - Sales migrated: ${result.report.salesMigrated}`);
  console.log(`   - Quarantined: ${result.report.quarantinedCount}`);
  console.log(`   - Report written to: migration_report.json`);
}
