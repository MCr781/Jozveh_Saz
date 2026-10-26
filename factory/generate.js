import fs from 'fs';
import path from 'path';
import { GoogleGenAI, Type } from '@google/genai';

// چرخش کلیدهای رایگان Google AI Studio (می‌توانی چند کلید رایگان اینجا بگذاری)
const GEMINI_API_KEYS = [
  process.env.GEMINI_API_KEY_1 || 'YOUR_FREE_GEMINI_KEY_1',
  process.env.GEMINI_API_KEY_2 || 'YOUR_FREE_GEMINI_KEY_2'
].filter((k) => !k.startsWith('YOUR_'));

let currentKeyIndex = 0;

function getNextClient() {
  if (GEMINI_API_KEYS.length === 0) {
    throw new Error('لطفا حداقل یک کلید رایگان از aistudio.google.com در متغیر محیطی GEMINI_API_KEY_1 قرار دهید.');
  }
  const apiKey = GEMINI_API_KEYS[currentKeyIndex % GEMINI_API_KEYS.length];
  currentKeyIndex++;
  return new GoogleGenAI({ apiKey });
}

function fileToGenerativePart(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType =
    ext === '.pdf'
      ? 'application/pdf'
      : ext === '.png'
      ? 'image/png'
      : 'image/jpeg';

  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(filePath)).toString('base64'),
      mimeType
    }
  };
}

// اسکیمای دقیق منطبق با پلیر جزوه زنده
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
          formula_latex: { type: Type.STRING, description: 'Raw LaTeX formula without $ delimiters' },
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
          front: { type: Type.STRING, description: 'Persian question with inline math inside $...$' },
          back: { type: Type.STRING, description: 'Persian answer with inline $...$ or block $$...$$ math' },
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

  const systemPrompt = `
شما یک استاد برجسته دانشگاه تهران و طراح سوالات کنکور ارشد هستید.
تصاویر یا فایل PDF پیوست شده مربوط به جزوه دست‌نویس کلاسی و نمونه سوالات امتحانی است.
وظیفه شما استخراج دقیق محتوا به زبان فارسی سلیس و علمی است:
1. تمام فرمول‌های ریاضی، مهندسی و متالورژی را با دقت ۱۰۰٪ به فرمت استاندارد LaTeX تبدیل کنید.
2. در متن فلش‌کارت‌ها و سوالات، فرمول‌های درون‌خطی را داخل یک علامت دلار $...$ و فرمول‌های مهم مستقل را داخل $$...$$ قرار دهید.
3. در آرایه flashcards، فقط ۳ کارت اول را is_locked: false بگذارید و بقیه را is_locked: true قرار دهید.
4. در آرایه exam_questions، فقط ۲ سوال اول را is_locked: false بگذارید و بقیه را is_locked: true قرار دهید.
`;

  console.log('⏳ در حال ارسال صفحات جزوه به موتور Gemini 2.5 Flash...');

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [...fileParts, { text: systemPrompt }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: courseSchema,
      temperature: 0.2
    }
  });

  const generatedData = JSON.parse(response.text);

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
      example: 'برای حل مسائل عددی این بخش، ابتدا واحدها را به دستگاه SI (ژول، کلوین، متر) تبدیل نمایید.',
      exam_tip: 'دام متداول طراح در این سوال، دادن دما بر حسب سانتی‌گراد به جای کلوین است!',
      default: 'بر اساس جزوه استاد، برای حل این سوال کافی است مقادیر معلوم را در رابطه اصلی فصل جایگذاری کنید.'
    }
  };

  fs.writeFileSync(outputPath, JSON.stringify(finalPackage, null, 2), 'utf8');
  console.log(`✅ پکیج با موفقیت ساخته شد و در مسیر زیر ذخیره گردید:\n${outputPath}`);
}