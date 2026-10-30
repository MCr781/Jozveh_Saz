import { tx } from '../db.js';
import { addBonusQuota } from './ai.js';
import crypto from 'node:crypto';

export const UNIVERSITIES = [
  { id: 'ut', name: 'دانشگاه تهران' },
  { id: 'sharif', name: 'دانشگاه صنعتی شریف' },
  { id: 'aut', name: 'دانشگاه صنعتی امیرکبیر' },
  { id: 'iust', name: 'دانشگاه علم و صنعت' },
  { id: 'iut', name: 'دانشگاه صنعتی اصفهان' },
  { id: 'shirazu', name: 'دانشگاه شیراز' },
  { id: 'azad', name: 'دانشگاه آزاد اسلامی' }
];

export const DEPARTMENTS = [
  { id: 'materials', name: 'مهندسی مواد و متالورژی', category: 'مهندسی مواد و متالورژی' },
  { id: 'computer', name: 'مهندسی کامپیوتر', category: 'مهندسی کامپیوتر' },
  { id: 'electrical', name: 'مهندسی برق', category: 'مهندسی برق' },
  { id: 'mechanical', name: 'مهندسی مکانیک', category: 'مهندسی مکانیک' },
  { id: 'civil', name: 'مهندسی عمران', category: 'مهندسی عمران' },
  { id: 'basic_sciences', name: 'علوم پایه و ریاضیات', category: 'دروس پایه مهندسی' }
];

/**
 * Computes Iran Standard Time date key (UTC+03:30, no DST).
 * Format: YYYY-MM-DD
 */
export function getIranDayKey(timestamp = Date.now()) {
  const d = new Date(timestamp + 3.5 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Generates or retrieves an opaque referral code for a user (ref_<10-hex>).
 * Never exposes the raw Telegram ID.
 */
export function getOrCreateReferralCode(db, userId, now = Date.now()) {
  const numUserId = Number(userId);
  const existing = db.prepare('SELECT code FROM referral_codes WHERE user_id = ?').get(numUserId);
  if (existing) return existing.code;

  return tx(db, () => {
    // Generate unique opaque code
    let code = `ref_${crypto.randomBytes(5).toString('hex')}`;
    let attempts = 0;
    while (attempts < 5) {
      try {
        db.prepare(`
          INSERT INTO referral_codes(user_id, code, created_at)
          VALUES(?, ?, ?)
        `).run(numUserId, code, now);
        return code;
      } catch (err) {
        attempts++;
        code = `ref_${crypto.randomBytes(5).toString('hex')}`;
      }
    }
    return code;
  });
}

/**
 * Resolves referral code to referrer user ID.
 */
export function resolveReferralCode(db, code) {
  if (!code || typeof code !== 'string') return null;
  const cleanCode = code.trim();
  return db.prepare('SELECT user_id, code FROM referral_codes WHERE code = ?').get(cleanCode) || null;
}

/**
 * Binds referee to referrer if eligible:
 * - Rejects self-referrals
 * - First-touch attribution only (UNIQUE referee_id)
 * - Rejects existing buyers
 */
export function bindReferralIfEligible(db, { refereeId, startParam, now = Date.now() }) {
  if (!refereeId || !startParam || typeof startParam !== 'string') {
    return { bound: false, reason: 'missing_params' };
  }

  const numRefereeId = Number(refereeId);
  const param = startParam.trim();
  const code = param.startsWith('ref_') ? param : `ref_${param}`;

  const row = resolveReferralCode(db, code);
  if (!row) {
    return { bound: false, reason: 'invalid_code' };
  }

  const referrerId = Number(row.user_id);
  if (referrerId === numRefereeId) {
    return { bound: false, reason: 'self_referral' };
  }

  // First-touch attribution: referee can only be referred once
  const existingRef = db.prepare('SELECT referee_id FROM referrals WHERE referee_id = ?').get(numRefereeId);
  if (existingRef) {
    return { bound: false, reason: 'already_referred' };
  }

  // Reject existing customers (prior purchases)
  const existingPurchase = db.prepare('SELECT buyer_id FROM purchases WHERE buyer_id = ? LIMIT 1').get(numRefereeId);
  if (existingPurchase) {
    return { bound: false, reason: 'existing_customer' };
  }

  return tx(db, () => {
    db.prepare(`
      INSERT INTO referrals(referee_id, referrer_id, code, status, created_at)
      VALUES(?, ?, ?, 'bound', ?)
    `).run(numRefereeId, referrerId, code, now);

    return { bound: true, referrerId, code };
  });
}

/**
 * Unlocks referral reward (+5 AI questions to referrer & referee) ONLY upon
 * referee's first settled purchase, enforcing a daily cap of 5 rewarded referrals per Iran day.
 */
export function triggerReferralRewardOnSale(db, { buyerId, courseId = 'default', now = Date.now() }) {
  const numBuyerId = Number(buyerId);
  return tx(db, () => {
    const ref = db.prepare(`
      SELECT referee_id, referrer_id, code, status
      FROM referrals
      WHERE referee_id = ? AND status = 'bound'
    `).get(numBuyerId);

    if (!ref) {
      return { rewarded: false, reason: 'no_pending_referral' };
    }

    const referrerId = Number(ref.referrer_id);

    // Enforce daily cap: max 5 rewarded referrals per referrer per Iran day (UTC+03:30)
    const todayKey = getIranDayKey(now);
    const rewardedRows = db.prepare(`
      SELECT rewarded_at FROM referrals
      WHERE referrer_id = ? AND status = 'rewarded' AND rewarded_at IS NOT NULL
    `).all(referrerId);

    const countToday = rewardedRows.filter((r) => getIranDayKey(r.rewarded_at) === todayKey).length;
    if (countToday >= 5) {
      return { rewarded: false, reason: 'daily_cap_reached', referrerId };
    }

    // Mark referral rewarded
    db.prepare(`
      UPDATE referrals
      SET status = 'rewarded', rewarded_at = ?
      WHERE referee_id = ?
    `).run(now, numBuyerId);

    // Grant +5 bonus quota to referrer
    addBonusQuota(db, { userId: referrerId, courseId: 'default', bonus: 5, now });

    // Grant +5 bonus quota to referee on current course
    addBonusQuota(db, { userId: numBuyerId, courseId, bonus: 5, now });

    return {
      rewarded: true,
      referrerId,
      refereeId: numBuyerId,
      bonus: 5
    };
  });
}

/**
 * Saves or updates student's 2-tap university, department, and term profile.
 * Strictly validates against the curated static catalog (no free-text).
 */
export function saveCampusProfile(db, { userId, universityId, departmentId, term, now = Date.now() }) {
  const numUserId = Number(userId);
  const numTerm = Number(term);

  const isValidUni = UNIVERSITIES.some((u) => u.id === universityId);
  const isValidDept = DEPARTMENTS.some((d) => d.id === departmentId);
  const isValidTerm = Number.isInteger(numTerm) && numTerm >= 1 && numTerm <= 12;

  if (!isValidUni || !isValidDept || !isValidTerm) {
    throw new Error('مقادیر دانشگاه، رشته یا ترم نامعتبر است.');
  }

  return tx(db, () => {
    db.prepare(`
      INSERT INTO campus_profiles(user_id, university_id, department_id, term, updated_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        university_id = excluded.university_id,
        department_id = excluded.department_id,
        term = excluded.term,
        updated_at = excluded.updated_at
    `).run(numUserId, universityId, departmentId, numTerm, now);

    return {
      userId: numUserId,
      universityId,
      departmentId,
      term: numTerm
    };
  });
}

/**
 * Retrieves student's campus profile.
 */
export function getCampusProfile(db, userId) {
  const numUserId = Number(userId);
  const row = db.prepare('SELECT * FROM campus_profiles WHERE user_id = ?').get(numUserId);
  if (!row) return null;

  const uni = UNIVERSITIES.find((u) => u.id === row.university_id);
  const dept = DEPARTMENTS.find((d) => d.id === row.department_id);

  return {
    universityId: row.university_id,
    universityName: uni?.name || row.university_id,
    departmentId: row.department_id,
    departmentName: dept?.name || row.department_id,
    departmentCategory: dept?.category || '',
    term: row.term
  };
}

/**
 * Records a server-side study event for streak computation.
 */
export function recordStudyEvent(db, { userId, courseId, cardsReviewed = 1, now = Date.now() }) {
  const numUserId = Number(userId);
  const dayKey = getIranDayKey(now);
  const count = Math.max(1, Number(cardsReviewed) || 1);

  return tx(db, () => {
    db.prepare(`
      INSERT INTO study_events(user_id, course_id, day_key, cards_reviewed, updated_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(user_id, day_key) DO UPDATE SET
        cards_reviewed = cards_reviewed + excluded.cards_reviewed,
        updated_at = excluded.updated_at
    `).run(numUserId, courseId || 'default', dayKey, count, now);

    return { userId: numUserId, dayKey, cardsReviewed: count };
  });
}

/**
 * Computes consecutive study streak days and badges strictly from server-side events (UTC+03:30).
 */
export function getStreakAndBadges(db, userId, now = Date.now()) {
  const numUserId = Number(userId);
  const rows = db.prepare(`
    SELECT day_key, cards_reviewed
    FROM study_events
    WHERE user_id = ?
    ORDER BY day_key DESC
  `).all(numUserId);

  if (!rows || rows.length === 0) {
    return { currentStreakDays: 0, badges: [], totalCardsReviewed: 0 };
  }

  const todayKey = getIranDayKey(now);
  const yesterdayKey = getIranDayKey(now - 24 * 3600 * 1000);

  const daySet = new Set(rows.map((r) => r.day_key));
  let streak = 0;

  // Streak continues if user studied today OR yesterday
  let checkTime = daySet.has(todayKey) ? now : (daySet.has(yesterdayKey) ? (now - 24 * 3600 * 1000) : null);

  if (checkTime !== null) {
    while (true) {
      const key = getIranDayKey(checkTime);
      if (daySet.has(key)) {
        streak++;
        checkTime -= 24 * 3600 * 1000;
      } else {
        break;
      }
    }
  }

  const totalCardsReviewed = rows.reduce((sum, r) => sum + Number(r.cards_reviewed || 0), 0);

  const badges = [];
  if (streak >= 3) badges.push('streak_3');
  if (streak >= 7) badges.push('streak_7');
  if (streak >= 14 || totalCardsReviewed >= 50) badges.push('exam_warrior');

  return {
    currentStreakDays: streak,
    badges,
    totalCardsReviewed
  };
}

/**
 * Sets exam date for a course.
 */
export function saveCourseExamDate(db, { userId, courseId, examAt }) {
  const numUserId = Number(userId);
  const numExamAt = Number(examAt);
  if (!Number.isFinite(numExamAt) || numExamAt <= 0) {
    throw new Error('زمان برگزاری امتحان نامعتبر است.');
  }

  return tx(db, () => {
    db.prepare(`
      INSERT INTO course_exams(user_id, course_id, exam_at)
      VALUES(?, ?, ?)
      ON CONFLICT(user_id, course_id) DO UPDATE SET
        exam_at = excluded.exam_at
    `).run(numUserId, courseId, numExamAt);

    return { userId: numUserId, courseId, examAt: numExamAt };
  });
}

/**
 * Generates an Exam-Eve Panic Plan (25-minute Pomodoro cram blocks)
 * from weak Leitner cards + high-priority formulas.
 */
export function getCourseExamPlan(db, { userId, courseId, courseData, userProgress = {}, now = Date.now() }) {
  const numUserId = Number(userId);
  const canonicalId = courseData?.id || courseId;
  const examRow = db.prepare(`
    SELECT exam_at FROM course_exams
    WHERE user_id = ? AND (course_id = ? OR course_id = ?)
  `).get(numUserId, courseId, canonicalId);

  if (!examRow) {
    return { hasExam: false, panicMode: false, hoursRemaining: null, plan: [] };
  }

  const examAt = Number(examRow.exam_at);
  const diffMs = examAt - now;
  const hoursRemaining = Math.max(0, Math.round(diffMs / (3600 * 1000)));
  const panicMode = diffMs > 0 && diffMs <= 24 * 3600 * 1000;

  if (!courseData) {
    return { hasExam: true, examAt, hoursRemaining, panicMode, plan: [] };
  }

  const flashcards = courseData.flashcards || [];
  const formulas = courseData.summary_cheat_sheet || [];
  const leitnerStatus = userProgress.leitnerStatus || {};

  // Prioritize weak cards (review requested or not yet known)
  const weakCards = flashcards.filter((fc) => {
    const st = leitnerStatus[fc.id];
    return st === 'review' || !st;
  });

  const cardsPool = weakCards.length > 0 ? weakCards : flashcards;

  // Partition into 25-minute sprints (up to 4 cards + 2 formulas per block)
  const sprints = [];
  const cardsPerSprint = 4;
  const formulasPerSprint = 2;

  let cardIdx = 0;
  let formulaIdx = 0;
  let sprintNum = 1;

  while (cardIdx < cardsPool.length || formulaIdx < formulas.length) {
    const sprintCards = cardsPool.slice(cardIdx, cardIdx + cardsPerSprint);
    const sprintFormulas = formulas.slice(formulaIdx, formulaIdx + formulasPerSprint);

    sprints.push({
      sprintNumber: sprintNum,
      durationMinutes: 25,
      title: `اسپرینت ${sprintNum}: مرور متمرکز شب امتحان`,
      cards: sprintCards.map((c) => ({ id: c.id, front: c.front, back: c.back, page: c.source_page })),
      formulas: sprintFormulas.map((f) => ({ topic: f.topic, formula_latex: f.formula_latex }))
    });

    cardIdx += cardsPerSprint;
    formulaIdx += formulasPerSprint;
    sprintNum++;

    // Cap at 6 sprints (3 hours max cram session)
    if (sprintNum > 6) break;
  }

  return {
    ok: true,
    hasExam: true,
    examAt,
    hoursRemaining,
    panicMode,
    plan: sprints
  };
}

/**
 * Parses deep-link parameter for direct card navigation.
 * Formats: card_<courseId>_<cardId> (e.g. card_sample_course_fc_1, card_eng_math_01_2)
 */
export function parseCardDeepLink(startParam, catalog = []) {
  if (!startParam || typeof startParam !== 'string' || !startParam.startsWith('card_')) {
    return { isCardDeepLink: false };
  }

  const remainder = startParam.slice(5); // strip 'card_'

  if (Array.isArray(catalog) && catalog.length > 0) {
    for (const item of catalog) {
      const slug = item.slug || item.data?.id;
      const id = item.data?.id;
      if (slug && remainder.startsWith(slug + '_')) {
        return {
          isCardDeepLink: true,
          courseId: slug,
          cardId: remainder.slice(slug.length + 1)
        };
      }
      if (id && remainder.startsWith(id + '_')) {
        return {
          isCardDeepLink: true,
          courseId: id,
          cardId: remainder.slice(id.length + 1)
        };
      }
    }
  }

  const patternMatch = remainder.match(/^(.+?)_(fc_\d+|exam_\d+|summary_\d+|\d+)$/);
  if (patternMatch) {
    return {
      isCardDeepLink: true,
      courseId: patternMatch[1],
      cardId: patternMatch[2]
    };
  }

  const lastUnderscore = remainder.lastIndexOf('_');
  if (lastUnderscore > 0) {
    return {
      isCardDeepLink: true,
      courseId: remainder.slice(0, lastUnderscore),
      cardId: remainder.slice(lastUnderscore + 1)
    };
  }

  return { isCardDeepLink: false };
}

/**
 * Schedules a channel broadcast post.
 */
export function scheduleBroadcastPost(db, { channelId, courseId, cardId, teaserText, scheduledAt = Date.now() }) {
  return tx(db, () => {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO scheduled_posts(channel_id, course_id, card_id, teaser_text, scheduled_at, status)
      VALUES(?, ?, ?, ?, ?, 'pending')
    `).run(String(channelId), courseId, cardId, teaserText, scheduledAt);

    return { id: Number(lastInsertRowid), status: 'pending' };
  });
}

/**
 * Token-bucket broadcast worker:
 * - Max 25 msgs/sec overall
 * - Max 1 msg/sec per channel_id
 * - Appends deep-link button (https://t.me/<bot>?startapp=card_<courseId>_<cardId>)
 * - Handles 429 Too Many Requests with retry_after backoff
 * - Handles 403 Forbidden by marking user bot_blocked_at
 */
export async function processScheduledBroadcasts(db, {
  sendFn,
  now = Date.now(),
  maxPerTick = 25,
  botUsername = 'JozvehSazBot'
}) {
  const pendingPosts = db.prepare(`
    SELECT * FROM scheduled_posts
    WHERE status = 'pending'
      AND scheduled_at <= ?
      AND (retry_after IS NULL OR retry_after <= ?)
    ORDER BY scheduled_at ASC
    LIMIT ?
  `).all(now, now, maxPerTick);

  if (!pendingPosts.length) {
    return { processed: 0, sent: 0, rescheduled: 0, failed: 0 };
  }

  const seenChannels = new Set();
  let sentCount = 0;
  let rescheduledCount = 0;
  let failedCount = 0;

  for (const post of pendingPosts) {
    // Per-channel rate limit: max 1 per channel per tick
    if (seenChannels.has(post.channel_id)) {
      continue;
    }
    seenChannels.add(post.channel_id);

    const deepLinkUrl = `https://t.me/${botUsername}?startapp=card_${post.course_id}_${post.card_id}`;

    try {
      await sendFn({
        ...post,
        deepLinkUrl
      });

      // Mark sent
      tx(db, () => {
        db.prepare(`
          UPDATE scheduled_posts
          SET status = 'sent', sent_at = ?
          WHERE id = ?
        `).run(now, post.id);
      });
      sentCount++;
    } catch (err) {
      if (err.statusCode === 429 || err.status === 429 || err.code === 429) {
        const retrySec = Number(err.retryAfter || err.parameters?.retry_after || 5);
        tx(db, () => {
          db.prepare(`
            UPDATE scheduled_posts
            SET retry_after = ?, status = 'pending'
            WHERE id = ?
          `).run(now + retrySec * 1000, post.id);
        });
        rescheduledCount++;
      } else if (err.statusCode === 403 || err.status === 403 || err.code === 403) {
        tx(db, () => {
          db.prepare(`
            UPDATE scheduled_posts
            SET status = 'failed'
            WHERE id = ?
          `).run(post.id);
          markUserBotBlocked(db, post.channel_id, now);
        });
        failedCount++;
      } else {
        tx(db, () => {
          db.prepare(`
            UPDATE scheduled_posts
            SET status = 'failed'
            WHERE id = ?
          `).run(post.id);
        });
        failedCount++;
      }
    }
  }

  return {
    processed: pendingPosts.length,
    sent: sentCount,
    rescheduled: rescheduledCount,
    failed: failedCount
  };
}

/**
 * Marks a user as having blocked the bot (403 Forbidden).
 */
export function markUserBotBlocked(db, userId, now = Date.now()) {
  const numId = Number(userId);
  if (!Number.isSafeInteger(numId) || numId <= 0) return;
  try {
    db.prepare('UPDATE users SET bot_blocked_at = ? WHERE telegram_id = ?').run(now, numId);
  } catch (_) {}
}

/**
 * Checks whether user has blocked the bot.
 */
export function isUserBotBlocked(db, userId) {
  const numId = Number(userId);
  if (!Number.isSafeInteger(numId) || numId <= 0) return false;
  try {
    const row = db.prepare('SELECT bot_blocked_at FROM users WHERE telegram_id = ?').get(numId);
    return Boolean(row?.bot_blocked_at);
  } catch (_) {
    return false;
  }
}
