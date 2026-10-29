/**
 * Leitner study progress repository.
 */
export function saveCourseProgress(db, { userId, courseId, reviewCount = 0, knownCount = 0, totalCards = 0, pendingCards = [], now = Date.now() }) {
  const pendingJson = JSON.stringify(pendingCards || []);
  db.prepare(`
    INSERT INTO progress(user_id, course_id, review_count, known_count, total_cards, pending_cards_json, last_sync_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, course_id) DO UPDATE SET
      review_count = excluded.review_count,
      known_count = excluded.known_count,
      total_cards = excluded.total_cards,
      pending_cards_json = excluded.pending_cards_json,
      last_sync_at = excluded.last_sync_at
  `).run(userId, courseId, reviewCount, knownCount, totalCards, pendingJson, now);
}

export function getUserProgress(db, userId) {
  const rows = db.prepare(`
    SELECT course_id, review_count, known_count, total_cards, pending_cards_json, last_sync_at
    FROM progress
    WHERE user_id = ?
    ORDER BY last_sync_at DESC
  `).all(userId);

  const courses = {};
  let totalReview = 0;
  let totalKnown = 0;
  let totalCards = 0;
  let lastSyncAt = 0;

  for (const r of rows) {
    const rev = Number(r.review_count);
    const knw = Number(r.known_count);
    const tot = Number(r.total_cards);
    const sync = Number(r.last_sync_at);

    totalReview += rev;
    totalKnown += knw;
    totalCards += tot;
    if (sync > lastSyncAt) lastSyncAt = sync;

    let pendingCards = [];
    try { pendingCards = JSON.parse(r.pending_cards_json || '[]'); } catch (_) {}

    courses[r.course_id] = {
      courseId: r.course_id,
      reviewCount: rev,
      knownCount: knw,
      totalCards: tot,
      pendingReviewIds: pendingCards,
      lastSyncAt: sync
    };
  }

  return {
    userId,
    reviewCount: totalReview,
    knownCount: totalKnown,
    totalCards,
    lastSyncAt,
    courses
  };
}

export function getPendingReviewCourses(db, userId) {
  const rows = db.prepare(`
    SELECT course_id, review_count, known_count, total_cards, last_sync_at
    FROM progress
    WHERE user_id = ? AND review_count > 0
    ORDER BY review_count DESC
  `).all(userId);

  return rows.map((r) => ({
    courseId: r.course_id,
    reviewCount: Number(r.review_count),
    knownCount: Number(r.known_count),
    totalCards: Number(r.total_cards),
    lastSyncAt: Number(r.last_sync_at)
  }));
}
