import crypto from 'node:crypto';

const codeUnitCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Mints correctly signed Telegram initData query string.
 */
export function mintInitData(
  {
    id = 279058397,
    first_name = 'DevStudent',
    username = 'dev_student',
    query_id = 'AAH_dev',
    signature = 'dev_sig',
    auth_date = Math.floor(Date.now() / 1000),
    start_param = null
  } = {},
  botToken = process.env.BOT_TOKEN || '123456:DEV-TOKEN'
) {
  const user = { id, first_name };
  if (username) user.username = username;

  const params = new URLSearchParams();
  params.set('auth_date', String(auth_date));
  if (query_id) params.set('query_id', query_id);
  if (signature) params.set('signature', signature);
  if (start_param) params.set('start_param', start_param);
  params.set('user', JSON.stringify(user));

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => codeUnitCompare(a, b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  params.set('hash', hash);

  return params.toString();
}

if (process.argv[1] && process.argv[1].endsWith('dev_initdata.js')) {
  const token = process.argv[2] || process.env.BOT_TOKEN || '123456:DEV-TOKEN';
  const minted = mintInitData({}, token);
  console.log(minted);
}
