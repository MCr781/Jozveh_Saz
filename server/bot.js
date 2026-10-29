import './env.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { DB, saveDB, getUserStats, notifyTelegram, recordCourseSale, findCourseFile } from './server.js';
import { isValidSheba } from './sheba.js';
import { generateCoursePackage } from '../factory/generate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// خواندن تنبل متغیرهای محیطی با پاکسازی کامل کاراکترهای \r و فضای خالی
function getBotToken() {
  return process.env.BOT_TOKEN?.trim() || '';
}
function getAdminChatId() {
  return String(process.env.ADMIN_CHAT_ID?.trim() || '');
}
function getWebappUrl() {
  const base = process.env.WEBAPP_URL?.trim() || `http://localhost:${process.env.PORT?.trim() || 3000}`;
  return base.replace(/\/+$/, '');
}
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const REVIEW_REMINDER_DEFAULT_HOUR = 20;
const REVIEW_REMINDER_DEFAULT_TICK_MS = 10 * 60 * 1000;

function getReviewReminderHour() {
  const value = Number(process.env.REVIEW_REMINDER_HOUR || REVIEW_REMINDER_DEFAULT_HOUR);
  if (!Number.isFinite(value)) return REVIEW_REMINDER_DEFAULT_HOUR;
  return Math.max(0, Math.min(23, Math.floor(value)));
}

function getReviewReminderTickMs() {
  const value = Number(process.env.REVIEW_REMINDER_INTERVAL_MS || REVIEW_REMINDER_DEFAULT_TICK_MS);
  if (!Number.isFinite(value)) return REVIEW_REMINDER_DEFAULT_TICK_MS;
  return Math.max(60 * 1000, Math.floor(value));
}

let lastUpdateId = 0;
let isPolling = false;

export async function tgApi(method, bodyObj = {}) {
  const botToken = process.env.BOT_TOKEN?.trim();
  if (!botToken) {
    console.warn(`⚠️ Telegram tgApi('${method}') skipped: BOT_TOKEN is empty.`);
    return { ok: false, description: 'BOT_TOKEN is empty' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || (data && !data.ok)) {
      console.error(`❌ Telegram tgApi('${method}') failed (${res.status}):`, data || res.statusText);
      return data || { ok: false, error_code: res.status, description: res.statusText };
    }
    return data;
  } catch (err) {
    console.error(`❌ Telegram tgApi('${method}') network error:`, err.message || err);
    return { ok: false, description: err.message };
  }
}

async function downloadTelegramFile(fileId, destPath) {
  const botToken = process.env.BOT_TOKEN?.trim() || getBotToken();
  const info = await tgApi('getFile', { file_id: fileId });
  if (!info.ok || !info.result?.file_path) {
    throw new Error('دریافت آدرس فایل از تلگرام ناموفق بود.');
  }
  const filePath = info.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
  if (!fileRes.ok) {
    throw new Error(`دانلود فایل از تلگرام با خطا مواجه شد (${fileRes.status})`);
  }
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

// ===========================================================================
// مرور لایتنر: استخراج دروس دارای کارت ضعیف + ساخت پیام یادآور + زمان‌بند شبانه
// ===========================================================================

// ساعت و تاریخ محلی تهران (با پشتیبانی از سرورهایی که Timezone آن‌ها UTC است)
export function getTehranClock(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false
    }).formatToParts(date);
    const map = {};
    for (const part of parts) {
      if (part.type !== 'literal') map[part.type] = part.value;
    }
    return {
      day: `${map.year}-${map.month}-${map.day}`,
      hour: Number(map.hour) % 24
    };
  } catch (_) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return { day: `${y}-${m}-${d}`, hour: date.getHours() };
  }
}

// دروس دارای کارت نیازمند مرور برای یک دانشجو
export function getPendingReviewCourses(userId) {
  const progress = (DB.userStudyProgress || {})[String(userId)];
  if (!progress) return [];

  const records = [];
  const perCourse = progress.courses && typeof progress.courses === 'object' ? progress.courses : {};

  for (const [key, rec] of Object.entries(perCourse)) {
    const reviewCount = Math.max(0, Number(rec?.reviewCount) || 0);
    if (!reviewCount) continue;

    const found = findCourseFile(rec?.slug || rec?.courseId || key);
    records.push({
      courseId: found?.data?.id || rec?.courseId || key,
      slug: found?.slug || rec?.slug || key,
      title: found?.data?.title || rec?.courseTitle || 'جزوه شب امتحان',
      reviewCount,
      totalCards: Math.max(0, Number(rec?.totalCards) || 0),
      lastSyncAt: Number(rec?.lastSyncAt) || 0
    });
  }

  // پشتیبانی از رکوردهای قدیمی که فقط شمارش کلی داشتند
  if (!records.length && Number(progress.reviewCount) > 0) {
    const found = findCourseFile('sample_course');
    records.push({
      courseId: found?.data?.id || 'sample_course',
      slug: found?.slug || 'sample_course',
      title: found?.data?.title || 'جزوه شب امتحان',
      reviewCount: Math.max(0, Number(progress.reviewCount) || 0),
      totalCards: Math.max(0, Number(progress.totalCards) || 0),
      lastSyncAt: Number(progress.lastSyncAt) || 0
    });
  }

  return records.sort((a, b) => b.reviewCount - a.reviewCount);
}

// متن و دکمه‌های شیشه‌ای یادآور مرور (مشترک بین دستور /review و زمان‌بند شبانه)
export function buildReviewReminder(userId, courses, { manual = false } = {}) {
  const base = process.env.WEBAPP_URL?.trim()?.replace(/\/+$/, '') || getWebappUrl();
  const topCourses = courses.slice(0, 3);
  const totalPending = courses.reduce((sum, c) => sum + c.reviewCount, 0);

  const lines = [];
  lines.push(manual ? '🔄 <b>وضعیت مرور لایتنر شما</b>' : '⏰ <b>یادآور شب امتحان: کارت‌های نیازمند مرور</b>');
  lines.push('');
  lines.push(
    manual
      ? 'این کارت‌ها در صف مرور تو هستند و هنوز به خانهٔ آخر لایتنر نرسیده‌اند:'
      : 'طبق آخرین همگام‌سازی، این کارت‌ها هنوز در صف مرور تو هستند:'
  );
  lines.push('');

  for (const c of topCourses) {
    const totalPart = c.totalCards ? ` از ${c.totalCards}` : '';
    lines.push(`📚 <b>${escapeHtml(c.title)}</b>`);
    lines.push(`   🔄 ${c.reviewCount}${totalPart} کارت نیازمند مرور`);
  }
  if (courses.length > topCourses.length) {
    lines.push(`➕ و ${courses.length - topCourses.length} درس دیگر...`);
  }

  lines.push('');
  lines.push('💡 روش لایتنر: کارت را ببین؛ اگر یادت نبود «🔄 مرور مجدد» و بعد از تسلط «✅ بلدم» را بزن.');
  lines.push('');
  lines.push('👇 همین حالا کارت‌های ضعیف را مرور کن:');

  const keyboard = topCourses.map((c) => {
    const shortTitle = c.title.length > 26 ? `${c.title.slice(0, 26)}…` : c.title;
    return [{
      text: `🔄 مرور ${shortTitle}`,
      web_app: { url: `${base}/?course=${encodeURIComponent(c.slug)}&review=1` }
    }];
  });
  keyboard.push([{ text: '📚 کاتالوگ جزوات', web_app: { url: `${base}/` } }]);

  return { text: lines.join('\n'), keyboard, totalPending };
}

// ارسال یادآور به همه دانشجویانی که کارت مرورنشده دارند (هر کاربر حداکثر یک بار در شب)
export async function sendReviewReminders({ force = false, now = new Date() } = {}) {
  if (!getBotToken()) {
    return { ok: false, reason: 'no_bot_token', sent: 0 };
  }

  const { day, hour } = getTehranClock(now);
  if (!force && hour < getReviewReminderHour()) {
    return { ok: true, skipped: 'before_window', sent: 0, day, hour };
  }

  const userIds = Object.keys(DB.userStudyProgress || {});
  let sent = 0;

  for (const userId of userIds) {
    const progress = DB.userStudyProgress[userId];
    if (!progress || typeof progress !== 'object' || Array.isArray(progress)) continue;
    if (!force && progress.lastReminderDate === day) continue;

    const courses = getPendingReviewCourses(userId);
    if (!courses.length) continue;

    const payload = buildReviewReminder(userId, courses, { manual: false });
    await notifyTelegram(userId, payload.text, payload.keyboard);

    progress.lastReminderDate = day;
    progress.lastReminderAt = Date.now();
    sent++;

    // فاصله کوچک برای احترام به محدودیت نرخ ارسال تلگرام
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  if (sent > 0) saveDB();
  return { ok: true, sent, day, hour, candidates: userIds.length };
}

let reviewReminderTimer = null;

export function startReviewReminderScheduler() {
  if (reviewReminderTimer) return reviewReminderTimer;

  const tick = () => {
    sendReviewReminders().catch((err) => {
      console.warn('⚠️ خطای زمان‌بند یادآور مرور لایتنر:', err?.message || err);
    });
  };

  const initialTimer = setTimeout(tick, 10 * 1000);
  if (typeof initialTimer.unref === 'function') initialTimer.unref();

  reviewReminderTimer = setInterval(tick, getReviewReminderTickMs());
  if (typeof reviewReminderTimer.unref === 'function') reviewReminderTimer.unref();

  console.log(`⏰ زمان‌بند یادآور مرور لایتنر فعال شد (هر شب از ساعت ${getReviewReminderHour()} به وقت تهران).`);
  return reviewReminderTimer;
}


async function handleUpdate(update) {
  const webappUrl = process.env.WEBAPP_URL?.trim()?.replace(/\/+$/, '') || getWebappUrl();
  const adminChatId = process.env.ADMIN_CHAT_ID?.trim() || getAdminChatId();

  // ۱. مدیریت دکمه‌های شیشه‌ای ادمین (تایید خطا + تایید پرداخت کارت‌به‌کارت با واریز سهم ۷۰٪)
  if (update.callback_query) {
    const cb = update.callback_query;
    const fromId = String(cb.from.id);
    const data = cb.data || '';

    // دکمه عمومی «مرور کارت‌های ضعیف» برای همه دانشجویان
    if (data === 'cmd_review') {
      const pendingCourses = getPendingReviewCourses(fromId);
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '🔄 در حال آماده‌سازی کارت‌های مرور...' });

      if (!pendingCourses.length) {
        await notifyTelegram(
          fromId,
          '✅ <b>در حال حاضر هیچ کارتی در صف مرور نداری!</b>\n\n' +
          'در تب «فلش‌کارت» هر کارتی را که با دکمهٔ «🔄 مرور مجدد در شب امتحان» علامت بزنی، همین‌جا ثبت می‌شود.',
          [[{ text: '🗂️ ورود به فلش‌کارت‌ها', web_app: { url: `${webappUrl}/` } }]]
        );
        return;
      }

      const reminder = buildReviewReminder(fromId, pendingCourses, { manual: true });
      await notifyTelegram(fromId, reminder.text, reminder.keyboard);
      return;
    }

    if (fromId !== adminChatId) return;

    // الف) تایید گزارش خطای علمی و ارتقای حافظه مدل
    if (data.startsWith('approve_rep_')) {
      const reportId = data.replace('approve_', '');
      const rep = DB.pendingReports[reportId];
      if (!rep || rep.status !== 'pending_admin') return;

      rep.status = 'approved';
      delete DB.reportedItemsLock[`${rep.courseId}_${rep.itemId}`];

      // اضافه کردن قانون جدید به حافظه learned_rules.json تا مدل دیگر تکرار نکند
      const rulesPath = path.join(__dirname, '../factory/learned_rules.json');
      try {
        const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
        if (rep.learnedRule && !rules.includes(rep.learnedRule)) {
          rules.push(rep.learnedRule);
          fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf8');
        }
      } catch (_) {}

      // اهدای ۲ سهمیه رایگان به دانشجوی گزارش‌دهنده
      const st = getUserStats(rep.userId);
      st.bonusQuota = (st.bonusQuota || 0) + 2;
      saveDB();

      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ قانون به حافظه اضافه شد و جایزه ارسال گردید!' });
      await notifyTelegram(rep.userId, '🎉 <b>گزارش خطای علمی شما تایید شد!</b>\nبه پاس دقت علمی شما، <b>۲ سهمیه پرسش رایگان از هوش مصنوعی</b> به حساب شما اضافه گردید.');
    }

    // ب) رد کردن گزارش اسپم و ثبت امتیاز منفی برای کاربر
    if (data.startsWith('reject_rep_')) {
      const reportId = data.replace('reject_', '');
      const rep = DB.pendingReports[reportId];
      if (!rep) return;

      rep.status = 'rejected';
      delete DB.reportedItemsLock[`${rep.courseId}_${rep.itemId}`];

      const st = getUserStats(rep.userId);
      st.rejectedStrikes = (st.rejectedStrikes || 0) + 1;
      saveDB();

      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '🚫 گزارش رد شد و ۱ اخطار اسپم ثبت گردید.' });
    }

    // ج) تایید تک‌کلیکی رسید کارت‌به‌کارت دانشجو و واریز ۷۰٪ سهم جزوه‌نویس
    if (data.startsWith('unlock|') || data.startsWith('unlock_')) {
      let targetUserId, courseId, receiptId = null;
      if (data.startsWith('unlock|')) {
        receiptId = data.slice('unlock|'.length);
        const receipt = (DB.receipts || {})[receiptId];
        if (!receipt || receipt.status !== 'pending') {
          await tgApi('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: '⚠️ این رسید قبلاً بررسی شده یا نامعتبر است.'
          });
          return;
        }
        // اعتبارسنجی و قفل حالت قبل از هرگونه await ناهمگام
        receipt.status = 'approved';
        receipt.approvedAt = Date.now();
        saveDB();
        targetUserId = receipt.userId;
        courseId = receipt.courseId;
      } else {
        const parts = data.split('|');
        targetUserId = parts[1];
        courseId = parts[2];
      }

      const finalCourseId = courseId || 'sample_course';
      const saleResult = await recordCourseSale(targetUserId, finalCourseId);

      await tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: `🔓 پکیج باز شد و ${(saleResult.creatorShareToman || 0).toLocaleString('fa-IR')} ت به حساب جزوه‌نویس منظور گردید!`
      });

      await notifyTelegram(
        targetUserId,
        '✅ <b>پرداخت شما تایید شد و قفل کامل پکیج باز گردید!</b>\nهم‌اکنون می‌توانید وارد جزوه زنده شوید و به تمام فلش‌کارت‌ها، سوالات پایانترم و ۱۰۰ پرسش هوش مصنوعی دسترسی داشته باشید.',
        [[{ text: '🚀 ورود به نسخه کامل جزوه زنده', web_app: { url: `${webappUrl}/?course=${finalCourseId}` } }]]
      );
    }

    // د) تایید تسویه حساب جزوه‌نویس (پرداخت سهم ۷۰٪)
    if (data.startsWith('approve_payout_')) {
      const payoutId = data.replace('approve_payout_', '');
      const pr = (DB.payoutRequests || {})[payoutId];
      if (!pr || pr.status !== 'pending') {
        await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '⚠️ این تسویه قبلاً بررسی شده است.' });
        return;
      }
      // اعتبارسنجی و قفل حالت قبل از هرگونه await ناهمگام
      pr.status = 'approved';
      pr.approvedAt = Date.now();
      const stats = DB.creatorEarnings[pr.creatorId];
      if (stats) {
        stats.heldToman = Math.max(0, (stats.heldToman || 0) - pr.amount);
        stats.history = stats.history || [];
        stats.history.push({ type: 'payout', amount: pr.amount, at: Date.now(), status: 'paid' });
      }
      saveDB();
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ تسویه تایید و ثبت شد.' });
      await notifyTelegram(pr.creatorId, `✅ <b>تسویه حساب شما تایید شد!</b>\nمبلغ ${pr.amount.toLocaleString('fa-IR')} تومان به شماره شبا ${pr.sheba} واریز گردید.`);
    }

    if (data.startsWith('reject_payout_')) {
      const payoutId = data.replace('reject_payout_', '');
      const pr = (DB.payoutRequests || {})[payoutId];
      if (!pr || pr.status !== 'pending') {
        await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '⚠️ این تسویه قبلاً بررسی شده است.' });
        return;
      }
      // اعتبارسنجی و قفل حالت قبل از هرگونه await ناهمگام
      pr.status = 'rejected';
      pr.rejectedAt = Date.now();
      const stats = DB.creatorEarnings[pr.creatorId];
      if (stats) {
        // آزادسازی مبلغ مسدود شده و بازگشت به موجودی
        stats.balanceToman = (stats.balanceToman || 0) + pr.amount;
        stats.heldToman = Math.max(0, (stats.heldToman || 0) - pr.amount);
        stats.history = stats.history || [];
        stats.history.push({ type: 'payout_rejected', amount: pr.amount, at: Date.now(), status: 'rejected' });
      }
      saveDB();
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: '🚫 تسویه رد شد و موجودی بازگشت داده شد.' });
      await notifyTelegram(pr.creatorId, '🚫 <b>درخواست تسویه شما رد شد.</b> مبلغ درخواستی به موجودی شما بازگردانده شد. لطفاً با پشتیبانی تماس بگیرید.');
    }


    return;
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);

  if (msg.text !== undefined && msg.text !== null) {
    console.log(`📩 Received from ${chatId}: ${msg.text}`);
  }

  // ۲. دستور /start برای دانشجویان
  if (msg.text && msg.text.startsWith('/start')) {
    await notifyTelegram(
      chatId,
      '👋 <b>به «جزوه زنده» خوش آمدید!</b>\n\n' +
      '📑 فرمول‌نامه استاندارد با رندر ریاضی\n' +
      '🗂️ فلش‌کارت‌های سه‌بعدی لایتنر شب امتحان\n' +
      '📝 شبیه‌ساز سوالات امتحانی استاد با پاسخ تشریحی\n' +
      '⚡ دستیار هوش مصنوعی حل سوال (بدون نیاز به فیلترشکن)\n' +
      '💰 امکان کسب درآمد ۷۰٪ از فروش جزوه دست‌نویس خودتان\n' +
      '🔄 مرور کارت‌های ضعیف لایتنر با دستور /review\n\n' +
      '👇 برای شروع روی دکمه زیر بزنید یا اگر رسید کارت‌به‌کارت دارید، عکس آن را همین‌جا بفرستید:',
      [
        [{ text: '🎓 ورود به جزوه زنده (کاتالوگ دروس)', web_app: { url: `${webappUrl}/` } }],
        [{ text: '🔄 مرور کارت‌های ضعیف (/review)', callback_data: 'cmd_review' }],
        [{ text: '💰 داشبورد درآمد جزوه‌نویس (/income)', callback_data: 'cmd_income' }]
      ]
    );
    return;
  }

  // ۳. دستور /income برای مشاهده درآمد و تسویه حساب جزوه‌نویسان
  if (msg.text && (msg.text.startsWith('/income') || msg.text === 'درآمد')) {
    const stats = DB.creatorEarnings[chatId] || { balanceToman: 0, salesCount: 0, history: [] };
    const balanceStr = (stats.balanceToman || 0).toLocaleString('fa-IR');
    const salesStr = (stats.salesCount || 0).toLocaleString('fa-IR');

    await notifyTelegram(
      chatId,
      `💰 <b>داشبورد درآمد جزوه‌نویس (سهم ۷۰٪)</b>\n\n` +
      `👤 شناسه شما: <code>${chatId}</code>\n` +
      `📊 تعداد کل فروش: <b>${salesStr} پکیج</b>\n` +
      `💵 موجودی قابل تسویه: <b>${balanceStr} تومان</b>\n\n` +
      `💡 <i>تسویه حساب‌ها هر پنج‌شنبه به شماره شبای ثبت‌شده شما واریز می‌شود. برای ثبت جزوه جدید، فایل PDF خود را همین‌جا ارسال کنید.</i>`,
      [[{ text: '📚 باز کردن کاتالوگ جزوات', web_app: { url: `${webappUrl}/` } }]]
    );
    return;
  }

  // ۳.۱ دستور /review برای مرور کارت‌های ضعیف لایتنر
  if (msg.text && (msg.text.startsWith('/review') || msg.text === 'مرور')) {
    const pendingCourses = getPendingReviewCourses(chatId);

    if (!pendingCourses.length) {
      await notifyTelegram(
        chatId,
        '✅ <b>در حال حاضر هیچ کارتی در صف مرور نداری!</b>\n\n' +
        'هر کارتی را که در تب «فلش‌کارت» با دکمهٔ «🔄 مرور مجدد در شب امتحان» علامت بزنی، همین‌جا ثبت می‌شود و قبل از امتحان یادآوری می‌گیری.',
        [[{ text: '🗂️ ورود به فلش‌کارت‌ها', web_app: { url: `${webappUrl}/` } }]]
      );
      return;
    }

    const reminder = buildReviewReminder(chatId, pendingCourses, { manual: true });
    await notifyTelegram(chatId, reminder.text, reminder.keyboard);
    return;
  }

  // ۳.۲ دستور /payout برای ثبت شبا و درخواست تسویه حساب جزوه‌نویسان
  if (msg.text && msg.text.startsWith('/payout')) {
    const parts = msg.text.trim().split(/\s+/);
    const stats = DB.creatorEarnings[chatId] || { balanceToman: 0, heldToman: 0, salesCount: 0, history: [] };
    const balance = Number(stats.balanceToman || 0);

    if (parts.length >= 2) {
      const sheba = parts[1].trim().toUpperCase();
      if (!isValidSheba(sheba)) {
        await notifyTelegram(chatId, '❌ <b>شماره شبا نامعتبر است.</b>\nفرمت صحیح: IR به همراه ۲۴ رقم با رقم کنترل معتبر (ISO 13616 mod-97).');
        return;
      }

      // رد درخواست در صورت وجود درخواست قبلی در انتظار بررسی
      const hasPending = Object.values(DB.payoutRequests || {}).some(
        (p) => String(p.creatorId) === chatId && p.status === 'pending'
      );
      if (hasPending) {
        await notifyTelegram(chatId, '⚠️ <b>شما یک درخواست تسویه در صف بررسی دارید.</b>\nلطفاً تا تعیین تکلیف درخواست قبلی صبور باشید.');
        return;
      }

      DB.creatorSheba = DB.creatorSheba || {};
      DB.creatorSheba[chatId] = sheba;

      if (balance <= 0) {
        await notifyTelegram(chatId, `🏦 شماره شبا <code>${sheba}</code> ثبت شد.\nموجودی قابل تسویه شما در حال حاضر ۰ تومان است.`);
        saveDB();
        return;
      }

      // مسدودسازی آنی موجودی جهت جلوگیری از سوءاستفاده درخواست‌های همزمان
      stats.balanceToman = 0;
      stats.heldToman = (stats.heldToman || 0) + balance;

      DB.payoutRequests = DB.payoutRequests || {};
      const payoutId = `payout_${crypto.randomUUID()}`;
      DB.payoutRequests[payoutId] = {
        payoutId,
        creatorId: chatId,
        sheba,
        amount: balance,
        status: 'pending',
        createdAt: Date.now()
      };
      saveDB();

      if (adminChatId) {
        await notifyTelegram(adminChatId, `💸 <b>درخواست تسویه جزوه‌نویس</b>\n👤 <code>${chatId}</code>\n🏦 <code>${sheba}</code>\n💰 ${balance.toLocaleString('fa-IR')} تومان`, [[
          { text: '✅ تایید تسویه', callback_data: `approve_payout_${payoutId}` },
          { text: '🚫 رد', callback_data: `reject_payout_${payoutId}` }
        ]]);
      }

      await notifyTelegram(chatId, `✅ شماره شبا <code>${sheba}</code> ثبت شد و درخواست تسویه ${balance.toLocaleString('fa-IR')} تومان برای ادمین ارسال گردید.`);
      return;
    }

    const savedSheba = (DB.creatorSheba || {})[chatId] || 'ثبت نشده';
    await notifyTelegram(
      chatId,
      `🏦 <b>تسویه حساب جزوه‌نویس</b>\n\n` +
      `💵 موجودی قابل تسویه: <b>${balance.toLocaleString('fa-IR')} تومان</b>\n` +
      `💳 شبا ثبت‌شده: <code>${savedSheba}</code>\n\n` +
      `برای ثبت شبا و درخواست تسویه، دستور زیر را ارسال کنید:\n` +
      `<code>/payout IR123456789012345678901234</code>`
    );
    return;
  }

  // ۳.۳ دستور /pay برای انتخاب درس قبل از واریز کارت‌به‌کارت
  if (msg.text && msg.text.startsWith('/pay')) {
    const parts = msg.text.trim().split(/\s+/);
    if (parts.length >= 2) {
      const slug = parts[1].trim();
      const found = findCourseFile(slug);
      const courseId = found?.data?.id || found?.slug || slug;
      const courseTitle = found?.data?.title || courseId;
      const price = found?.data?.price_toman || 59000;
      DB.userPendingCourseSelection = DB.userPendingCourseSelection || {};
      DB.userPendingCourseSelection[chatId] = courseId;
      saveDB();

      await notifyTelegram(
        chatId,
        `📚 درس <b>${escapeHtml(courseTitle)}</b> انتخاب شد.\n\n` +
        `💰 مبلغ پکیج: <b>${price.toLocaleString('fa-IR')} تومان</b>\n` +
        `لطفاً مبلغ را کارت‌به‌کارت کرده و عکس فیش واریز را همین‌جا ارسال نمایید تا قفل درس بلافاصله باز شود.`
      );
      return;
    } else {
      await notifyTelegram(
        chatId,
        '💡 برای خرید کارت‌به‌کارت درس، لطفاً شناسه درس را وارد کنید:\n' +
        '<code>/pay eng_math_01</code> یا <code>/pay sample_course</code>\n\n' +
        'یا مستقیماً از داخل مینی‌اپ روی «پرداخت آنلاین» یا «کارت به کارت» بزنید.'
      );
      return;
    }
  }

  // ۴. اگر ادمین فایل PDF جزوه بفرستد <- تبدیل خودکار به پکیج جزوه زنده!
  if (chatId === adminChatId && msg.document) {
    const uploadsDir = path.join(__dirname, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const localInput = path.join(uploadsDir, msg.document.file_name || `note_${Date.now()}.pdf`);
    const courseSlug = `course_${Date.now()}`;
    const outputJsonPath = path.join(__dirname, '../public/data', `${courseSlug}.json`);

    await notifyTelegram(chatId, '⏳ فایل جزوه دریافت شد! در حال ارسال به کارخانه Gemini 2.5 Flash و تست کامپایلر فرمول‌های KaTeX...');

    try {
      await downloadTelegramFile(msg.document.file_id, localInput);
      await generateCoursePackage({
        courseId: courseSlug,
        title: msg.caption || 'پکیج هوشمند شب امتحان',
        instructor: 'منطبق بر جزوه کلاسی استاد',
        creator: 'تولید شده با کارخانه جزوه زنده',
        inputFiles: [localInput],
        outputPath: outputJsonPath
      });

      await notifyTelegram(
        chatId,
        `✅ <b>پکیج جزوه زنده بدون دخالت دست ساخته شد!</b>\n🆔 شناسه: <code>${courseSlug}</code>`,
        [[{ text: '👁️ مشاهده جزوه زنده جدید', web_app: { url: `${webappUrl}/?course=${courseSlug}` } }]]
      );
    } catch (err) {
      await notifyTelegram(chatId, `❌ خطا در ساخت خودکار جزوه: ${err.message}`);
    }
    return;
  }

  // ۵. اگر دانشجو عکس رسید کارت‌به‌کارت بفرستد <- ثبت سرور رسید با UUID و ارسال برای ادمین با تایید تک‌کلیکی
  if (msg.photo && chatId !== adminChatId) {
    const bestPhoto = msg.photo[msg.photo.length - 1].file_id;
    const receiptId = crypto.randomUUID();
    const selectedCourseId = (DB.userPendingCourseSelection || {})[chatId] || 'sample_course';
    const found = findCourseFile(selectedCourseId);
    const courseTitle = found?.data?.title || selectedCourseId;

    DB.receipts = DB.receipts || {};
    DB.receipts[receiptId] = {
      receiptId,
      userId: chatId,
      courseId: selectedCourseId,
      status: 'pending',
      createdAt: Date.now()
    };
    saveDB();

    await tgApi('sendPhoto', {
      chat_id: adminChatId,
      photo: bestPhoto,
      caption: `💳 <b>رسید کارت‌به‌کارت جدید</b>\n👤 دانشجو: <code>${chatId}</code> (@${msg.from.username || 'بدون_نام_کاربری'})\n📚 درس: <b>${escapeHtml(courseTitle)}</b>\n🆔 شناسه رسید: <code>${receiptId}</code>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ تایید و باز کردن قفل آنی', callback_data: `unlock|${receiptId}` }
        ]]
      }
    });
    await notifyTelegram(chatId, `⏳ تصویر رسید شما برای درس «${escapeHtml(courseTitle)}» دریافت شد و برای تایید ارسال گردید. ظرف چند لحظه قفل پکیج برای شما باز می‌شود.`);
  }
}

export async function startTelegramBotPolling() {
  const botToken = process.env.BOT_TOKEN?.trim() || getBotToken();
  if (!botToken) {
    console.log('ℹ️ متغیر BOT_TOKEN تنظیم نشده است؛ ربات تلگرام در حالت آماده به کار (خاموش) قرار دارد.');
    return;
  }
  if (isPolling) return;

  const me = await tgApi('getMe', {});
  if (me && me.ok && me.result?.username) {
    console.log(`✅ Connected to Telegram Bot: @${me.result.username}`);
  } else {
    console.error(`❌ Failed to connect to Telegram Bot: error_code: ${me?.error_code || 'N/A'}, description: ${me?.description || 'Unknown error'}`);
    return;
  }

  isPolling = true;
  console.log('🤖 ربات تلگرام جزوه زنده (Long-Polling) فعال شد!');
  startReviewReminderScheduler();

  while (isPolling) {
    try {
      const data = await tgApi('getUpdates', { offset: lastUpdateId + 1, timeout: 25 });
      if (data && data.ok && Array.isArray(data.result)) {
        for (const upd of data.result) {
          lastUpdateId = upd.update_id;
          await handleUpdate(upd);
        }
      } else if (!data || !data.ok) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (err) {
      console.error('❌ Error in telegram polling loop:', err.message || err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
