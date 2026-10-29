import './env.js';

function getBotToken() {
  return process.env.BOT_TOKEN?.trim() || '';
}

/**
 * Native Telegram Bot API client using global fetch with AbortSignal.timeout.
 */
export async function tgApi(method, bodyObj = {}, { botToken = null, timeoutMs = 30000 } = {}) {
  const token = (botToken || getBotToken()).trim();
  if (!token) {
    return { ok: false, description: 'BOT_TOKEN is empty' };
  }

  const signal = typeof AbortSignal?.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
      signal
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || (data && !data.ok)) {
      return data || { ok: false, error_code: res.status, description: res.statusText };
    }
    return data;
  } catch (err) {
    return { ok: false, description: err?.message || String(err) };
  }
}

/**
 * Sends HTML notification to a Telegram chat with optional inline keyboard.
 */
export async function notifyTelegram(chatId, text, inlineKeyboard = null, options = {}) {
  if (!chatId) return null;
  const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (inlineKeyboard) payload.reply_markup = { inline_keyboard: inlineKeyboard };
  return tgApi('sendMessage', payload, options);
}
