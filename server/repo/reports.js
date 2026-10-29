import { tx } from '../db.js';

/**
 * Reports repository for crowdsourced student error reports and AI fact-checking.
 */
export function isItemLocked(db, courseId, itemId) {
  const row = db.prepare(`
    SELECT 1 FROM reports
    WHERE course_id = ? AND item_id = ? AND status = 'pending_admin'
    LIMIT 1
  `).get(courseId, itemId);
  return Boolean(row);
}

export function createReport(db, { reportId, courseId, itemId, userId, claim, proposedFix = '', learnedRule = '', now = Date.now() }) {
  db.prepare(`
    INSERT INTO reports(report_id, course_id, item_id, user_id, claim, proposed_fix, learned_rule, status, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, 'pending_admin', ?)
  `).run(reportId, courseId, itemId, userId, claim, proposedFix, learnedRule, now);
}

export function getReport(db, reportId) {
  return db.prepare('SELECT * FROM reports WHERE report_id = ?').get(reportId);
}

export function resolveReport(db, { reportId, approve, now = Date.now() }) {
  return tx(db, () => {
    const report = db.prepare('SELECT * FROM reports WHERE report_id = ?').get(reportId);
    if (!report || report.status !== 'pending_admin') {
      return { ok: false, duplicate: true, status: report?.status };
    }

    const targetStatus = approve ? 'approved' : 'rejected';
    db.prepare(`
      UPDATE reports
      SET status = ?, resolved_at = ?
      WHERE report_id = ?
    `).run(targetStatus, now, reportId);

    if (approve && report.learned_rule) {
      db.prepare(`
        INSERT INTO learned_rules(rule, source_report_id, created_at)
        VALUES(?, ?, ?)
        ON CONFLICT(rule) DO NOTHING
      `).run(report.learned_rule, reportId, now);
    }

    return {
      ok: true,
      reportId,
      status: targetStatus,
      userId: report.user_id,
      courseId: report.course_id,
      itemId: report.item_id,
      learnedRule: report.learned_rule
    };
  });
}

export function getLearnedRules(db) {
  return db.prepare('SELECT rule FROM learned_rules ORDER BY id ASC').all().map((r) => r.rule);
}
