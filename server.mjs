import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT) || 3000;
const dirname = path.dirname(fileURLToPath(import.meta.url));
const maxHistory = 20;
const maxMessageLength = 12000;
const categories = new Set(['general', 'games', 'web', 'media', 'templates']);

app.disable('x-powered-by');
app.use(express.static(path.join(dirname, 'public')));

app.get('/api/health', (_request, response) => {
  response.json({
    status: 'ok',
    configured: Boolean(process.env.GEMINI_API_KEY?.trim())
  });
});

app.post('/api/image-edit', express.json({ limit: '12mb' }), async (request, response) => {
  const { prompt, imageBase64, mimeType } = request.body ?? {};
  const supportedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const maxImageBytes = 8 * 1024 * 1024;

  if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > 4000) {
    return response.status(400).json({
      error: 'اكتب وصفاً للتعديل المطلوب، وبحد أقصى 4000 حرف.'
    });
  }

  if (
    typeof imageBase64 !== 'string' ||
    !supportedImageTypes.has(mimeType) ||
    imageBase64.length === 0 ||
    imageBase64.length > Math.ceil(maxImageBytes * 4 / 3) + 8 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(imageBase64)
  ) {
    return response.status(400).json({
      error: 'أرسل صورة PNG أو JPEG أو WebP صالحة.'
    });
  }

  const imageBuffer = Buffer.from(imageBase64, 'base64');
  if (imageBuffer.length === 0 || imageBuffer.length > maxImageBytes) {
    return response.status(413).json({
      error: 'حجم الصورة يجب ألا يتجاوز 8 ميغابايت.'
    });
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return response.status(503).json({
      error: 'خدمة تعديل الصور غير مهيّأة. أضف GEMINI_API_KEY إلى ملف .env.'
    });
  }

  try {
    const apiResponse = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        signal: AbortSignal.timeout(120000),
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              {
                text: [
                  'Edit the provided image according to the user request and return the finished edited image.',
                  'Preserve the original person identity, facial features, body, pose, composition, and background unless the user explicitly asks to change them.',
                  `User request: ${prompt.trim()}`
                ].join(' ')
              },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: imageBase64
                }
              }
            ]
          }],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE']
          }
        })
      }
    );

    const data = await apiResponse.json();
    if (!apiResponse.ok) {
      console.error(
        'Gemini image model returned HTTP',
        apiResponse.status,
        data.error?.message ?? 'No error details returned.'
      );

      if (apiResponse.status === 429) {
        return response.status(503).json({
          error: 'نموذج تعديل الصور متاح، لكن حصة الاستخدام غير متوفرة حالياً. تحقّق من حدود الاستخدام والفوترة في مشروع Gemini.'
        });
      }

      return response.status(502).json({
        error: 'تعذّر تعديل الصورة عبر Gemini. حاول مرة ثانية أو تحقّق من إعدادات النموذج.'
      });
    }

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find((part) => part.inlineData?.data || part.inline_data?.data);
    const imageData = imagePart?.inlineData?.data ?? imagePart?.inline_data?.data;
    const outputMimeType = imagePart?.inlineData?.mimeType
      ?? imagePart?.inline_data?.mime_type;
    const reply = parts
      .map((part) => part.text)
      .filter((text) => typeof text === 'string')
      .join('\n')
      .trim();

    if (
      typeof imageData !== 'string' ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(outputMimeType)
    ) {
      console.error('Gemini image response did not contain a supported generated image.');
      return response.status(502).json({
        error: 'لم يُرجع نموذج الصور صورة معدّلة. جرّب صياغة طلبك مرة ثانية.'
      });
    }

    return response.json({
      reply: reply || 'تم تجهيز الصورة المعدّلة.',
      image: {
        mimeType: outputMimeType,
        data: imageData
      }
    });
  } catch (error) {
    console.error('Gemini image-edit request failed:', error);
    return response.status(502).json({
      error: 'تعذّر الاتصال بنموذج تعديل الصور. تحقّق من الاتصال وحاول مرة ثانية.'
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

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return response.status(503).json({
      error: 'خدمة الذكاء الاصطناعي غير مهيّأة. أضف GEMINI_API_KEY إلى ملف .env ثم أعد تشغيل السيرفر.'
    });
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

  const endpoint =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent';

  try {
    const apiResponse = await fetch(endpoint, {
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

    const data = await apiResponse.json();
    if (!apiResponse.ok) {
      console.error(
        'Gemini API returned HTTP',
        apiResponse.status,
        data.error?.message ?? 'No error details returned.'
      );
      return response.status(502).json({
        error: 'فشل طلب الذكاء الاصطناعي. تحقّق من صلاحية مفتاح Gemini وإعداداته، ثم حاول مرة ثانية.'
      });
    }

    const reply = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text)
      .filter((text) => typeof text === 'string')
      .join('')
      .trim();

    if (!reply) {
      console.error('Gemini API response did not contain a text reply.');
      return response.status(502).json({
        error: 'وصل رد فارغ أو غير صالح من الذكاء الاصطناعي. حاول مرة ثانية.'
      });
    }

    return response.json({ reply });
  } catch (error) {
    console.error('Gemini request failed:', error);
    return response.status(502).json({
      error: 'تعذّر الاتصال بخدمة الذكاء الاصطناعي. تحقّق من اتصال الإنترنت وحاول مرة ثانية.'
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
