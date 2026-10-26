import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY_1 || '',
  process.env.GEMINI_API_KEY_2 || ''
].filter(Boolean);

let keyIdx = 0;
function getAI() {
  if (!GEMINI_KEYS.length) return null;
  const apiKey = GEMINI_KEYS[keyIdx % GEMINI_KEYS.length];
  keyIdx++;
  return new GoogleGenAI({ apiKey });
}

// بانک حافظه وضعیت کاربران، ضداسپم و گزارش‌های در انتظار تایید
const DB_PATH = path.join(__dirname, 'state_db.json');
let DB = {
  purchases: {},        // { "userId_courseId": true }
  userSpamStats: {},    // { userId: { lastReportAt, dailyCount, dayStamp, rejectedStrikes, bonusQuota } }
  pendingReports: {},   // { reportId: { courseId, itemId, userId, claim, proposedFix, learnedRule, status } }
  reportedItemsLock: {} // { "courseId_itemId": true } -> جلوگیری از گزارش تکراری روی یک کارت
};

if (fs.existsSync(DB_PATH)) {
  try { DB = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (_) {}
}

function saveDB() {
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(DB, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
}

// ۱. اعتبارسنجی رمزنگاری‌شده امضای تلگرام (HMAC-SHA256)
function verifyTelegramInitData(initDataRaw) {
  if (!BOT_TOKEN) return { valid: true, user: { id: 'demo_user_981024', username: 'UT_Student_Demo' } };
  if (!initDataRaw) return { valid: false };

  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get('hash');
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash !== hash) return { valid: false };
    const user = JSON.parse(params.get('user') || '{}');
    return { valid: true, user };
  } catch (_) {
    return { valid: false };
  }
}

// ۲. سپر ضداسپم (Rate-Limiter & Shadow-Ban Check)
function checkSpamShield(userId, itemKey) {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  if (!DB.userSpamStats[userId]) {
    DB.userSpamStats[userId] = { lastReportAt: 0, dailyCount: 0, dayStamp: today, rejectedStrikes: 0, bonusQuota: 0 };
  }
  const st = DB.userSpamStats[userId];

  if (st.dayStamp !== today) {
    st.dayStamp = today;
    st.dailyCount = 0;
  }

  // اگر کاربر ۳ بار گزارش اسپم/غلط فرستاده باشد، شادوبن می‌شود
  if (st.rejectedStrikes >= 3) {
    return { allowed: false, reason: 'حساب شما به دلیل ارسال گزارش‌های نامعتبر مسدود شده است.' };
  }

  // کول‌داون ۲ دقیقه‌ای بین هر گزارش
  if (now - st.lastReportAt < 120 * 1000) {
    const waitSec = Math.ceil((120 * 1000 - (now - st.lastReportAt)) / 1000);
    return { allowed: false, reason: `لطفاً ${waitSec} ثانیه دیگر مجدداً تلاش کنید.` };
  }

  // سقف ۳ گزارش در روز
  if (st.dailyCount >= 3) {
    return { allowed: false, reason: 'سقف گزارش خطای روزانه شما (۳ مورد) تکمیل شده است.' };
  }

  // قفل جلوگیری از گزارش تکراری روی یک کارت مشخص
  if (DB.reportedItemsLock[itemKey]) {
    return { allowed: false, reason: 'برای این کارت قبلاً یک گزارش ثبت شده و در حال بررسی است.' };
  }

  return { allowed: true, stats: st };
}

// ۳. داور هوش مصنوعی (AI Fact-Checker & Verifier)
async function verifyReportWithAIJudge({ originalText, userClaim, sourcePage }) {
  const ai = getAI();
  if (!ai) {
    // حالت دمو بدون کلید API
    return {
      is_valid: true,
      confidence: 95,
      reason: 'تایید آزمایشی در حالت لوکال',
      corrected_text: originalText,
      general_rule_for_memory: `دقت در فرمول‌های صفحه ${sourcePage}`
    };
  }

  const judgeSchema = {
    type: Type.OBJECT,
    properties: {
      is_valid: { type: Type.BOOLEAN, description: 'True ONLY if the user report is scientifically/mathematically accurate and not spam' },
      confidence: { type: Type.INTEGER, description: '0 to 100' },
      reason: { type: Type.STRING },
      corrected_text: { type: Type.STRING, description: 'Corrected Persian text with valid LaTeX if is_valid is true' },
      general_rule_for_memory: { type: Type.STRING, description: 'A concise rule to prevent this OCR/formula mistake in future lectures' }
    },
    required: ['is_valid', 'confidence', 'reason', 'corrected_text', 'general_rule_for_memory']
  };

  const prompt = `
شما داور علمی و ممیز خطاهای پلتفرم آموزشی هستید.
متن فعلی کارت (صفحه ${sourcePage} جزوه):
"""${originalText}"""

ادعای دانشجو درباره خطای این کارت:
"""${userClaim}"""

بررسی کن آیا ادعای دانشجو از نظر علمی، مهندسی یا سینتکس فرمول LaTeX واقعاً درست است یا خیر (اگر اسپم، بی‌ربط یا از نظر علمی غلط است، حتماً is_valid را false بگذار).
`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ text: prompt }],
    config: { responseMimeType: 'application/json', responseSchema: judgeSchema, temperature: 0.1 }
  });

  return JSON.parse(response.text);
}

// ارسال پیام به تلگرام ادمین برای تایید نهایی با ۱ کلیک
async function notifyAdminOnTelegram(text, inlineKeyboard) {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineKeyboard }
      })
    });
  } catch (_) {}
}

// هندلر درخواست‌های HTTP
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // API ثبت گزارش خطای هوشمند با سپر ضداسپم و داور AI
  if (req.method === 'POST' && url.pathname === '/api/report-issue') {
    let body = '';
    req.on('data', (chunk) => { if (body.length < 4096) body += chunk; });
    req.on('end', async () => {
      try {
        const auth = verifyTelegramInitData(req.headers['x-telegram-init-data']);
        if (!auth.valid) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, message: 'خطای احراز هویت تلگرام.' }));
          return;
        }

        const { courseId, itemId, originalText, userClaim, sourcePage } = JSON.parse(body);
        const cleanClaim = String(userClaim || '').trim().slice(0, 200);

        if (cleanClaim.length < 5) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, message: 'توضیح خطا بسیار کوتاه است.' }));
          return;
        }

        const itemKey = `${courseId}_${itemId}`;
        const spamCheck = checkSpamShield(auth.user.id, itemKey);
        if (!spamCheck.allowed) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, message: spamCheck.reason }));
          return;
        }

        // ثبت زمان درخواست برای فعال شدن Cooldown
        spamCheck.stats.lastReportAt = Date.now();
        spamCheck.stats.dailyCount += 1;

        // داوری با هوش مصنوعی
        const verdict = await verifyReportWithAIJudge({ originalText, userClaim: cleanClaim, sourcePage });

        if (!verdict.is_valid || verdict.confidence < 70) {
          spamCheck.stats.rejectedStrikes += 1;
          saveDB();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            message: `داور هوشمند این گزارش را تایید نکرد: ${verdict.reason} (توجه: ارسال گزارش نادرست باعث مسدودی می‌شود).`
          }));
          return;
        }

        // اگر داور هوش مصنوعی تایید کرد، قفل می‌شود و برای تایید ۱ کلیکی ادمین ارسال می‌گردد
        const reportId = `rep_${Date.now()}`;
        DB.reportedItemsLock[itemKey] = true;
        DB.pendingReports[reportId] = {
          courseId,
          itemId,
          userId: auth.user.id,
          claim: cleanClaim,
          proposedFix: verdict.corrected_text,
          learnedRule: verdict.general_rule_for_memory,
          status: 'pending_admin'
        };
        saveDB();

        await notifyAdminOnTelegram(
          `🛠️ <b>گزارش خطای تاییدشده توسط AI (${verdict.confidence}%)</b>\n\n` +
          `👤 کاربر: <code>${auth.user.id}</code>\n` +
          `📍 آیتم: <code>${itemKey}</code> (صفحه ${sourcePage})\n` +
          `💬 گزارش دانشجو: ${cleanClaim}\n\n` +
          `✨ <b>اصلاح پیشنهادی:</b>\n${verdict.corrected_text}\n\n` +
          `🧠 <b>قانون جدید برای حافظه:</b>\n${verdict.general_rule_for_memory}`,
          [[
            { text: '✅ اعمال در جزوه + جایزه', callback_data: `approve_${reportId}` },
            { text: '🚫 رد و جریمه اسپمر', callback_data: `reject_${reportId}` }
          ]]
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          message: '✅ گزارش شما توسط داور هوشمند تایید اولیه شد! پس از اعمال نهایی، ۲ سهمیه پرسش رایگان به حساب شما اضافه می‌شود.'
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: 'خطای داخلی سرور در بررسی گزارش.' }));
      }
    });
    return;
  }

  // سرو کردن فایل‌های استاتیک پوشه public
  let filePath = path.join(__dirname, '../public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2'
  };

  res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`🚀 سرور جزوه زنده و سپر ضداسپم روی پورت http://localhost:${PORT} فعال شد!`);
});