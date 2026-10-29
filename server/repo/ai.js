/**
 * AI usage repository for per-user and per-course question quotas.
 */
export function getAiUsage(db, userId, courseId = 'default') {
  const row = db.prepare(`
    SELECT queries_count, bonus_quota, last_chat_at
    FROM ai_usage
    WHERE user_id = ? AND course_id = ?
  `).get(userId, courseId);

  return {
    queriesCount: row ? Number(row.queries_count) : 0,
    bonusQuota: row ? Number(row.bonus_quota) : 0,
    lastChatAt: row ? Number(row.last_chat_at || 0) : 0
  };
}

export function recordAiQuery(db, { userId, courseId = 'default', now = Date.now() }) {
  db.prepare(`
    INSERT INTO ai_usage(user_id, course_id, queries_count, bonus_quota, last_chat_at, updated_at)
    VALUES(?, ?, 1, 0, ?, ?)
    ON CONFLICT(user_id, course_id) DO UPDATE SET
      queries_count = queries_count + 1,
      last_chat_at = excluded.last_chat_at,
      updated_at = excluded.updated_at
  `).run(userId, courseId, now, now);
}

export function addBonusQuota(db, { userId, courseId = 'default', bonus = 2, now = Date.now() }) {
  db.prepare(`
    INSERT INTO ai_usage(user_id, course_id, queries_count, bonus_quota, last_chat_at, updated_at)
    VALUES(?, ?, 0, ?, NULL, ?)
    ON CONFLICT(user_id, course_id) DO UPDATE SET
      bonus_quota = bonus_quota + excluded.bonus_quota,
      updated_at = excluded.updated_at
  `).run(userId, courseId, bonus, now);
}
