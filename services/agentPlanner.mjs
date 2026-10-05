const allowedAgentTools = new Set([
  'web_search',
  'document_analysis',
  'image_analysis',
  'image_edit',
  'calculator',
  'text_processing',
  'code_analysis',
  'memory'
]);

const webIntent = /\b(search|look up|browse|latest|recent|current|news|online|internet|sources?)\b|ابحث|دوّر|دور|آخر أخبار|اخر اخبار|حديث|حديثة|حالي|حالياً|على الإنترنت|على الانترنت|مصادر/iu;
const imageEditIntent = /\b(edit|change|remove|replace|retouch|recolor|make it)\b|عدّل|عدل|غيّر|غير|احذف|أزل|ازل|بدّل|بدل|حسّن|حسن|حوّل الصورة|حول الصورة|تغيير.{0,15}(?:الخلفية|الملابس|الصورة)|خلي.{0,20}(?:ليل|نهار|خلفية|الصورة|الملابس)|اجعل.{0,20}(?:ليل|نهار|خلفية|الصورة|الملابس)/iu;
const imageAnalysisIntent = /\b(analy[sz]e|describe|what(?:'s| is) in|read text|ocr|identify)\b|حلل|حلّل|اشرح.{0,12}الصورة|صف الصورة|اوصف الصورة|أوصف الصورة|ماذا.{0,8}الصورة|شنو.{0,12}الصورة|اقرأ النص|استخرج النص|تعرف على الصورة/iu;
const documentIntent = /\b(file|document|pdf|docx|xlsx|spreadsheet|attachment|attached)\b|الملف|المستند|المرفق|المرفقات|المرفق|محتواه|لخّص|لخص|استخرج الجداول|الجداول/iu;
const calculatorIntent = /\b(calculate|compute|what is \d|solve)\b|احسب|كم يساوي|ناتج|اجمع|اطرح|اضرب|اقسم/iu;
const textIntent = /\b(rewrite|summari[sz]e|translate|proofread|format|extract key points)\b|لخّص|لخص|أعد صياغة|اعد صياغة|ترجم|صحح|صحّح|رتب النص|نسّق النص|استخرج النقاط/iu;
const codeIntent = /\b(code|debug|bug|stack trace|function|programming)\b|كود|برمج|خطأ برمجي|صحح الكود|صحّح الكود|حلل الكود|حلّل الكود/iu;
const memoryIntent = /\b(remember|memory|what do you remember|forget)\b|تذكر|تذكّر|الذاكرة|شنو تتذكر|ماذا تتذكر|انسَ|انسى/iu;
const imageGenerationIntent = /\b(generate|create|draw|make) (?:an? )?(?:image|picture|illustration)\b|أنشئ صورة|انشئ صورة|ولّد صورة|ولد صورة|ارسم صورة/iu;
const arithmeticExpression = /[-+]?\d+(?:\.\d+)?(?:\s*[-+*/×÷^]\s*[-+]?\d+(?:\.\d+)?)+(?:\s*=\s*\?)?/u;

export function createAgentCapabilities({ message, hasFile, hasImage, authenticated, forceWebSearch = false }) {
  const candidates = [];
  const normalizedMessage = normalizeArabicDigits(message);
  if (hasFile && documentIntent.test(message)) candidates.push('document_analysis');
  if (hasImage && imageEditIntent.test(message)) candidates.push('image_edit');
  else if (hasImage && imageAnalysisIntent.test(message)) candidates.push('image_analysis');
  if (webIntent.test(message) || forceWebSearch) candidates.push('web_search');
  if (calculatorIntent.test(message) && arithmeticExpression.test(normalizedMessage)) candidates.push('calculator');
  if (textIntent.test(message)) candidates.push('text_processing');
  if (codeIntent.test(message)) candidates.push('code_analysis');
  if (authenticated && memoryIntent.test(message)) candidates.push('memory');
  return {
    candidates: [...new Set(candidates)],
    imageGenerationUnavailable: imageGenerationIntent.test(message)
  };
}

export function parseAgentPlan(planText, candidates, maxSteps = 4) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const jsonText = typeof planText === 'string'
    ? planText.replace(/^\s*```(?:json)?\s*|\s*```\s*$/giu, '').trim()
    : '';
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return candidates.slice(0, maxSteps);
  }
  if (!parsed || !Array.isArray(parsed.tools)) return candidates.slice(0, maxSteps);

  const selected = [];
  for (const tool of parsed.tools) {
    if (typeof tool !== 'string' || !allowedAgentTools.has(tool) || !candidates.includes(tool)) continue;
    if (!selected.includes(tool)) selected.push(tool);
    if (selected.length >= maxSteps) break;
  }
  return selected;
}

export function calculateExpression(input) {
  if (typeof input !== 'string' || input.length > 120) {
    throw new Error('لم أجد تعبيراً حسابياً بسيطاً صالحاً.');
  }
  input = normalizeArabicDigits(input);
  if (!arithmeticExpression.test(input)) throw new Error('لم أجد تعبيراً حسابياً بسيطاً صالحاً.');
  const match = input.match(arithmeticExpression);
  const prefix = input.slice(0, match.index);
  const suffix = input.slice(match.index + match[0].length);
  if (!/^[\p{L}\s:،,]*$/u.test(prefix) || !/^[\s?؟.!،,]*$/u.test(suffix)) {
    throw new Error('لا أستطيع تنفيذ سوى عملية حسابية بسيطة.');
  }
  const expression = match[0]
    ?.replace(/=\s*\?$/, '')
    .replaceAll('×', '*')
    .replaceAll('÷', '/')
    .replace(/\s+/g, '');
  if (!expression) throw new Error('لم أجد تعبيراً حسابياً بسيطاً صالحاً.');

  let position = 0;
  function parseNumber() {
    const start = position;
    while (/\d|\./u.test(expression[position] ?? '')) position += 1;
    const value = Number(expression.slice(start, position));
    if (start === position || !Number.isFinite(value)) throw new Error('صيغة العملية الحسابية غير صالحة.');
    return value;
  }
  function parsePower() {
    let value = parseNumber();
    if (expression[position] === '^') {
      position += 1;
      const exponent = parseUnary();
      value **= exponent;
    }
    return value;
  }
  function parseUnary() {
    if (expression[position] === '+') {
      position += 1;
      return parseUnary();
    }
    if (expression[position] === '-') {
      position += 1;
      return -parseUnary();
    }
    return parsePower();
  }
  function parseProduct() {
    let value = parseUnary();
    while (['*', '/'].includes(expression[position])) {
      const operator = expression[position++];
      const right = parseUnary();
      if (operator === '/' && right === 0) throw new Error('لا يمكن القسمة على صفر.');
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  }
  function parseSum() {
    let value = parseProduct();
    while (['+', '-'].includes(expression[position])) {
      const operator = expression[position++];
      const right = parseProduct();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  }

  const result = parseSum();
  if (position !== expression.length || !Number.isFinite(result) || Math.abs(result) > 1e100) {
    throw new Error('العملية الحسابية خارج النطاق المدعوم.');
  }
  return result;
}

function normalizeArabicDigits(input) {
  return String(input).replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660));
}
