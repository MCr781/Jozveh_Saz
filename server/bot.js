import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DB, saveDB, getUserStats, notifyTelegram, recordCourseSale } from './server.js';
import { generateCoursePackage } from '../factory/generate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || '');
const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:3000';

let lastUpdateId = 0;
let isPolling = false;

async function tgApi(method, bodyObj) {
  if (!BOT_TOKEN) return { ok: false };
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj)
  });
  return res.json();
}

async function downloadTelegramFile(fileId, destPath) {
  const info = await tgApi('getFile', { file_id: fileId });
  if (!info.ok || !info.result?.file_path) {
    throw new Error('دریافت آدرس فایل از تلگرام ناموفق بود.');
  }
  const filePath = info.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

async function handleUpdate(update) {
  // ۱. مدیریت دکمه‌های شیشه‌ای ادمین (تایید خطا + تایید پرداخت کارت‌به‌کارت با واریز سهم ۷۰٪)
  if (update.callback_query) {
    const cb = update.callback_query;
    const fromId = String(cb.from.id);
    const data = cb.data || '';

    if (fromId !== ADMIN_CHAT_ID) return;

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
    if (data.startsWith('unlock_')) {
      const [, targetUserId, courseId] = data.split('|');
      const finalCourseId = courseId || 'sample_course';
      const saleResult = await recordCourseSale(targetUserId, finalCourseId);

      await tgApi('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: `🔓 پکیج باز شد و ${(saleResult.creatorShareToman || 0).toLocaleString('fa-IR')} ت به حساب جزوه‌نویس منظور گردید!`
      });

      await notifyTelegram(
        targetUserId,
        '✅ <b>پرداخت شما تایید شد و قفل کامل پکیج باز گردید!</b>\nهم‌اکنون می‌توانید وارد جزوه زنده شوید و به تمام فلش‌کارت‌ها، سوالات پایانترم و ۱۰۰ پرسش هوش مصنوعی دسترسی داشته باشید.',
        [[{ text: '🚀 ورود به نسخه کامل جزوه زنده', web_app: { url: `${WEBAPP_URL}/?course=${finalCourseId}` } }]]
      );
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);

  // ۲. دستور /start برای دانشجویان
  if (msg.text && msg.text.startsWith('/start')) {
    await notifyTelegram(
      chatId,
      '👋 <b>به «جزوه زنده» خوش آمدید!</b>\n\n' +
      '📑 فرمول‌نامه استاندارد با رندر ریاضی\n' +
      '🗂️ فلش‌کارت‌های سه‌بعدی لایتنر شب امتحان\n' +
      '📝 شبیه‌ساز سوالات امتحانی استاد با پاسخ تشریحی\n' +
      '⚡ دستیار هوش مصنوعی حل سوال (بدون نیاز به فیلترشکن)\n' +
      '💰 امکان کسب درآمد ۷۰٪ از فروش جزوه دست‌نویس خودتان\n\n' +
      '👇 برای شروع روی دکمه زیر بزنید یا اگر رسید کارت‌به‌کارت دارید، عکس آن را همین‌جا بفرستید:',
      [
        [{ text: '🎓 ورود به جزوه زنده (کاتالوگ دروس)', web_app: { url: `${WEBAPP_URL}/` } }],
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
      [[{ text: '📚 باز کردن کاتالوگ جزوات', web_app: { url: `${WEBAPP_URL}/` } }]]
    );
    return;
  }

  // ۴. اگر ادمین فایل PDF جزوه بفرستد <- تبدیل خودکار به پکیج جزوه زنده!
  if (chatId === ADMIN_CHAT_ID && msg.document) {
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
        [[{ text: '👁️ مشاهده جزوه زنده جدید', web_app: { url: `${WEBAPP_URL}/?course=${courseSlug}` } }]]
      );
    } catch (err) {
      await notifyTelegram(chatId, `❌ خطا در ساخت خودکار جزوه: ${err.message}`);
    }
    return;
  }

  // ۵. اگر دانشجو عکس رسید کارت‌به‌کارت بفرستد <- ارسال برای ادمین با دکمه تایید ۱ کلیکی
  if (msg.photo && chatId !== ADMIN_CHAT_ID) {
    const bestPhoto = msg.photo[msg.photo.length - 1].file_id;
    await tgApi('sendPhoto', {
      chat_id: ADMIN_CHAT_ID,
      photo: bestPhoto,
      caption: `💳 <b>رسید کارت‌به‌کارت جدید</b>\n👤 دانشجو: <code>${chatId}</code> (@${msg.from.username || 'بدون_نام_کاربری'})`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ تایید و باز کردن قفل آنی', callback_data: `unlock_|${chatId}|sample_course` }
        ]]
      }
    });
    await notifyTelegram(chatId, '⏳ تصویر رسید شما دریافت شد و برای تایید فوری ارسال گردید. ظرف چند لحظه قفل پکیج برای شما باز می‌شود.');
  }
}

export async function startTelegramBotPolling() {
  if (!BOT_TOKEN) {
    console.log('ℹ️ متغیر BOT_TOKEN تنظیم نشده است؛ ربات تلگرام در حالت آماده به کار (خاموش) قرار دارد.');
    return;
  }
  if (isPolling) return;
  isPolling = true;

  console.log('🤖 ربات تلگرام جزوه زنده (Long-Polling) فعال شد!');
  while (isPolling) {
    try {
      const data = await tgApi('getUpdates', { offset: lastUpdateId + 1, timeout: 25 });
      if (data.ok && Array.isArray(data.result)) {
        for (const upd of data.result) {
          lastUpdateId = upd.update_id;
          await handleUpdate(upd);
        }
      }
    } catch (_) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
