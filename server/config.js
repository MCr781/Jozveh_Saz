import './env.js';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Validates configuration according to the Sprint 7 contract.
 * Returns an object with { valid: boolean, errors: string[] }.
 */
export function validateConfig(env = process.env) {
  const isProd = (env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const errors = [];

  if (isProd) {
    const botToken = (env.BOT_TOKEN || '').trim();
    if (!botToken) {
      errors.push('BOT_TOKEN is required in production.');
    }

    if ((env.ALLOW_DEMO_PAYMENTS || '').trim() === '1') {
      errors.push('ALLOW_DEMO_PAYMENTS is forbidden in production.');
    }

    // Merchant ID: in production, if provided, must not be 'demo' or 'YOUR_*'.
    // If undefined or empty, server boots in manual-receipt-only mode (onlineGatewayEnabled: false).
    if (env.MERCHANT_ID !== undefined) {
      const merchantId = env.MERCHANT_ID.trim();
      if (merchantId.toLowerCase() === 'demo' || merchantId.startsWith('YOUR_')) {
        errors.push("MERCHANT_ID must not be a placeholder ('demo' or 'YOUR_*') in production.");
      }
    }

    const dbPath = (env.STATE_DB_PATH || '').trim();
    if (dbPath && !path.isAbsolute(dbPath)) {
      errors.push('STATE_DB_PATH must be an absolute path.');
    }

    // Gemini Model: if undefined, defaults cleanly to 'gemini-3.8-flash'.
    // Only fails if explicitly set to empty or whitespace string.
    if (env.GEMINI_MODEL !== undefined && env.GEMINI_MODEL.trim() === '') {
      errors.push('GEMINI_MODEL cannot be empty/whitespace when specified.');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Exits non-zero at boot if production validation fails.
 */
export function validateConfigOrExit(env = process.env) {
  const { valid, errors } = validateConfig(env);
  if (!valid) {
    for (const err of errors) {
      console.error(`❌ CONFIG ERROR: ${err}`);
    }
    process.exit(1);
  }
}

/**
 * Parses and returns a frozen configuration object from env.
 */
export function loadConfig(env = process.env) {
  const isProd = (env.NODE_ENV || '').trim().toLowerCase() === 'production';
  const rawPort = Number((env.PORT || '').trim());
  const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 3000;

  const rawStateDbPath = (env.STATE_DB_PATH || '').trim();
  const stateDbPath = rawStateDbPath
    ? (path.isAbsolute(rawStateDbPath) ? rawStateDbPath : path.resolve(process.cwd(), rawStateDbPath))
    : path.resolve(process.cwd(), 'server/jozveh.db');

  const geminiModel = (env.GEMINI_MODEL || '').trim() || 'gemini-3.8-flash';
  const maxAgeSec = Number((env.INITDATA_MAX_AGE_SEC || '').trim()) || 86400;
  const moneyMaxAgeSec = Number((env.INITDATA_MONEY_MAX_AGE_SEC || '').trim()) || 3600;

  const geminiKeys = [
    (env.GEMINI_API_KEY_1 || '').trim(),
    (env.GEMINI_API_KEY_2 || '').trim(),
    (env.GEMINI_API_KEY_3 || '').trim()
  ].filter((k) => k && !k.startsWith('YOUR_'));

  const merchantId = (env.MERCHANT_ID || '').trim();
  const onlineGatewayEnabled = Boolean(merchantId && merchantId.toLowerCase() !== 'demo' && !merchantId.startsWith('YOUR_'));

  const rawMinPayout = Number((env.MIN_PAYOUT_TOMAN || '').trim());
  const minPayoutToman = Number.isInteger(rawMinPayout) && rawMinPayout > 0 ? rawMinPayout : 50000;

  const botToken = (env.BOT_TOKEN || '').trim();
  const deterministicBackupKey = crypto
    .createHmac('sha256', botToken || 'JozvehDefaultSecret')
    .update('JozvehBackupKey')
    .digest('hex');
  const backupKey = (env.BACKUP_KEY || '').trim() || deterministicBackupKey;

  const webhookSecret = (env.WEBHOOK_SECRET || '').trim();
  const botMode = (env.BOT_MODE || 'poll').trim().toLowerCase();
  const botUsername = (env.BOT_USERNAME || '').trim().replace(/^@/, '') || 'JozvehLabBot';

  return Object.freeze({
    isProd,
    nodeEnv: env.NODE_ENV || 'development',
    port,
    botToken,
    botUsername,
    adminChatId: String((env.ADMIN_CHAT_ID || '').trim()),
    webappUrl: (env.WEBAPP_URL || '').trim().replace(/\/+$/, ''),
    stateDbPath,
    initDataMaxAgeSec: maxAgeSec,
    initDataMoneyMaxAgeSec: moneyMaxAgeSec,
    geminiKeys,
    geminiModel,
    merchantId,
    onlineGatewayEnabled,
    paymentCallbackBase: (env.PAYMENT_CALLBACK_BASE || '').trim().replace(/\/+$/, ''),
    zarinpalBase: (env.ZARINPAL_BASE || '').trim().replace(/\/+$/, '') || 'https://api.zarinpal.com',
    allowDemoPayments: (env.ALLOW_DEMO_PAYMENTS || '').trim() === '1' && !isProd,
    backupKey,
    webhookSecret,
    botMode,
    minPayoutToman
  });
}

export const config = loadConfig();
