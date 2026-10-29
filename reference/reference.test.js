import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyInitData } from './tg_auth.js';
import { isValidSheba } from './sheba.js';
import { openDb, migrate, recordSale, requestPayout, balanceOf, splitPrice } from './db.js';

const TOKEN = '123456:TEST-TOKEN';
function sign(fields, token = TOKEN) {
  const p = new URLSearchParams(fields);
  const dcs = [...p.entries()].sort(([a],[b]) => a < b ? -1 : 1).map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256','WebAppData').update(token).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}
const NOW = 1_800_000_000_000;
const base = (o = {}) => ({ auth_date: String(NOW/1000 - 60), query_id: 'AAH', signature: 'x_y-z', user: JSON.stringify({ id: 279058397, first_name: 'A' }), ...o });

test('initData: valid / tampered / wrong token / expired / future / malformed', () => {
  assert.equal(verifyInitData(sign(base()), TOKEN, { nowMs: NOW }).ok, true);
  assert.equal(verifyInitData(sign(base()), TOKEN, { nowMs: NOW }).user.id, 279058397);
  const tampered = sign(base()).replace('279058397', '111111111');
  assert.equal(verifyInitData(tampered, TOKEN, { nowMs: NOW }).reason, 'bad_signature');
  assert.equal(verifyInitData(sign(base()), 'other:token', { nowMs: NOW }).reason, 'bad_signature');
  assert.equal(verifyInitData(sign(base({ auth_date: String(NOW/1000 - 7200) })), TOKEN, { nowMs: NOW }).reason, 'expired');
  assert.equal(verifyInitData(sign(base({ auth_date: String(NOW/1000 + 600) })), TOKEN, { nowMs: NOW }).reason, 'from_future');
  assert.equal(verifyInitData('', TOKEN).reason, 'missing');
  assert.equal(verifyInitData('hash=zz', TOKEN).reason, 'bad_hash_format');
  assert.equal(verifyInitData(sign(base()), '', { nowMs: NOW }).reason, 'server_misconfigured'); // no BOT_TOKEN => never "valid demo user"
});

test('sheba: mod-97 accepts generated valid, rejects 1-digit typo and bad shapes', () => {
  const bban = '0170000000123456789012'; // 22 digits
  const check = String(98n - (BigInt(bban + '1827' + '00') % 97n)).padStart(2, '0');
  const good = `IR${check}${bban}`;
  assert.equal(isValidSheba(good), true);
  assert.equal(isValidSheba(good.slice(0, -1) + (good.at(-1) === '0' ? '1' : '0')), false);
  assert.equal(isValidSheba('IR123'), false);
  assert.equal(isValidSheba('XX' + good.slice(2)), false);
});

test('ledger: idempotent sale, exact split, payout reserves funds (no double-spend)', () => {
  const db = openDb(':memory:'); migrate(db);
  const sale = { buyerId: 1, courseId: 'c1', creatorId: 'cr1', priceToman: 59000, source: 'zarinpal', paymentRef: 'A0001' };
  const r1 = recordSale(db, sale), r2 = recordSale(db, sale), r3 = recordSale(db, sale);
  assert.equal(r1.duplicate, false); assert.equal(r2.duplicate, true); assert.equal(r3.duplicate, true);
  assert.deepEqual(splitPrice(59001), { creator: 41300, platform: 17701 }); // sums exactly
  assert.equal(balanceOf(db, 'cr1'), 41300);                                // credited ONCE
  assert.equal(requestPayout(db, { creatorId: 'cr1', amountToman: 41300, payoutId: 'p1' }).ok, true);
  assert.equal(requestPayout(db, { creatorId: 'cr1', amountToman: 41300, payoutId: 'p2' }).ok, false); // second request blocked
  assert.equal(balanceOf(db, 'cr1'), 0);
  assert.throws(() => db.prepare("INSERT INTO sales(buyer_id,course_id,creator_id,price_toman,creator_share_toman,platform_share_toman,source,payment_ref,created_at) VALUES(1,'c','x',0,0,0,'demo','z',1)").run()); // CHECK price>0
});

test('tx rolls back atomically on failure', () => {
  const db = openDb(':memory:'); migrate(db);
  assert.throws(() => recordSale(db, { buyerId: 1, courseId: 'c', creatorId: 'x', priceToman: 1000, source: 'nope', paymentRef: 'R1' }));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sales').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM creator_ledger').get().n, 0);
});
