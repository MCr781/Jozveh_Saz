import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// بارگذاری موتور لوکال KaTeX پروژه برای تست خودکار سینتکس فرمول‌ها قبل از انتشار
const katex = require('../public/js/katex.min.js');

const GEMINI_API_KEYS = [
  process.env.GEMINI_API_KEY_1 || 'YOUR_FREE_GEMINI_KEY_1',
  process.env.GEMINI_API_KEY_2 || 'YOUR_FREE_GEMINI_KEY_2',
  process.env.GEMINI_API_KEY_3 || 'YOUR_FREE_GEMINI_KEY_3'
].filter((k) => !k.startsWith('YOUR_'));

let currentKeyIndex = 0;

export function getNextClient() {
  if (GEMINI_API_KEYS.length === 0) {
    throw new Error('لطفا حداقل یک کلید رایگان در متغیر محیطی GEMINI_API_KEY_1 قرار دهید.');
  }
  const apiKey = GEMINI_API_KEYS[currentKeyIndex % GEMINI_API_KEYS.length];
  currentKeyIndex++;
  return new GoogleGenAI({ apiKey });
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
function findBrokenLatexFormulas(courseObj) {
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
async function autoHealBrokenFormulas(courseObj, brokenList) {
  if (brokenList.length === 0) return courseObj;
  console.log(`🛠️ کامپایلر KaTeX تعداد ${brokenList.length} خطای سینتکسی در فرمول‌ها پیدا کرد. در حال ترمیم خودکار...`);

  const ai = getNextClient();
  const prompt = `
در ساختار JSON زیر، این فرمول‌های LaTeX در کامپایلر KaTeX خطای سینتکس داده‌اند:
${JSON.stringify(brokenList, null, 2)}

لطفا فقط فرمول‌های معیوب را در JSON زیر اصلاح کن تا ۱۰۰٪ در KaTeX معتبر باشند و کل JSON اصلاح‌شده را برگردان:
${JSON.stringify(courseObj)}
`;

  const res = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ text: prompt }],
    config: { responseMimeType: 'application/json', temperature: 0.1 }
  });

  return JSON.parse(res.text);
}

function fileToGenerativePart(filePath) {
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
  type: Type.OBJECT,
  properties: {
    summary_cheat_sheet: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          topic: { type: Type.STRING },
          key_points: { type: Type.ARRAY, items: { type: Type.STRING } },
          formula_latex: { type: Type.STRING },
          source_page: { type: Type.INTEGER }
        },
        required: ['id', 'topic', 'key_points', 'formula_latex', 'source_page']
      }
    },
    flashcards: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          is_locked: { type: Type.BOOLEAN },
          front: { type: Type.STRING },
          back: { type: Type.STRING },
          source_page: { type: Type.INTEGER }
        },
        required: ['id', 'is_locked', 'front', 'back', 'source_page']
      }
    },
    exam_questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          is_locked: { type: Type.BOOLEAN },
          question_stem: { type: Type.STRING },
          options: { type: Type.ARRAY, items: { type: Type.STRING } },
          correct_index: { type: Type.INTEGER },
          explanation: { type: Type.STRING },
          source_page: { type: Type.INTEGER }
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
  const ai = getNextClient();
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

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [...fileParts, { text: systemPrompt }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: courseSchema,
      temperature: 0.2
    }
  });

  let generatedData = JSON.parse(response.text);

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