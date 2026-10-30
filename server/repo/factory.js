import { tx } from '../db.js';

/**
 * Computes 64-bit Hamming distance between two hex-encoded hashes.
 * Returns integer 0..64.
 */
export function computeHammingDistance(h1, h2) {
  if (!h1 || !h2 || typeof h1 !== 'string' || typeof h2 !== 'string') return 64;
  const clean1 = h1.replace(/^0x/i, '').padStart(16, '0');
  const clean2 = h2.replace(/^0x/i, '').padStart(16, '0');
  try {
    let x = BigInt('0x' + clean1) ^ BigInt('0x' + clean2);
    let dist = 0;
    while (x > 0n) {
      if (x & 1n) dist++;
      x >>= 1n;
    }
    return dist;
  } catch (_) {
    return 64;
  }
}

/**
 * Checks whether any page from a published or review job by a DIFFERENT creator
 * has an identical SHA-256 or a dHash Hamming distance <= 4.
 */
export function checkDuplicateSource(db, { imageSha256, dhash, creatorId }) {
  const query = `
    SELECT fp.job_id, fp.page_num, fp.image_sha256, fp.dhash, fj.creator_id, fj.course_slug
    FROM factory_pages fp
    JOIN factory_jobs fj ON fp.job_id = fj.id
    WHERE fj.creator_id != ? AND fj.state IN ('human_review', 'published')
  `;
  const rows = db.prepare(query).all(String(creatorId));

  for (const row of rows) {
    if (imageSha256 && row.image_sha256 === imageSha256) {
      return {
        duplicate: true,
        reason: 'exact_sha256',
        matchedJobId: row.job_id,
        matchedCourse: row.course_slug,
        matchedPage: row.page_num
      };
    }
    if (dhash && row.dhash) {
      const dist = computeHammingDistance(row.dhash, dhash);
      if (dist <= 4) {
        return {
          duplicate: true,
          reason: 'dhash_similarity',
          distance: dist,
          matchedJobId: row.job_id,
          matchedCourse: row.course_slug,
          matchedPage: row.page_num
        };
      }
    }
  }

  return { duplicate: false };
}

/**
 * Creates a factory job in state 'intake'.
 */
export function createFactoryJob(db, {
  id,
  creatorId,
  courseSlug,
  title,
  category = 'دروس عمومی مهندسی',
  priceToman = 59000,
  tokenBudget = 60000,
  now = Date.now()
}) {
  return tx(db, () => {
    db.prepare(`
      INSERT INTO factory_jobs(
        id, creator_id, course_slug, title, category, price_toman,
        state, draft_json, validation_report, tokens_used, token_budget,
        error_code, created_at, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, 'intake', NULL, NULL, 0, ?, NULL, ?, ?)
    `).run(
      id,
      String(creatorId),
      courseSlug,
      title,
      category,
      priceToman,
      tokenBudget,
      now,
      now
    );

    return { id, creatorId: String(creatorId), courseSlug, state: 'intake' };
  });
}

/**
 * Adds pages to a factory job.
 */
export function addFactoryPages(db, jobId, pages) {
  return tx(db, () => {
    const insertStmt = db.prepare(`
      INSERT INTO factory_pages(
        job_id, page_num, image_sha256, dhash, blur_score, exposure_score,
        transcription_json, confidence, uncertain
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const p of pages) {
      insertStmt.run(
        jobId,
        p.pageNum,
        p.imageSha256,
        p.dhash,
        p.blurScore,
        p.exposureScore,
        typeof p.transcriptionJson === 'object' ? JSON.stringify(p.transcriptionJson) : (p.transcriptionJson || null),
        p.confidence !== undefined ? p.confidence : null,
        p.uncertain ? 1 : 0
      );
    }

    return { count: pages.length };
  });
}

/**
 * Returns a factory job along with its pages.
 */
export function getFactoryJob(db, jobId) {
  const job = db.prepare('SELECT * FROM factory_jobs WHERE id = ?').get(jobId);
  if (!job) return null;

  const pages = db.prepare('SELECT * FROM factory_pages WHERE job_id = ? ORDER BY page_num ASC').all(jobId);

  let draft = null;
  if (job.draft_json) {
    try {
      draft = JSON.parse(job.draft_json);
    } catch (_) {
      draft = job.draft_json;
    }
  }

  let validationReport = null;
  if (job.validation_report) {
    try {
      validationReport = JSON.parse(job.validation_report);
    } catch (_) {
      validationReport = job.validation_report;
    }
  }

  const parsedPages = pages.map((p) => {
    let transcription = null;
    if (p.transcription_json) {
      try {
        transcription = JSON.parse(p.transcription_json);
      } catch (_) {
        transcription = p.transcription_json;
      }
    }
    return {
      ...p,
      uncertain: Boolean(p.uncertain),
      transcription
    };
  });

  return {
    ...job,
    draft,
    validationReport,
    pages: parsedPages
  };
}

/**
 * Lists factory jobs, optionally filtered by creatorId.
 */
export function listFactoryJobs(db, creatorId = null) {
  const query = creatorId
    ? 'SELECT * FROM factory_jobs WHERE creator_id = ? ORDER BY created_at DESC'
    : 'SELECT * FROM factory_jobs ORDER BY created_at DESC';
  const rows = creatorId ? db.prepare(query).all(String(creatorId)) : db.prepare(query).all();

  return rows.map((job) => {
    let draft = null;
    if (job.draft_json) {
      try { draft = JSON.parse(job.draft_json); } catch (_) { draft = job.draft_json; }
    }
    let validationReport = null;
    if (job.validation_report) {
      try { validationReport = JSON.parse(job.validation_report); } catch (_) { validationReport = job.validation_report; }
    }
    return {
      ...job,
      draft,
      validationReport
    };
  });
}

/**
 * Advances job state and updates optional fields.
 */
export function advanceJobState(db, jobId, state, extra = {}) {
  return tx(db, () => {
    const job = db.prepare('SELECT id, tokens_used FROM factory_jobs WHERE id = ?').get(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const draftJson = extra.draftJson !== undefined
      ? (typeof extra.draftJson === 'object' ? JSON.stringify(extra.draftJson) : extra.draftJson)
      : null;

    const validationReport = extra.validationReport !== undefined
      ? (typeof extra.validationReport === 'object' ? JSON.stringify(extra.validationReport) : extra.validationReport)
      : null;

    const tokensUsed = extra.tokensUsed !== undefined ? (job.tokens_used + Number(extra.tokensUsed)) : job.tokens_used;
    const errorCode = extra.errorCode !== undefined ? extra.errorCode : null;
    const now = extra.now || Date.now();

    db.prepare(`
      UPDATE factory_jobs
      SET state = ?,
          draft_json = COALESCE(?, draft_json),
          validation_report = COALESCE(?, validation_report),
          tokens_used = ?,
          error_code = ?,
          updated_at = ?
      WHERE id = ?
    `).run(state, draftJson, validationReport, tokensUsed, errorCode, now, jobId);

    return { id: jobId, state };
  });
}

/**
 * Saves a job draft and validation report, landing in state 'human_review'.
 */
export function saveJobDraft(db, jobId, { draftJson, validationReport, tokensUsed = 0, state = 'human_review', now = Date.now() }) {
  return advanceJobState(db, jobId, state, { draftJson, validationReport, tokensUsed, now });
}

/**
 * Approves and marks a job as 'published'.
 */
export function approveAndPublishJob(db, jobId, finalCourseJson = null, now = Date.now()) {
  return tx(db, () => {
    const draftStr = finalCourseJson
      ? (typeof finalCourseJson === 'object' ? JSON.stringify(finalCourseJson) : finalCourseJson)
      : null;

    db.prepare(`
      UPDATE factory_jobs
      SET state = 'published',
          draft_json = COALESCE(?, draft_json),
          updated_at = ?
      WHERE id = ?
    `).run(draftStr, now, jobId);

    return { id: jobId, state: 'published' };
  });
}

/**
 * Creates a content takedown request.
 */
export function createTakedownRequest(db, { id, courseId, reporterId, reason, now = Date.now() }) {
  return tx(db, () => {
    db.prepare(`
      INSERT INTO content_takedowns(id, course_id, reporter_id, reason, status, created_at)
      VALUES(?, ?, ?, ?, 'pending', ?)
    `).run(id, courseId, String(reporterId), reason, now);

    return { id, courseId, status: 'pending' };
  });
}

/**
 * Resolves a content takedown request.
 * If approved, updates matching factory_jobs state to 'takedown'.
 */
export function resolveTakedownRequest(db, { id, approve, now = Date.now() }) {
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM content_takedowns WHERE id = ?').get(id);
    if (!row) return null;

    const newStatus = approve ? 'approved' : 'rejected';
    db.prepare(`
      UPDATE content_takedowns
      SET status = ?, resolved_at = ?
      WHERE id = ?
    `).run(newStatus, now, id);

    if (approve) {
      db.prepare(`
        UPDATE factory_jobs
        SET state = 'takedown', updated_at = ?
        WHERE (id = ? OR course_slug = ?)
      `).run(now, row.course_id, row.course_id);
    }

    return { id, courseId: row.course_id, status: newStatus };
  });
}

/**
 * Checks whether a course is marked as takedown (either approved takedown request
 * or factory job in state 'takedown').
 */
export function isCourseTakedown(db, courseId) {
  if (!courseId) return false;
  const takedown = db.prepare(`
    SELECT id FROM content_takedowns
    WHERE course_id = ? AND status = 'approved'
  `).get(courseId);
  if (takedown) return true;

  const job = db.prepare(`
    SELECT id FROM factory_jobs
    WHERE (id = ? OR course_slug = ?) AND state = 'takedown'
  `).get(courseId, courseId);
  return Boolean(job);
}
