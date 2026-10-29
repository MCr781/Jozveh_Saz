import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message = '') {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

const codeUnitCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Strict initData verification: signature + freshness + shape.
 * Never fails open.
 */
export function verifyInitData(raw, botToken, { maxAgeSec = 86400, nowMs = Date.now() } = {}) {
  const token = (botToken || '').trim();
  if (!token) return { ok: false, valid: false, reason: 'server_misconfigured' };
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) {
    return { ok: false, valid: false, reason: 'missing' };
  }

  try {
    const params = new URLSearchParams(raw);
    const hash = params.get('hash') || '';
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return { ok: false, valid: false, reason: 'bad_hash_format' };
    }
    params.delete('hash'); // NOTE: `signature` (Bot API 8+) stays in the HMAC string

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => codeUnitCompare(a, b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest();
    const given = Buffer.from(hash, 'hex');
    if (given.length !== expected.length || !crypto.timingSafeEqual(expected, given)) {
      return { ok: false, valid: false, reason: 'bad_signature' };
    }

    const authDate = Number(params.get('auth_date'));
    if (!Number.isInteger(authDate)) {
      return { ok: false, valid: false, reason: 'no_auth_date' };
    }
    const ageSec = Math.floor(nowMs / 1000) - authDate;
    if (ageSec > maxAgeSec) {
      return { ok: false, valid: false, reason: 'expired' };
    }
    if (ageSec < -60) {
      return { ok: false, valid: false, reason: 'from_future' };
    }

    let user;
    try {
      user = JSON.parse(params.get('user') || '');
    } catch {
      return { ok: false, valid: false, reason: 'bad_user' };
    }

    if (!user || typeof user !== 'object' || !Number.isSafeInteger(user?.id) || user.id <= 0) {
      return { ok: false, valid: false, reason: 'bad_user' };
    }

    return {
      ok: true,
      valid: true,
      user,
      authDate,
      startParam: params.get('start_param') || null
    };
  } catch (_) {
    return { ok: false, valid: false, reason: 'malformed' };
  }
}

/**
 * Extracts raw initData from request headers.
 */
export function extractInitDataRaw(req) {
  const header = req.headers['x-telegram-init-data'] || req.headers['authorization'] || '';
  if (typeof header !== 'string') return '';
  if (header.startsWith('tma ')) return header.slice(4).trim();
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return header.trim();
}

/**
 * Requires verified Telegram user or throws HttpError(401, code).
 */
export function requireUser(req, { money = false, botToken = process.env.BOT_TOKEN } = {}) {
  const raw = extractInitDataRaw(req);
  if (!raw) {
    throw new HttpError(401, 'missing', 'Missing Telegram authentication.');
  }

  const maxAgeSec = money
    ? Number(process.env.INITDATA_MONEY_MAX_AGE_SEC || 3600)
    : Number(process.env.INITDATA_MAX_AGE_SEC || 86400);

  const res = verifyInitData(raw, botToken, { maxAgeSec });
  if (!res.ok) {
    throw new HttpError(401, res.reason, `Telegram authentication failed: ${res.reason}`);
  }

  return res.user;
}

/**
 * Optional user for public routes (e.g. anonymous catalog).
 * If header is provided, it must be valid or throws HttpError(401).
 * If no header is provided, returns null.
 */
export function optionalUser(req, { botToken = process.env.BOT_TOKEN } = {}) {
  const raw = extractInitDataRaw(req);
  if (!raw) return null;
  return requireUser(req, { money: false, botToken });
}
