#!/usr/bin/env node
/**
 * Jezveh_Saz Local Course Generator (Milestone 5)
 * ------------------------------------------------
 * ساخت پکیج جزوه زنده از خط فرمان، بدون نیاز به تلگرام.
 *
 * مثال واقعی:
 *   node factory/cli.js --file ./notes.pdf --id metal_casting_01 \
 *     --title "پکیج شب امتحان انجماد و ریخته‌گری" \
 *     --category "مهندسی مواد و متالورژی" --price 65000
 *
 * تست آفلاین (بدون API Key):
 *   node factory/cli.js --demo --id metal_casting_01
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  generateCoursePackage,
  hasGeminiKeys,
  validateCoursePackage
} from './generate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'public', 'data');

const DEFAULT_TITLE = 'پکیج شب امتحان انجماد و ریخته‌گری';
const DEFAULT_CATEGORY = 'مهندسی مواد و متالورژی';
const DEFAULT_INSTRUCTOR = 'منطبق بر جزوه کلاسی استاد و نمونه سوالات پایان‌ترم';
const DEFAULT_CREATOR = 'کارخانه جزوه زنده (حالت دمو)';
const DEFAULT_PRICE = 65000;

// ---------------------------------------------------------------------------
// ۱. بارگذاری ساده و بدون وابستگی فایل .env
// ---------------------------------------------------------------------------
export function loadEnvFile(envPath = path.join(PROJECT_ROOT, '.env')) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// ۲. پارس آرگومان‌های خط فرمان (پشتیبانی از --key value و --key=value)
// ---------------------------------------------------------------------------
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { files: [], demo: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i]);
    if (!token.startsWith('--')) continue;

    const eqIndex = token.indexOf('=');
    let key;
    let value;

    if (eqIndex !== -1) {
      key = token.slice(2, eqIndex);
      value = token.slice(eqIndex + 1);
    } else {
      key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !String(next).startsWith('--')) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }

    if (key === 'file' || key === 'files') {
      if (value !== true) {
        String(value)
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean)
          .forEach((f) => args.files.push(f));
      }
      continue;
    }

    if (key === 'demo' || key === 'help' || key === 'force') {
      args[key] = value === true || value === 'true' || value === '1' || value === 'yes';
      continue;
    }

    args[key] = value === true ? true : String(value);
  }
  return args;
}

// ---------------------------------------------------------------------------
// ۳. محتوای دموی معتبر و کاملاً آفلاین (همه فرمول‌ها در ادامه با KaTeX تست می‌شوند)
// ---------------------------------------------------------------------------
export function buildDemoCourse({
  id,
  title = DEFAULT_TITLE,
  category = DEFAULT_CATEGORY,
  priceToman = DEFAULT_PRICE,
  instructor = DEFAULT_INSTRUCTOR,
  creator = DEFAULT_CREATOR,
  creatorTelegramId = ''
}) {
  const course = {
    id,
    title,
    instructor,
    creator,
    ...(creatorTelegramId ? { creator_telegram_id: String(creatorTelegramId) } : {}),
    category,
    price_toman: Number(priceToman) || DEFAULT_PRICE,
    ai_quota_free: 3,
    ai_quota_pro: 100,
    summary_cheat_sheet: [
      {
        id: 'mc_sum_1',
        topic: 'هسته‌زایی همگن و شعاع بحرانی هسته',
        key_points: [
          'برای پایدار ماندن یک هستهٔ جامد در مذاب، باید شعاع آن از شعاع بحرانی $r^{*}$ بزرگ‌تر باشد؛ در غیر این صورت انرژی آزاد سطحی بر انرژی آزاد حجمی غلبه می‌کند و هسته دوباره حل می‌شود.',
          'با افزایش زیرسردی ($\\Delta T$)، شعاع بحرانی کوچک‌تر و سرعت هسته‌زایی به‌شدت بیشتر می‌شود؛ به همین دلیل زیرسردی بالا ریزساختار را ریزتر می‌کند.'
        ],
        formula_latex: 'r^{*} = \\frac{2\\gamma_{SL} T_m}{\\Delta H_f \\Delta T}, \\qquad \\Delta G^{*} = \\frac{16\\pi \\gamma_{SL}^{3} T_m^{2}}{3 (\\Delta H_f)^{2} (\\Delta T)^{2}}',
        source_page: 12
      },
      {
        id: 'mc_sum_2',
        topic: 'قانون چورینوف و مدول انجماد',
        key_points: [
          'زمان انجماد با مربع مدول ($M = V/A$) نسبت مستقیم دارد؛ هرچه نسبت سطح به حجم بزرگ‌تر باشد، قطعه سریع‌تر منجمد می‌شود.',
          'برای مقایسهٔ دو قطعه از یک آلیاژ و قالب مشابه، نسبت زمان‌های انجماد برابر مربع نسبت مدول‌هاست.'
        ],
        formula_latex: 't_s = B\\left(\\frac{V}{A}\\right)^{2} = B\\,M^{2}, \\qquad \\frac{t_2}{t_1} = \\left(\\frac{M_2}{M_1}\\right)^{2}',
        source_page: 26
      },
      {
        id: 'mc_sum_3',
        topic: 'طراحی راهگاه (Riser) و انجماد جهت‌دار',
        key_points: [
          'راهگاه باید دیرتر از قطعه منجمد شود تا در مرحلهٔ انقباض، مذاب تغذیه‌کننده در دسترس باشد؛ به همین دلیل مدول راهگاه را حدود ۲۰٪ بزرگ‌تر از مدول قطعه می‌گیرند.',
          'با کارگذاری چیلر در نقاط ضخیم و عایق‌گذاری روی راهگاه، گرادیان دمایی به سمت راهگاه هدایت و انجماد جهت‌دار تضمین می‌شود.'
        ],
        formula_latex: 'M_{r} \\ge 1.2\\,M_{c}, \\qquad t_{r} \\ge 1.25\\,t_{c}',
        source_page: 41
      },
      {
        id: 'mc_sum_4',
        topic: 'عیوب انقباضی و قانون دارسی در تغذیهٔ بین‌شاخه‌ای',
        key_points: [
          'مکش (Shrinkage Porosity) در نقاطی رخ می‌دهد که آخرین مذاب در آن‌جا منجمد می‌شود و راه تغذیه به آن قطع شده است.',
          'نفوذپذیری شبکهٔ دندریتی و ویسکوزیتهٔ مذاب، سرعت تغذیهٔ بین‌شاخه‌ای را کنترل می‌کنند؛ هرچه $K$ بزرگ‌تر و $\\mu$ کوچک‌تر باشد، تغذیه بهتر است.'
        ],
        formula_latex: 'v = -\\frac{K}{\\mu}\\,\\frac{\\partial P}{\\partial x}',
        source_page: 55
      },
      {
        id: 'mc_sum_5',
        topic: 'بازده ریخته‌گری و انقباض حجمی',
        key_points: [
          'انقباض حجمی مذاب هنگام انجماد باید با تغذیهٔ راهگاه جبران شود؛ در فولادها این انقباض حدود ۳ تا ۶ درصد است.',
          'بازده ریخته‌گری از نسبت وزن قطعهٔ سالم به وزن مذاب ریخته‌شده به دست می‌آید و طراحی راهگاه نقش مستقیم در آن دارد.'
        ],
        formula_latex: '\\eta = \\frac{m_{c}}{m_{p}} \\times 100\\%, \\qquad \\Delta V = \\beta V_{0}',
        source_page: 63
      }
    ],
    flashcards: [
      {
        id: 'mc_fc_1',
        is_locked: false,
        front: 'شعاع بحرانی هستهٔ همگن چگونه به دست می‌آید و افزایش زیرسردی چه تأثیری بر آن دارد؟',
        back: 'از موازنهٔ انرژی آزاد سطحی و حجمی: $$r^{*} = \\frac{2\\gamma_{SL}T_m}{\\Delta H_f \\Delta T}$$ با افزایش $\\Delta T$، شعاع بحرانی کوچک می‌شود و هسته‌های ریزتری پایدار می‌مانند.',
        source_page: 12
      },
      {
        id: 'mc_fc_2',
        is_locked: false,
        front: 'طبق قانون چورینوف، اگر مدول یک قطعه دو برابر شود، زمان انجماد چه تغییری می‌کند؟',
        back: 'چون $t_s = B M^{2}$ است، دو برابر شدن مدول زمان انجماد را $2^{2} = 4$ برابر می‌کند (با فرض ثابت بودن $B$).',
        source_page: 26
      },
      {
        id: 'mc_fc_3',
        is_locked: false,
        front: 'چرا مدول راهگاه را بزرگ‌تر از مدول قطعه انتخاب می‌کنند؟',
        back: 'تا راهگاه آخرین بخشی باشد که منجمد می‌شود و بتواند انقباض حجمی قطعه را تغذیه کند. معیار رایج طراحی: $$M_{r} \\ge 1.2\\,M_{c}$$',
        source_page: 41
      },
      {
        id: 'mc_fc_4',
        is_locked: true,
        front: 'تفاوت چیلر و عایق در کنترل جهت انجماد چیست؟',
        back: 'چیلر با ضریب هدایت حرارتی بالا گرمای نقطهٔ ضخیم را سریع می‌گیرد و انجماد را از آن ناحیه شروع می‌کند؛ عایق روی راهگاه باعث می‌شود راهگاه دیرتر منجمد شود. ترکیب این دو، انجماد جهت‌دار به سمت راهگاه ایجاد می‌کند.',
        source_page: 44
      },
      {
        id: 'mc_fc_5',
        is_locked: true,
        front: 'مکش انقباضی و تخلخل گازی چه تفاوتی دارند و هر یک چگونه رفع می‌شوند؟',
        back: 'مکش در نقاط داغ و آخرین نواحی منجمدشده و به دلیل قطع تغذیه رخ می‌دهد و با طراحی درست راهگاه و چیلر رفع می‌شود. تخلخل گازی از انحلال گازهایی مثل هیدروژن در مذاب ناشی می‌شود و با گاززدایی، خشک‌کردن قالب و کنترل رطوبت کاهش می‌یابد.',
        source_page: 57
      },
      {
        id: 'mc_fc_6',
        is_locked: true,
        front: 'رابطهٔ دارسی چه نقشی در تغذیهٔ بین‌شاخه‌ای دارد؟',
        back: 'سرعت جریان مذاب در شبکهٔ دندریتی با نفوذپذیری $K$ نسبت مستقیم و با ویسکوزیتهٔ $\\mu$ نسبت وارونه دارد: $$v = -\\frac{K}{\\mu}\\frac{\\partial P}{\\partial x}$$ هرچه $K$ کمتر باشد، افت فشار بیشتر و احتمال مکش بالاتر است.',
        source_page: 55
      }
    ],
    exam_questions: [
      {
        id: 'mc_q_1',
        is_locked: false,
        question_stem: 'برای انجماد یک فلز با $T_m = 1500\\,\\mathrm{K}$، $\\gamma_{SL} = 0.15\\,\\mathrm{J/m^{2}}$، $\\Delta H_f = 1.8\\times 10^{9}\\,\\mathrm{J/m^{3}}$ و زیرسردی $\\Delta T = 100\\,\\mathrm{K}$، شعاع بحرانی هسته تقریباً چقدر است؟',
        options: ['۲۵ نانومتر', '۲.۵ نانومتر', '۲۵۰ نانومتر', '۰.۲۵ نانومتر'],
        correct_index: 1,
        explanation: 'با جای‌گذاری در رابطهٔ شعاع بحرانی: $$r^{*} = \\frac{2\\gamma_{SL}T_m}{\\Delta H_f \\Delta T} = \\frac{2 \\times 0.15 \\times 1500}{1.8\\times 10^{9} \\times 100} = 2.5\\times 10^{-9}\\,\\mathrm{m}$$ یعنی حدود ۲.۵ نانومتر.',
        source_page: 12
      },
      {
        id: 'mc_q_2',
        is_locked: false,
        question_stem: 'دو ریخته‌گری از یک آلیاژ و قالب یکسان داریم. اگر مدول قطعهٔ دوم دو برابر قطعهٔ اول باشد، زمان انجماد قطعهٔ دوم چه نسبتی با قطعهٔ اول دارد؟',
        options: ['۲ برابر', '۴ برابر', '۸ برابر', 'نصف'],
        correct_index: 1,
        explanation: 'طبق قانون چورینوف $t_s = B M^{2}$؛ بنابراین: $$\\frac{t_2}{t_1} = \\left(\\frac{M_2}{M_1}\\right)^{2} = 2^{2} = 4$$ زمان انجماد چهار برابر می‌شود.',
        source_page: 26
      },
      {
        id: 'mc_q_3',
        is_locked: true,
        question_stem: 'کدام انتخاب برای راهگاه، شرط «انجماد دیرتر از قطعه» را بهتر تأمین می‌کند؟',
        options: [
          'راهگاهی با مدول ۰.۸ برابر قطعه',
          'راهگاهی با مدول ۱.۲ برابر قطعه همراه با عایق‌کاری',
          'راهگاه نازک‌تر برای صرفه‌جویی در مذاب',
          'حذف راهگاه و افزایش دمای بارریزی'
        ],
        correct_index: 1,
        explanation: 'معیار طراحی $M_{r} \\ge 1.2\\,M_{c}$ است. عایق‌کاری نیز نرخ سرد شدن راهگاه را کاهش می‌دهد و باعث می‌شود راهگاه آخرین بخش منجمدشده و تغذیهٔ انقباضی قطعه را کامل کند.',
        source_page: 41
      },
      {
        id: 'mc_q_4',
        is_locked: true,
        question_stem: 'مکش انقباضی بیشتر در کدام ناحیه از قطعه تشکیل می‌شود؟',
        options: [
          'در سطوحی که سریع‌ترین انجماد را دارند',
          'در مرکز حرارتی که آخرین مذاب در آن منجمد می‌شود',
          'در مجاورت چیلرهای فلزی',
          'داخل راهگاه که همیشه مذاب دارد'
        ],
        correct_index: 1,
        explanation: 'مرکز حرارتی آخرین ناحیه‌ای است که منجمد می‌شود؛ اگر راه تغذیه به آن قطع شده باشد، انقباض حجمی به صورت حفرهٔ مکش ظاهر می‌شود. راه‌حل، انجماد جهت‌دار به سمت راهگاه و استفاده از چیلر در نقاط ضخیم است.',
        source_page: 54
      },
      {
        id: 'mc_q_5',
        is_locked: true,
        question_stem: 'افزایش بیش از حد دمای بارریزی چه پیامدی دارد؟',
        options: [
          'کاهش سیالیت و افزایش مکش',
          'افزایش سیالیت اما افزایش انقباض، مکش و تخلخل گازی',
          'حذف کامل تخلخل گازی',
          'کاهش زمان انجماد و ریزتر شدن دانه‌ها'
        ],
        correct_index: 1,
        explanation: 'دمای بارریزی بالا سیالیت را بهبود می‌دهد اما انقباض حجمی، زمان انجماد و انحلال گاز را افزایش می‌دهد؛ نتیجهٔ آن احتمال بیشتر مکش و تخلخل گازی است. بنابراین دمای بارریزی باید در محدودهٔ بهینه انتخاب شود.',
        source_page: 60
      }
    ],
    sample_ai_responses: {
      simplify: 'به زبان ساده، مدول $M = V/A$ نشان می‌دهد قطعه چقدر «حجیم» و چقدر «سطح آزاد» دارد. قطعه‌ای که سطح بیشتری نسبت به حجمش دارد، سریع‌تر گرمای خود را از دست می‌دهد و زودتر منجمد می‌شود؛ چون $t_s = B M^{2}$ است.',
      example: 'مثال عددی: اگر مدول قطعه‌ای $2\\,\\mathrm{cm}$ و مدول راهگاه $2.5\\,\\mathrm{cm}$ باشد، نسبت زمان انجماد راهگاه به قطعه برابر است با: $$\\frac{t_r}{t_c} = \\left(\\frac{2.5}{2}\\right)^{2} = 1.56$$ یعنی راهگاه حدود ۵۶٪ دیرتر منجمد می‌شود و تغذیهٔ انقباضی را تضمین می‌کند.',
      exam_tip: '⚠️ نکتهٔ طلایی شب امتحان: در محاسبات چورینوف واحد طول را حتماً یکسان بگیرید (مثلاً همه بر حسب سانتی‌متر). در فرمول شعاع بحرانی نیز $\\Delta T$ بر حسب کلوین است و $\\Delta H_f$ معمولاً بر حسب $\\mathrm{J/m^{3}}$ داده می‌شود؛ پیش از جای‌گذاری واحدها را هماهنگ کنید.',
      default: 'بر اساس جزوهٔ استاد، ابتدا نوع عیب یا پدیدهٔ مورد سؤال را مشخص کنید (هسته‌زایی، انجماد، تغذیه یا عیوب). سپس رابطهٔ حاکم را بنویسید: $$t_s = B M^{2}, \\qquad M = \\frac{V}{A}$$ و در نهایت مقادیر معلوم را با واحدهای سازگار جای‌گذاری کنید.'
    }
  };

  return course;
}

// ---------------------------------------------------------------------------
// ۴. نوشتن اتمیک فایل JSON
// ---------------------------------------------------------------------------
function writeJsonAtomic(outputPath, data) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, outputPath);
}

function toFaNumber(value) {
  return Number(value || 0).toLocaleString('fa-IR');
}

function printValidation(validation) {
  const { stats } = validation;
  console.log(`📊 محتوا: ${toFaNumber(stats.summaries)} نکتهٔ فرمول‌نامه | ${toFaNumber(stats.flashcards)} فلش‌کارت (${toFaNumber(stats.lockedFlashcards)} قفل) | ${toFaNumber(stats.questions)} سوال (${toFaNumber(stats.lockedQuestions)} قفل)`);
  if (validation.latexErrors.length === 0) {
    console.log('🧮 کامپایلر KaTeX: ۰ خطا — تمام فرمول‌ها معتبر هستند.');
  } else {
    console.log(`🧮 کامپایلر KaTeX: ${toFaNumber(validation.latexErrors.length)} خطا پیدا شد!`);
    validation.latexErrors.slice(0, 10).forEach((err) => {
      console.log(`   • ${err.location}: ${err.error}`);
    });
  }
  if (validation.errors.length) {
    console.log(`⛔ خطاهای ساختاری: ${validation.errors.length} مورد`);
    validation.errors.slice(0, 10).forEach((err) => console.log(`   • ${err}`));
  }
}

const HELP_TEXT = `
🎓 کارخانه جزوه زنده — ابزار خط فرمان (Jezveh_Saz CLI)
=====================================================

ساخت پکیج از فایل جزوه (نیازمند کلید Gemini در .env):
  node factory/cli.js --file ./notes.pdf --id metal_casting_01 --title "پکیج شب امتحان انجماد و ریخته‌گری" --category "مهندسی مواد و متالورژی" --price 65000

ساخت پکیج دموی معتبر و کاملاً آفلاین (بدون API Key):
  node factory/cli.js --demo --id metal_casting_01

آرگومان‌ها:
  --file <path>        مسیر فایل PDF/تصویر جزوه (قابل تکرار یا جداشده با کاما)
  --id <slug>          شناسه یکتا و امن فایل (الزامی)؛ مثال: metal_casting_01
  --title <text>       عنوان پکیج
  --category <text>    دسته‌بندی درس (برای کاتالوگ)
  --price <toman>      قیمت پکیج به تومان (پیش‌فرض: ${DEFAULT_PRICE})
  --instructor <text>  نام/توضیح استاد
  --creator <text>     نام جزوه‌نویس
  --creator-id <id>    شناسه تلگرام جزوه‌نویس (برای واریز سهم ۷۰٪)
  --out <path>         مسیر خروجی سفارشی (پیش‌فرض: public/data/<id>.json)
  --demo               ساخت پکیج نمونهٔ آفلاین و تست‌شده با KaTeX
  --force              اجازهٔ بازنویسی فایل خروجی در حالت تولید واقعی
  --help               نمایش همین راهنما

خروجی همیشه پیش از ذخیره با کامپایلر KaTeX و اعتبارسنج ساختاری بررسی می‌شود.
`.trim();

// ---------------------------------------------------------------------------
// ۵. اجرای اصلی
// ---------------------------------------------------------------------------
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  loadEnvFile();

  const id = String(args.id || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(id)) {
    throw new Error('شناسه (--id) الزامی و باید ۳ تا ۶۴ کاراکتر انگلیسی/عدد/خط تیره باشد؛ مثال: metal_casting_01');
  }

  const title = String(args.title || (args.demo ? DEFAULT_TITLE : '')).trim();
  if (!title) {
    throw new Error('عنوان پکیج (--title) الزامی است.');
  }

  const category = String(args.category || DEFAULT_CATEGORY).trim() || DEFAULT_CATEGORY;
  const instructor = String(args.instructor || DEFAULT_INSTRUCTOR).trim() || DEFAULT_INSTRUCTOR;
  const creator = String(args.creator || (args.demo ? DEFAULT_CREATOR : 'تولید شده با کارخانه جزوه زنده')).trim();
  const creatorTelegramId = args['creator-id'] ? String(args['creator-id']).trim() : '';

  const rawPrice = String(args.price === undefined ? DEFAULT_PRICE : args.price).replace(/[,\u066C\s]/g, '');
  const priceToman = Number(rawPrice);
  if (!Number.isFinite(priceToman) || priceToman < 0) {
    throw new Error('قیمت (--price) باید یک عدد نامنفی به تومان باشد.');
  }

  const outputPath = args.out
    ? path.resolve(process.cwd(), String(args.out))
    : path.join(DATA_DIR, `${id}.json`);

  console.log('');
  console.log('🎓 کارخانه جزوه زنده — حالت ' + (args.demo ? 'دموی آفلاین' : 'تولید با هوش مصنوعی'));
  console.log('──────────────────────────────────────────────');
  console.log(`🆔 شناسه: ${id}`);
  console.log(`📚 عنوان: ${title}`);
  console.log(`🗂️ دسته‌بندی: ${category}`);
  console.log(`💰 قیمت: ${toFaNumber(priceToman)} تومان`);
  console.log(`📄 خروجی: ${path.relative(PROJECT_ROOT, outputPath) || outputPath}`);

  if (fs.existsSync(outputPath) && !args.demo && !args.force) {
    throw new Error(`فایل خروجی از قبل وجود دارد و برای جلوگیری از بازنویسی ناخواسته متوقف شد:\n${outputPath}\nبرای بازنویسی آگاهانه از --force استفاده کنید.`);
  }

  if (fs.existsSync(outputPath)) {
    console.log('♻️ فایل خروجی از قبل وجود داشت و بازنویسی می‌شود.');
  }

  let course;

  if (args.demo) {
    console.log('🧪 ساخت پکیج نمونه بدون تماس با API ...');
    course = buildDemoCourse({
      id,
      title,
      category,
      priceToman,
      instructor,
      creator,
      creatorTelegramId
    });

    const validation = validateCoursePackage(course);
    printValidation(validation);
    if (!validation.ok) {
      throw new Error('پکیج دمو در اعتبارسنجی KaTeX/ساختاری رد شد و ذخیره نشد.');
    }
  } else {
    if (!args.files.length) {
      throw new Error('برای تولید واقعی، مسیر فایل جزوه را با --file بدهید (یا از --demo استفاده کنید).');
    }

    const inputFiles = args.files.map((file) => path.resolve(process.cwd(), file));
    for (const inputFile of inputFiles) {
      if (!fs.existsSync(inputFile) || !fs.statSync(inputFile).isFile()) {
        throw new Error(`فایل جزوه یافت نشد: ${inputFile}`);
      }
    }

    if (!hasGeminiKeys()) {
      throw new Error('هیچ کلید Gemini در .env پیدا نشد. برای تست سریع از «--demo» استفاده کنید.');
    }

    console.log(`⏳ ارسال ${toFaNumber(inputFiles.length)} فایل به Gemini 2.5 Flash و کامپایل خودکار KaTeX ...`);

    course = await generateCoursePackage({
      courseId: id,
      title,
      instructor,
      creator,
      creatorTelegramId,
      category,
      priceToman,
      inputFiles,
      outputPath
    });

    const validation = validateCoursePackage(course);
    printValidation(validation);
    if (!validation.ok) {
      throw new Error('پکیج تولیدشده در اعتبارسنجی نهایی مردود شد.');
    }
  }

  // در حالت دمو، نوشتن نهایی پس از تأیید کامل KaTeX انجام می‌شود
  if (args.demo) {
    writeJsonAtomic(outputPath, course);
  }

  const sizeKb = (fs.statSync(outputPath).size / 1024).toFixed(1);
  console.log('');
  console.log('✅ پکیج جزوه زنده با موفقیت ساخته شد!');
  console.log(`📁 مسیر فایل: ${outputPath}`);
  console.log(`📦 حجم فایل: ${sizeKb} کیلوبایت`);
  console.log('🚀 برای مشاهده در کاتالوگ، سرور را اجرا کنید: node server/server.js');
  console.log(`   و سپس: GET /api/courses  →  course id = ${id}`);
  console.log('');
  return 0;
}

// اجرای خودکار فقط زمانی که فایل مستقیماً از خط فرمان اجرا شود
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code || 0;
    })
    .catch((err) => {
      console.error('');
      console.error(`❌ ${err && err.message ? err.message : err}`);
      console.error('');
      process.exitCode = 1;
    });
}
