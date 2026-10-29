/**
 * Users repository for Telegram user profiles.
 */
export function upsertUser(db, { telegramId, username = '', firstName = '', now = Date.now() }) {
  db.prepare(`
    INSERT INTO users(telegram_id, username, first_name, created_at, last_seen_at)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_seen_at = excluded.last_seen_at
  `).run(telegramId, username, firstName, now, now);
}

export function getUser(db, telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}
