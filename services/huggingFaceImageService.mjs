const modelId = 'black-forest-labs/FLUX.1-Kontext-dev';
const modelEndpoint = `https://router.huggingface.co/hf-inference/models/${modelId}`;
const supportedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxImageBytes = 8 * 1024 * 1024;
const maxOutputBytes = 16 * 1024 * 1024;

export class HuggingFaceImageError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HuggingFaceImageError';
    this.status = status;
  }
}

function matchesImageSignature(bytes, mimeType) {
  if (mimeType === 'image/png') {
    return bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return mimeType === 'image/webp' &&
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP';
}

function parseImageDataUrl(image) {
  if (typeof image !== 'string') {
    throw new HuggingFaceImageError(400, 'ارفع صورة قبل إرسال طلب التعديل.');
  }

  const match = image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || !supportedImageTypes.has(match[1])) {
    throw new HuggingFaceImageError(400, 'صيغة الصورة غير مدعومة. استخدم PNG أو JPEG أو WebP.');
  }

  const [, mimeType, encodedImage] = match;
  if (encodedImage.length > Math.ceil(maxImageBytes * 4 / 3) + 4) {
    throw new HuggingFaceImageError(413, 'حجم الصورة يجب ألا يتجاوز 8 ميغابايت.');
  }

  const imageBuffer = Buffer.from(encodedImage, 'base64');
  if (
    imageBuffer.length === 0 ||
    imageBuffer.length > maxImageBytes ||
    imageBuffer.toString('base64') !== encodedImage ||
    !matchesImageSignature(imageBuffer, mimeType)
  ) {
    throw new HuggingFaceImageError(400, 'ملف الصورة غير صالح أو لا يطابق نوعه المعلن.');
  }

  return { mimeType, imageBuffer };
}

function providerErrorMessage(status, providerMessage) {
  if (status === 401 || status === 403) {
    return 'رفض Hugging Face الطلب. تحقّق من صلاحية HUGGINGFACE_API_KEY وتفعيل إذن Inference Providers.';
  }
  if (status === 402) {
    return 'لا تتوفر أرصدة Hugging Face لهذا الطلب. لم يتم اختيار مزوّد مدفوع بديل.';
  }
  if (status === 429) {
    return 'وصلت إلى حد الطلبات في Hugging Face. انتظر قليلاً ثم حاول مرة أخرى.';
  }
  if (
    /no inference provider|not supported by any provider|provider.*not available|model.*not available|not deployed/i.test(providerMessage) ||
    status === 404 ||
    status === 410
  ) {
    return 'نموذج FLUX.1-Kontext-dev غير متاح حالياً عبر مزوّد hf-inference. يظهر حالياً عبر مزوّدين آخرين فقط؛ لم نوجّه الطلب إلى مزوّد قد يفرض رسوماً.';
  }
  if (status === 503) {
    return 'خدمة Hugging Face أو النموذج غير متاح مؤقتاً. لم يتم التحويل إلى مزوّد مدفوع.';
  }

  const safeMessage = providerMessage
    .replace(/hf_[A-Za-z0-9]+/g, '[مفتاح مخفي]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [مفتاح مخفي]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
  return safeMessage
    ? `رفض Hugging Face طلب تعديل الصورة (HTTP ${status}): ${safeMessage}`
    : `فشل تعديل الصورة عبر Hugging Face (HTTP ${status}). حاول مرة أخرى.`;
}

async function readProviderError(response) {
  try {
    const data = await response.json();
    return typeof data.error === 'string' ? data.error : '';
  } catch {
    return '';
  }
}

export async function editImageWithHuggingFace({ apiKey, image, prompt }) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 2000) {
    throw new HuggingFaceImageError(400, 'اكتب وصف التعديل، وبحد أقصى 2000 حرف.');
  }
  const { imageBuffer } = parseImageDataUrl(image);
  if (!apiKey) {
    throw new HuggingFaceImageError(503, 'أضف HUGGINGFACE_API_KEY إلى ملف .env لتفعيل تعديل الصور.');
  }

  let providerResponse;
  try {
    providerResponse = await fetch(modelEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'image/*'
      },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        inputs: imageBuffer.toString('base64'),
        parameters: {
          prompt: [
            'Edit the provided image according to the user instruction.',
            'Preserve the identity, face, facial features, pose, clothing, lighting, and composition unless the user explicitly asks to change them.',
            `User instruction: ${prompt.trim()}`
          ].join(' ')
        }
      })
    });
  } catch {
    throw new HuggingFaceImageError(502, 'تعذّر الاتصال بخدمة Hugging Face. تحقّق من الاتصال وحاول مجدداً.');
  }

  if (!providerResponse.ok) {
    const providerMessage = await readProviderError(providerResponse);
    console.error('Hugging Face image request failed. HTTP status:', providerResponse.status);
    const modelUnavailable =
      /no inference provider|not supported by any provider|provider.*not available|model.*not available|not deployed/i.test(providerMessage) ||
      providerResponse.status === 404 ||
      providerResponse.status === 410;
    const responseStatus = modelUnavailable
      ? 503
      : providerResponse.status === 401 || providerResponse.status === 403 ||
        providerResponse.status === 402 || providerResponse.status === 429
        ? providerResponse.status
        : 502;
    throw new HuggingFaceImageError(
      responseStatus,
      providerErrorMessage(providerResponse.status, providerMessage)
    );
  }

  const outputMimeType = providerResponse.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!supportedImageTypes.has(outputMimeType)) {
    throw new HuggingFaceImageError(502, 'أعاد Hugging Face استجابة ليست صورة PNG أو JPEG أو WebP.');
  }

  const outputLength = Number(providerResponse.headers.get('content-length'));
  if (Number.isFinite(outputLength) && outputLength > maxOutputBytes) {
    throw new HuggingFaceImageError(502, 'حجم الصورة الناتجة من Hugging Face أكبر من الحد المسموح.');
  }

  const outputChunks = [];
  let outputSize = 0;
  for await (const chunk of providerResponse.body) {
    outputSize += chunk.length;
    if (outputSize > maxOutputBytes) {
      throw new HuggingFaceImageError(502, 'حجم الصورة الناتجة من Hugging Face أكبر من الحد المسموح.');
    }
    outputChunks.push(chunk);
  }
  const output = Buffer.concat(outputChunks);
  if (
    output.length === 0 ||
    !matchesImageSignature(output, outputMimeType)
  ) {
    throw new HuggingFaceImageError(502, 'تعذّر التحقق من الصورة الناتجة من Hugging Face.');
  }

  return {
    image: `data:${outputMimeType};base64,${output.toString('base64')}`,
    mimeType: outputMimeType,
    model: modelId
  };
}
