import crypto from 'node:crypto';

const codeUnitCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Strict initData verification: signature + freshness + shape. Never "fails open".
export function verifyInitData(raw, botToken, { maxAgeSec = 3600, nowMs = Date.now() } = {}) {
  if (!botToken) return { ok: false, reason: 'server_misconfigured' };
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return { ok: false, reason: 'missing' };

  const params = new URLSearchParams(raw);
  const hash = params.get('hash') || '';
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'bad_hash_format' };
  params.delete('hash'); // NOTE: `signature` (Bot API 8+) stays in the HMAC string

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => codeUnitCompare(a, b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const authDate = Number(params.get('auth_date'));
  if (!Number.isInteger(authDate)) return { ok: false, reason: 'no_auth_date' };
  const ageSec = Math.floor(nowMs / 1000) - authDate;
  if (ageSec > maxAgeSec) return { ok: false, reason: 'expired' };
  if (ageSec < -60) return { ok: false, reason: 'from_future' };

  let user;
  try { user = JSON.parse(params.get('user') || ''); } catch { return { ok: false, reason: 'bad_user' }; }
  if (!Number.isSafeInteger(user?.id) || user.id <= 0) return { ok: false, reason: 'bad_user' };

  return { ok: true, user, authDate, startParam: params.get('start_param') || null };
}
