import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// بارگذاری موتور لوکال KaTeX پروژه برای تست خودکار سینتکس فرمول‌ها قبل از انتشار
const katex = require('../public/js/katex.min.js');

const GEMINI_API_KEYS = [
  process.env.GEMINI_API_KEY_1 || '',
  process.env.GEMINI_API_KEY_2 || '',
  process.env.GEMINI_API_KEY_3 || ''
].filter((k) => k && !k.startsWith('YOUR_'));

let currentKeyIndex = 0;

export function getNextApiKey() {
  if (GEMINI_API_KEYS.length === 0) {
    throw new Error('لطفا حداقل یک کلید معتبر در متغیر محیطی GEMINI_API_KEY_1 قرار دهید.');
  }
  const apiKey = GEMINI_API_KEYS[currentKeyIndex % GEMINI_API_KEYS.length];
  currentKeyIndex++;
  return apiKey;
}

export async function callGeminiRest({ contents, generationConfig, model = 'gemini-2.5-flash' }) {
  const maxRetries = Math.max(1, GEMINI_API_KEYS.length);
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const apiKey = getNextApiKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
  priceToman = 59000,
  inputFiles = [],
  outputPath
}) {
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

  // حلقه کامپایلر خودکار KaTeX قبل از انتشار
  const brokenFormulas = findBrokenLatexFormulas(generatedData);
  if (brokenFormulas.length > 0) {
    generatedData = await autoHealBrokenFormulas(generatedData, brokenFormulas);
  }

  const finalPackage = {
    id: courseId,
    title,
    instructor,
    creator,
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

  // ذخیره‌سازی اتمیک (Atomic Write) برای جلوگیری از خرابی فایل
  const tmpPath = `${outputPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(finalPackage, null, 2), 'utf8');
  fs.renameSync(tmpPath, outputPath);

  return finalPackage;
}
