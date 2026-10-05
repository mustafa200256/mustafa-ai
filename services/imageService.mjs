const imageModelEndpoint =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent';
const supportedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxImageBytes = 8 * 1024 * 1024;

export class ImageServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ImageServiceError';
    this.status = status;
  }
}

export async function editImage({ apiKey, prompt, imageBase64, mimeType, signal }) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > 4000) {
    throw new ImageServiceError(400, 'اكتب وصفاً للتعديل المطلوب، وبحد أقصى 4000 حرف.');
  }

  if (
    typeof imageBase64 !== 'string' ||
    !supportedImageTypes.has(mimeType) ||
    imageBase64.length === 0 ||
    imageBase64.length > Math.ceil(maxImageBytes * 4 / 3) + 8 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(imageBase64)
  ) {
    throw new ImageServiceError(400, 'أرسل صورة PNG أو JPEG أو WebP صالحة.');
  }

  const imageBuffer = Buffer.from(imageBase64, 'base64');
  if (imageBuffer.length === 0 || imageBuffer.length > maxImageBytes) {
    throw new ImageServiceError(413, 'حجم الصورة يجب ألا يتجاوز 8 ميغابايت.');
  }

  if (!apiKey) {
    throw new ImageServiceError(503, 'خدمة تعديل الصور غير مهيّأة. أضف GEMINI_API_KEY إلى ملف .env.');
  }

  let apiResponse;
  try {
    const timeoutSignal = AbortSignal.timeout(120000);
    apiResponse = await fetch(imageModelEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
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
    });
  } catch {
    if (signal?.aborted) throw signal.reason ?? new Error('تم إيقاف المهمة.');
    throw new ImageServiceError(502, 'تعذّر الاتصال بنموذج تعديل الصور. تحقّق من الاتصال وحاول مرة ثانية.');
  }

  let data;
  try {
    data = await apiResponse.json();
  } catch {
    throw new ImageServiceError(502, 'وصل رد غير صالح من نموذج تعديل الصور.');
  }

  if (!apiResponse.ok) {
    console.error('Gemini image model returned HTTP', apiResponse.status);
    if (apiResponse.status === 429) {
      throw new ImageServiceError(
        503,
        'نموذج تعديل الصور متاح، لكن حصة الاستخدام غير متوفرة حالياً. تحقّق من حدود الاستخدام والفوترة في مشروع Gemini.'
      );
    }
    throw new ImageServiceError(502, 'تعذّر تعديل الصورة عبر Gemini. حاول مرة ثانية أو تحقّق من إعدادات النموذج.');
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
    !supportedImageTypes.has(outputMimeType)
  ) {
    throw new ImageServiceError(502, 'لم يُرجع نموذج الصور صورة معدّلة. جرّب صياغة طلبك مرة ثانية.');
  }

  return {
    reply: reply || 'تم تجهيز الصورة المعدّلة.',
    image: {
      mimeType: outputMimeType,
      data: imageData
    }
  };
}
