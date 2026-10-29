// Black-box regression for the P0 findings. LOCAL USE ONLY, against your own checkout.
//   node p0_regression.mjs /path/to/Jozveh_Saz-main
// Valid for the JSON-era server (S7-0 acceptance). PASS = the attack is blocked.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const REPO = path.resolve(process.argv[2] || '.');
const TOKEN = '123456:FAKE-TEST-TOKEN';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-'));
Object.assign(process.env, { BOT_TOKEN: TOKEN, MERCHANT_ID: 'REAL-LOOKING-MERCHANT-ID', STATE_DB_PATH: path.join(tmp, 'state.json'), PORT: '0',
  ADMIN_CHAT_ID: '', GEMINI_API_KEY_1: '', GEMINI_API_KEY_2: '', GEMINI_API_KEY_3: '' });
const { server, DB } = await import(pathToFileURL(path.join(REPO, 'server/server.js')).href);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const initData = (id, ageSec = 0) => {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - ageSec), query_id: 'Q', user: JSON.stringify({ id, first_name: 'T' }) });
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
};
const call = async (p, { method = 'GET', body, user, ageSec } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers['X-Telegram-Init-Data'] = initData(user, ageSec);
  const r = await fetch(base + p, { method, headers, body: body && JSON.stringify(body), redirect: 'manual' });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
};
const results = [];
const check = (name, secure, detail = '') => { results.push(secure); console.log(`${secure ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };

const course = fs.readdirSync(path.join(REPO, 'public/data')).find((f) => f.endsWith('.json')).replace('.json', '');
const goodSheba = (() => { const b = '0170000000123456789012'; return 'IR' + String(98n - (BigInt(b + '182700') % 97n)).padStart(2, '0') + b; })();

// T1 unauthenticated verify without Authority must not unlock anything
await call(`/api/payment/verify?courseId=${course}`);
const anon = await call(`/api/course?id=${course}`);
check('T1 /api/payment/verify without Authority does not unlock for anonymous', anon.json?.isProUnlocked !== true, `isProUnlocked=${anon.json?.isProUnlocked}`);
const guestCredit = Object.values(DB.creatorEarnings).reduce((s, v) => s + (v.balanceToman || 0), 0);
check('T1b ...and credits no creator', guestCredit === 0, `credited=${guestCredit}`);

// T2 gateway failure + client-chosen amount must not grant access
const attacker = 999000111;
const pay = await call('/api/payment/create', { method: 'POST', user: attacker, body: { courseId: 'metal_casting_01', amount: 'abc' } });
check('T2 /api/payment/create never grants access when gateway fails / amount is client-supplied', !DB.purchases[`${attacker}_metal_casting_01`], `status=${pay.status}`);

// Seed a victim creator
const victimId = 555000222;
DB.creatorEarnings[String(victimId)] = { balanceToman: 100000, salesCount: 1, history: [{ buyerUserId: 424242, creatorShareToman: 100000 }] };

// T3 creator-stats IDOR
const stats = await call(`/api/creator-stats?creator_id=${victimId}`);
check('T3 /api/creator-stats does not disclose another creator', stats.json?.balanceToman !== 100000 && !JSON.stringify(stats.json || {}).includes('424242'), `status=${stats.status}`);

// T4 payout hijack + checksum
const hij = await call('/api/creator-payout', { method: 'POST', user: attacker, body: { creatorId: String(victimId), sheba: goodSheba } });
check('T4 payout for ANOTHER creator is rejected', hij.status >= 400 && !Object.values(DB.payoutRequests || {}).some((p) => p.creatorId === String(victimId)), `status=${hij.status}`);
const bad = await call('/api/creator-payout', { method: 'POST', user: victimId, body: { sheba: 'IR' + '0'.repeat(24) } });
check('T4b checksum-invalid Sheba rejected (mod-97)', bad.status >= 400, `status=${bad.status}`);

// T5 double payout request on same balance
const p1 = await call('/api/creator-payout', { method: 'POST', user: victimId, body: { sheba: goodSheba } });
const p2 = await call('/api/creator-payout', { method: 'POST', user: victimId, body: { sheba: goodSheba } });
check('T5 second payout request on the same balance is rejected (funds reserved)', p1.status < 400 && p2.status >= 400, `first=${p1.status} second=${p2.status}`);

// T6 stale initData
const stale = await call('/api/sync-progress', { method: 'POST', user: attacker, ageSec: 2 * 86400, body: { courseId: course, reviewCount: 1 } });
check('T6 initData older than the TTL is rejected', stale.status === 401 || stale.status === 403, `status=${stale.status}`);

server.close();
const fails = results.filter((x) => !x).length;
console.log(`\n${results.length - fails}/${results.length} secure. ${fails ? 'VULNERABLE - fix before shipping.' : 'All P0 regressions blocked.'}`);
process.exit(fails ? 1 : 0);
