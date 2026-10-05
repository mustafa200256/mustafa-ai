import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { editImage, ImageServiceError } from './services/imageService.mjs';

const app = express();
const port = Number(process.env.PORT) || 3000;
const dirname = path.dirname(fileURLToPath(import.meta.url));
const maxHistory = 20;
const maxMessageLength = 12000;
const categories = new Set(['general', 'games', 'web', 'media', 'templates']);
const groqModel = 'openai/gpt-oss-120b';

class ProviderRequestError extends Error {
  constructor(provider, status, fallbackAllowed = false) {
    super(`${provider} request failed`);
    this.name = 'ProviderRequestError';
    this.provider = provider;
    this.status = status;
    this.fallbackAllowed = fallbackAllowed;
  }
}

function shouldFallbackFromGemini(status, error) {
  const errorDetails = [
    error?.status,
    error?.message
  ].filter((value) => typeof value === 'string').join(' ').toLowerCase();

  return status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500 ||
    /\b(quota|rate.?limit|resource[_\s-]+exhausted|temporar(?:y|ily) unavailable|overload(?:ed)?|unavailable|deadline exceeded)\b/.test(errorDetails);
}

async function requestGemini(apiKey, systemPrompt, history, message) {
  const endpoint =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent';

  let apiResponse;
  try {
    apiResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [
          ...history.map(({ role, text }) => ({
            role,
            parts: [{ text: text.trim() }]
          })),
          { role: 'user', parts: [{ text: message.trim() }] }
        ]
      })
    });
  } catch {
    throw new ProviderRequestError('Gemini', 0, true);
  }

  let data;
  try {
    data = await apiResponse.json();
  } catch {
    throw new ProviderRequestError('Gemini', apiResponse.status, true);
  }

  if (!apiResponse.ok) {
    throw new ProviderRequestError(
      'Gemini',
      apiResponse.status,
      shouldFallbackFromGemini(apiResponse.status, data.error)
    );
  }

  const candidate = data.candidates?.[0];
  const finishReason = candidate?.finishReason ?? candidate?.finish_reason;
  if (['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION'].includes(finishReason)) {
    throw new ProviderRequestError('Gemini', apiResponse.status);
  }

  const reply = candidate?.content?.parts
    ?.map((part) => part.text)
    .filter((text) => typeof text === 'string')
    .join('')
    .trim();

  if (!reply) {
    throw new ProviderRequestError('Gemini', apiResponse.status, true);
  }

  return reply;
}

async function requestGroq(apiKey, systemPrompt, history, message) {
  let apiResponse;
  try {
    apiResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        model: groqModel,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history.map(({ role, text }) => ({
            role: role === 'model' ? 'assistant' : 'user',
            content: text.trim()
          })),
          { role: 'user', content: message.trim() }
        ]
      })
    });
  } catch {
    throw new ProviderRequestError('Groq', 0);
  }

  let data;
  try {
    data = await apiResponse.json();
  } catch {
    throw new ProviderRequestError('Groq', apiResponse.status);
  }

  if (!apiResponse.ok) {
    throw new ProviderRequestError('Groq', apiResponse.status);
  }

  const reply = data.choices?.[0]?.message?.content?.trim();
  if (typeof reply !== 'string' || !reply) {
    throw new ProviderRequestError('Groq', apiResponse.status);
  }

  return reply;
}

app.disable('x-powered-by');
app.use(express.static(path.join(dirname, 'public')));

app.get('/api/health', (_request, response) => {
  response.json({
    status: 'ok',
    configured: Boolean(
      process.env.GEMINI_API_KEY?.trim() || process.env.GROQ_API_KEY?.trim()
    )
  });
});

app.post('/api/image-edit', express.json({ limit: '12mb' }), async (request, response) => {
  const { prompt, imageBase64, mimeType } = request.body ?? {};
  try {
    const result = await editImage({
      apiKey: process.env.GEMINI_API_KEY?.trim(),
      prompt,
      imageBase64,
      mimeType
    });
    return response.json(result);
  } catch (error) {
    if (error instanceof ImageServiceError) {
      return response.status(error.status).json({ error: error.message });
    }
    console.error('Image-edit service failed unexpectedly.');
    return response.status(502).json({
      error: 'تعذّر تعديل الصورة حالياً. حاول مرة ثانية.'
    });
  }
});

app.use(express.json({ limit: '64kb' }));

app.post('/api/chat', async (request, response) => {
  const { message, history = [], category = 'general' } = request.body ?? {};

  if (
    typeof message !== 'string' ||
    message.trim().length === 0 ||
    message.length > maxMessageLength
  ) {
    return response.status(400).json({
      error: 'أرسل رسالة نصية غير فارغة، وبحد أقصى 12000 حرف.'
    });
  }

  if (!Array.isArray(history) || history.length > maxHistory - 1) {
    return response.status(400).json({
      error: `سياق المحادثة غير صالح. الحد الأقصى ${maxHistory - 1} رسالة سابقة.`
    });
  }

  if (!categories.has(category)) {
    return response.status(400).json({ error: 'اختيار التخصص غير صالح.' });
  }

  const validHistory = history.every((item) =>
    item &&
    (item.role === 'user' || item.role === 'model') &&
    typeof item.text === 'string' &&
    item.text.trim().length > 0 &&
    item.text.length <= maxMessageLength
  );

  if (!validHistory) {
    return response.status(400).json({ error: 'سياق المحادثة يحتوي على رسالة غير صالحة.' });
  }

  const categoryGuidance = {
    general: 'أجب عن سؤال المستخدم مباشرة وبأسلوب واضح.',
    games: 'ركّز على برمجة الألعاب ومحركاتها وتصميم أسلوب اللعب.',
    web: 'ركّز على برمجة المواقع وتطبيقات الويب وأفضل ممارساتها.',
    media: 'ركّز على تعديل الصور والفيديوهات وأدوات الإنتاج الإبداعي.',
    templates: 'ركّز على قوالب الصور والفيديو، واقترح أفكاراً وأدوات مناسبة.'
  };

  const systemPrompt = [
    'أنت مساعد ذكي ومبرمج محترف، تمت برمجتك بواسطة "المبرمج العراقي مصطفى حسين".',
    'تحدث باللهجة العراقية الأصيلة واللطيفة عندما تلائم السؤال، وأجب بوضوح ودقة.',
    'أتقن البرمجة والمواضيع التقنية، وقدّم أمثلة برمجية واضحة ونظيفة عند الحاجة.',
    categoryGuidance[category]
  ].join(' ');

  const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
  let geminiFailure;

  if (geminiApiKey) {
    try {
      const reply = await requestGemini(geminiApiKey, systemPrompt, history, message);
      return response.json({ reply });
    } catch (error) {
      geminiFailure = error;
      console.error(
        'Gemini chat request failed. HTTP status:',
        error.status || 'network error'
      );

      if (!error.fallbackAllowed) {
        return response.status(502).json({
          error: 'فشل طلب Gemini. تحقّق من إعدادات الخدمة وحاول مرة ثانية.'
        });
      }
    }
  } else {
    geminiFailure = new ProviderRequestError('Gemini', 0, true);
  }

  const groqApiKey = process.env.GROQ_API_KEY?.trim();
  if (!groqApiKey) {
    const geminiUnavailable = geminiApiKey
      ? 'تعذّر الرد من Gemini، وخدمة Groq الاحتياطية غير مهيّأة. أضف GROQ_API_KEY إلى ملف .env.'
      : 'خدمة الذكاء الاصطناعي غير مهيّأة. أضف GEMINI_API_KEY أو GROQ_API_KEY إلى ملف .env.';
    return response.status(503).json({ error: geminiUnavailable });
  }

  try {
    const reply = await requestGroq(groqApiKey, systemPrompt, history, message);
    return response.json({ reply });
  } catch (error) {
    console.error(
      'Groq fallback request failed. HTTP status:',
      error.status || 'network error',
      'Gemini HTTP status:',
      geminiFailure.status || 'not configured'
    );
    return response.status(502).json({
      error: 'تعذّر الحصول على رد من Gemini أو Groq. حاول مرة ثانية بعد قليل.'
    });
  }
});

app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && 'body' in error) {
    return response.status(400).json({ error: 'صيغة JSON المرسلة غير صالحة.' });
  }

  if (error?.type === 'entity.too.large') {
    return response.status(413).json({ error: 'حجم الطلب أكبر من المسموح.' });
  }

  console.error('Request failed:', error);
  return response.status(500).json({ error: 'صار خطأ غير متوقع بالسيرفر.' });
});

app.listen(port, () => {
  console.log(`Mustafa Hussein AI is running at http://localhost:${port}`);
});
