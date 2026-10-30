import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { config } from '../server/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// بارگذاری موتور لوکال KaTeX پروژه برای تست خودکار سینتکس فرمول‌ها قبل از انتشار
const katex = require('../public/js/katex.min.js');

let currentKeyIndex = 0;

// خواندن کلیدها به صورت تنبل (Lazy) تا .env دیرتر از import شدن ماژول هم قابل استفاده باشد
export function getGeminiApiKeys() {
  return [
    process.env.GEMINI_API_KEY_1 || '',
    process.env.GEMINI_API_KEY_2 || '',
    process.env.GEMINI_API_KEY_3 || ''
  ].filter((k) => k && !k.startsWith('YOUR_'));
}

export function hasGeminiKeys() {
  return getGeminiApiKeys().length > 0;
}

export function getNextApiKey() {
  const keys = getGeminiApiKeys();
  if (keys.length === 0) {
    throw new Error('لطفا حداقل یک کلید معتبر در متغیر محیطی GEMINI_API_KEY_1 قرار دهید.');
  }
  const apiKey = keys[currentKeyIndex % keys.length];
  currentKeyIndex++;
  return apiKey;
}

export async function callGeminiRest({ contents, generationConfig, model = config.geminiModel || 'gemini-2.5-flash' }) {
  const maxRetries = Math.max(1, getGeminiApiKeys().length);
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const apiKey = getNextApiKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({ contents, generationConfig })
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const msg = data?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
        throw new Error(msg);
      }

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error('پاسخی از مدل Gemini دریافت نشد.');
      }

      return text;
    } catch (err) {
      lastError = err;
      console.warn(`[Gemini REST Attempt ${attempt + 1}] Warning: ${err.message}`);
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  throw lastError || new Error('خطا در برقراری ارتباط با Gemini REST API');
}

function loadLearnedRules() {
  const rulesPath = path.join(__dirname, 'learned_rules.json');
  try {
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    return rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
  } catch (_) {
    return '';
  }
}

// کامپایلر خودکار: بررسی صحت سینتکس تمام فرمول‌های LaTeX با موتور KaTeX
export function findBrokenLatexFormulas(courseObj) {
  const errors = [];

  const testExpression = (expr, location) => {
    try {
      katex.renderToString(expr.trim(), { throwOnError: true });
    } catch (err) {
      errors.push({ location, expression: expr, error: err.message });
    }
  };

  const scanText = (text, location) => {
    if (!text) return;
    const blockMatches = [...text.matchAll(/\$\$([\s\S]+?)\$\$/g)];
    blockMatches.forEach((m) => testExpression(m[1], location));

    const inlineMatches = [...text.replace(/\$\$[\s\S]+?\$\$/g, '').matchAll(/\$([^\$]+?)\$/g)];
    inlineMatches.forEach((m) => testExpression(m[1], location));
  };

  (courseObj.summary_cheat_sheet || []).forEach((s, i) => {
    if (s.formula_latex) testExpression(s.formula_latex, `summary[${i}].formula_latex`);
    (s.key_points || []).forEach((kp, j) => scanText(kp, `summary[${i}].key_points[${j}]`));
  });

  (courseObj.flashcards || []).forEach((fc, i) => {
    scanText(fc.front, `flashcards[${i}].front`);
    scanText(fc.back, `flashcards[${i}].back`);
  });

  (courseObj.exam_questions || []).forEach((q, i) => {
    scanText(q.question_stem, `exam_questions[${i}].question_stem`);
    scanText(q.explanation, `exam_questions[${i}].explanation`);
    (q.options || []).forEach((opt, j) => scanText(opt, `exam_questions[${i}].options[${j}]`));
  });

  return errors;
}

// اعتبارسنجی ساختاری + ریاضی پکیج قبل از انتشار نهایی
export function validateCoursePackage(courseObj) {
  const errors = [];

  if (!courseObj || typeof courseObj !== 'object' || Array.isArray(courseObj)) {
    return { ok: false, errors: ['ساختار پکیج باید یک آبجکت JSON باشد.'], latexErrors: [], stats: {} };
  }
  if (!courseObj.id || typeof courseObj.id !== 'string') errors.push('شناسه (id) پکیج تعریف نشده است.');
  if (!courseObj.title || typeof courseObj.title !== 'string') errors.push('عنوان (title) پکیج تعریف نشده است.');

  const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
  const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

  const summaries = courseObj.summary_cheat_sheet;
  const flashcards = courseObj.flashcards;
  const questions = courseObj.exam_questions;

  if (!Array.isArray(summaries) || summaries.length === 0) errors.push('فرمول‌نامه (summary_cheat_sheet) خالی است.');
  if (!Array.isArray(flashcards) || flashcards.length === 0) errors.push('فلش‌کارت‌ها (flashcards) خالی است.');
  if (!Array.isArray(questions) || questions.length === 0) errors.push('سوالات امتحانی (exam_questions) خالی است.');

  (Array.isArray(summaries) ? summaries : []).forEach((s, i) => {
    if (!isNonEmptyString(s?.id)) errors.push(`summary[${i}].id نامعتبر است.`);
    if (!isNonEmptyString(s?.topic)) errors.push(`summary[${i}].topic نامعتبر است.`);
    if (!Array.isArray(s?.key_points) || !s.key_points.length) errors.push(`summary[${i}].key_points خالی است.`);
    if (!isPositiveInt(s?.source_page)) errors.push(`summary[${i}].source_page باید عدد صحیح مثبت باشد.`);
  });

  (Array.isArray(flashcards) ? flashcards : []).forEach((fc, i) => {
    if (!isNonEmptyString(fc?.id)) errors.push(`flashcards[${i}].id نامعتبر است.`);
    if (!isNonEmptyString(fc?.front)) errors.push(`flashcards[${i}].front خالی است.`);
    if (!isNonEmptyString(fc?.back)) errors.push(`flashcards[${i}].back خالی است.`);
    if (typeof fc?.is_locked !== 'boolean') errors.push(`flashcards[${i}].is_locked باید بولین باشد.`);
    if (!isPositiveInt(fc?.source_page)) errors.push(`flashcards[${i}].source_page باید عدد صحیح مثبت باشد.`);
  });

  (Array.isArray(questions) ? questions : []).forEach((q, i) => {
    if (!isNonEmptyString(q?.id)) errors.push(`exam_questions[${i}].id نامعتبر است.`);
    if (!isNonEmptyString(q?.question_stem)) errors.push(`exam_questions[${i}].question_stem خالی است.`);
    if (!Array.isArray(q?.options) || q.options.length < 2) errors.push(`exam_questions[${i}].options باید حداقل ۲ گزینه باشد.`);
    if (!Number.isInteger(q?.correct_index) || q.correct_index < 0 || q.correct_index >= (q?.options?.length || 0)) {
      errors.push(`exam_questions[${i}].correct_index خارج از محدوده گزینه‌هاست.`);
    }
    if (!isNonEmptyString(q?.explanation)) errors.push(`exam_questions[${i}].explanation خالی است.`);
    if (typeof q?.is_locked !== 'boolean') errors.push(`exam_questions[${i}].is_locked باید بولین باشد.`);
    if (!isPositiveInt(q?.source_page)) errors.push(`exam_questions[${i}].source_page باید عدد صحیح مثبت باشد.`);
  });

  if (courseObj.price_toman !== undefined && (!Number.isFinite(Number(courseObj.price_toman)) || Number(courseObj.price_toman) < 0)) {
    errors.push('قیمت (price_toman) باید عددی نامنفی باشد.');
  }

  const latexErrors = findBrokenLatexFormulas(courseObj);

  return {
    ok: errors.length === 0 && latexErrors.length === 0,
    errors,
    latexErrors,
    stats: {
      summaries: Array.isArray(summaries) ? summaries.length : 0,
      flashcards: Array.isArray(flashcards) ? flashcards.length : 0,
      lockedFlashcards: Array.isArray(flashcards) ? flashcards.filter((f) => f && f.is_locked).length : 0,
      questions: Array.isArray(questions) ? questions.length : 0,
      lockedQuestions: Array.isArray(questions) ? questions.filter((q) => q && q.is_locked).length : 0
    }
  };
}

// ترمیم خودکار فرمول‌های معیوب با هوش مصنوعی بدون دخالت انسان
export async function autoHealBrokenFormulas(courseObj, brokenList) {
  if (brokenList.length === 0) return courseObj;
  console.log(`🛠️ کامپایلر KaTeX تعداد ${brokenList.length} خطای سینتکسی در فرمول‌ها پیدا کرد. در حال ترمیم خودکار...`);

  const prompt = `
در ساختار JSON زیر، این فرمول‌های LaTeX در کامپایلر KaTeX خطای سینتکس داده‌اند:
${JSON.stringify(brokenList, null, 2)}

لطفا فقط فرمول‌های معیوب را در JSON زیر اصلاح کن تا ۱۰۰٪ در KaTeX معتبر باشند و کل JSON اصلاح‌شده را برگردان:
${JSON.stringify(courseObj)}
`;

  const text = await callGeminiRest({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
  });

  return JSON.parse(text);
}

function fileToGenerativePart(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`فایل ورودی یافت نشد: ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg';
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(filePath)).toString('base64'),
      mimeType
    }
  };
}

const courseSchema = {
  type: 'OBJECT',
  properties: {
    summary_cheat_sheet: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          topic: { type: 'STRING' },
          key_points: { type: 'ARRAY', items: { type: 'STRING' } },
          formula_latex: { type: 'STRING' },
          source_page: { type: 'INTEGER' }
        },
        required: ['id', 'topic', 'key_points', 'formula_latex', 'source_page']
      }
    },
    flashcards: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          is_locked: { type: 'BOOLEAN' },
          front: { type: 'STRING' },
          back: { type: 'STRING' },
          source_page: { type: 'INTEGER' }
        },
        required: ['id', 'is_locked', 'front', 'back', 'source_page']
      }
    },
    exam_questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          is_locked: { type: 'BOOLEAN' },
          question_stem: { type: 'STRING' },
          options: { type: 'ARRAY', items: { type: 'STRING' } },
          correct_index: { type: 'INTEGER' },
          explanation: { type: 'STRING' },
          source_page: { type: 'INTEGER' }
        },
        required: ['id', 'is_locked', 'question_stem', 'options', 'correct_index', 'explanation', 'source_page']
      }
    }
  },
  required: ['summary_cheat_sheet', 'flashcards', 'exam_questions']
};

export async function generateCoursePackage({
  courseId,
  title,
  instructor,
  creator,
  creatorTelegramId = '',
  category = 'دروس عمومی مهندسی',
  priceToman = 59000,
  inputFiles = [],
  outputPath
}) {
  if (!hasGeminiKeys()) {
    throw new Error('هیچ کلید Gemini تنظیم نشده است. برای تست سریع از حالت «--demo» استفاده کنید.');
  }

  const fileParts = inputFiles.map(fileToGenerativePart);
  const learnedRules = loadLearnedRules();

  const systemPrompt = `
شما یک استاد برجسته دانشگاه تهران و طراح سوالات کنکور ارشد هستید.
فایل پیوست شده جزوه دست‌نویس و نمونه سوالات امتحانی است. آن را با دقت علمی بالا به ساختار JSON تبدیل کنید:
1. فرمول‌های درون‌خطی را بین $...$ و فرمول‌های مستقل را بین $$...$$ قرار دهید.
2. در آرایه flashcards فقط ۳ کارت اول و در exam_questions فقط ۲ سوال اول را is_locked: false بگذارید و بقیه را true کنید.

⚠️ قوانین بسیار مهم یادگرفته‌شده از خطاهای قبلی (حتماً رعایت شود):
${learnedRules}
`;

  const text = await callGeminiRest({
    contents: [{ parts: [...fileParts, { text: systemPrompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: courseSchema,
      temperature: 0.2
    }
  });

  let generatedData = JSON.parse(text);

  // حلقه کامپایلر خودکار KaTeX قبل از انتشار (حداکثر ۲ پاس ترمیم)
  let brokenFormulas = findBrokenLatexFormulas(generatedData);
  for (let pass = 0; pass < 2 && brokenFormulas.length > 0; pass++) {
    generatedData = await autoHealBrokenFormulas(generatedData, brokenFormulas);
    brokenFormulas = findBrokenLatexFormulas(generatedData);
  }

  const finalPackage = {
    id: courseId,
    title,
    instructor,
    creator,
    ...(creatorTelegramId ? { creator_telegram_id: creatorTelegramId } : {}),
    category,
    price_toman: priceToman,
    ai_quota_free: 3,
    ai_quota_pro: 100,
    ...generatedData,
    sample_ai_responses: {
      simplify: 'این مبحث یکی از پایه‌های اصلی امتحان است؛ به رابطه مستقیم متغیرها در فرمول دقت کنید.',
      example: 'برای حل مسائل عددی این بخش، ابتدا واحدها را به دستگاه SI تبدیل نمایید.',
      exam_tip: 'دام متداول طراح در این سوال، دادن دما بر حسب سانتی‌گراد به جای کلوین است!',
      default: 'بر اساس جزوه استاد، برای حل این سوال کافی است مقادیر معلوم را در رابطه اصلی فصل جایگذاری کنید.'
    }
  };

  // اعتبارسنجی نهایی: هرگز پکیجی با فرمول معیوب یا ساختار ناقص منتشر نمی‌شود
  const validation = validateCoursePackage(finalPackage);
  if (!validation.ok) {
    const details = [...validation.errors, ...validation.latexErrors.map((e) => `${e.location}: ${e.error}`)].slice(0, 8);
    throw new Error(`پکیج تولیدشده در اعتبارسنجی نهایی رد شد:\n- ${details.join('\n- ')}`);
  }

  // ذخیره‌سازی اتمیک (Atomic Write) برای جلوگیری از خرابی فایل
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(finalPackage, null, 2), 'utf8');
  fs.renameSync(tmpPath, outputPath);

  return finalPackage;
}
