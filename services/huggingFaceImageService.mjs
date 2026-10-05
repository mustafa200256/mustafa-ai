import {
  InferenceClient,
  InferenceClientHubApiError,
  InferenceClientInputError,
  InferenceClientProviderApiError,
  InferenceClientRoutingError
} from '@huggingface/inference';

const modelId = 'Qwen/Qwen-Image-Edit';
const provider = 'fal-ai';
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

function getProviderErrorDetails(error) {
  if (
    error instanceof InferenceClientProviderApiError ||
    error instanceof InferenceClientHubApiError
  ) {
    const body = error.httpResponse.body;
    const message = typeof body === 'string'
      ? body
      : typeof body === 'object' && body !== null
        ? [body.error, body.message, body.detail].find((value) => typeof value === 'string') ?? ''
        : '';
    return { status: error.httpResponse.status, message };
  }
  return { status: 0, message: error instanceof Error ? error.message : '' };
}

function providerErrorMessage(error, apiKey) {
  const { status, message } = getProviderErrorDetails(error);
  const detail = message
    .replaceAll(apiKey, '[مفتاح مخفي]')
    .replace(/hf_[A-Za-z0-9]+/g, '[مفتاح مخفي]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [مفتاح مخفي]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);

  if (status === 401 || status === 403) {
    return 'رفض Hugging Face الطلب. تحقّق من صلاحية HUGGINGFACE_API_KEY وإذن Inference Providers وإتاحة Fal لحسابك.';
  }
  if (status === 402 || /insufficient.*(credit|balance)|payment required/i.test(detail)) {
    return 'رفض Hugging Face الطلب بسبب الرصيد أو إعداد مزوّد Fal. لم يتم تفعيل فوترة أو اختيار مزوّد آخر.';
  }
  if (status === 429) {
    return 'وصل طلب تعديل الصورة إلى حد الاستخدام لدى Hugging Face أو Fal. حاول لاحقاً أو تحقق من حدود حسابك.';
  }
  if (/permission|not authorized|access denied|enable.*provider|provider.*not enabled/i.test(detail)) {
    return `تعذّر استخدام Fal لهذا النموذج بسبب صلاحية أو إعداد مطلوب في حساب Hugging Face.${detail ? ` التفاصيل: ${detail}` : ''}`;
  }
  if (
    /no inference provider|not supported by any provider|provider.*not available|model.*not available|not deployed|not supported for task/i.test(detail) ||
    error instanceof InferenceClientInputError ||
    error instanceof InferenceClientRoutingError ||
    status === 404 ||
    status === 410
  ) {
    return 'تعذّر توجيه Qwen/Qwen-Image-Edit إلى مزوّد fal-ai. تحقّق من إتاحة النموذج ومزوّد Fal في Hugging Face.';
  }
  if (status >= 500 || error instanceof InferenceClientHubApiError) {
    return `خدمة Hugging Face أو مزوّد Fal غير متاحة مؤقتاً.${detail ? ` التفاصيل: ${detail}` : ''}`;
  }
  if (detail) return `رفض مزوّد Fal تعديل الصورة: ${detail}`;
  return 'تعذّر تعديل الصورة عبر مزوّد Fal. تحقق من إعداد Inference Providers ثم حاول مرة أخرى.';
}

export async function editImageWithHuggingFace({ apiKey, image, prompt, signal }) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 2000) {
    throw new HuggingFaceImageError(400, 'اكتب وصف التعديل، وبحد أقصى 2000 حرف.');
  }
  const { mimeType, imageBuffer } = parseImageDataUrl(image);
  if (!apiKey) {
    throw new HuggingFaceImageError(503, 'أضف HUGGINGFACE_API_KEY إلى ملف .env لتفعيل تعديل الصور.');
  }

  const client = new InferenceClient(apiKey);
  let editedImage;
  try {
    editedImage = await client.imageToImage(
      {
        provider,
        model: modelId,
        inputs: new Blob([imageBuffer], { type: mimeType }),
        parameters: {
          prompt: [
            'Edit the provided image according to the user instruction.',
            'Preserve the identity, face, facial features, pose, clothing, lighting, and composition unless the user explicitly asks to change them.',
            `User instruction: ${prompt.trim()}`
          ].join(' ')
        }
      },
      {
        retry_on_error: false,
        signal: signal
          ? AbortSignal.any([AbortSignal.timeout(120000), signal])
          : AbortSignal.timeout(120000)
      }
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? new Error('تم إيقاف المهمة.');
    const status = error instanceof InferenceClientProviderApiError ||
      error instanceof InferenceClientHubApiError
      ? error.httpResponse.status
      : 0;
    console.error('Hugging Face Fal image request failed. HTTP status:', status || 'unavailable');
    const responseStatus = status === 401 || status === 402 || status === 403 || status === 429
      ? status
      : status >= 500 || error instanceof InferenceClientHubApiError ||
        error instanceof InferenceClientInputError ||
        error instanceof InferenceClientRoutingError
        ? 503
        : 502;
    throw new HuggingFaceImageError(responseStatus, providerErrorMessage(error, apiKey));
  }

  const outputMimeType = editedImage.type?.split(';')[0].trim().toLowerCase();
  if (!supportedImageTypes.has(outputMimeType)) {
    throw new HuggingFaceImageError(502, 'أعاد مزوّد Fal استجابة ليست صورة PNG أو JPEG أو WebP.');
  }
  if (editedImage.size > maxOutputBytes) {
    throw new HuggingFaceImageError(502, 'حجم الصورة الناتجة من Hugging Face أكبر من الحد المسموح.');
  }

  const output = Buffer.from(await editedImage.arrayBuffer());
  if (output.length === 0 || !matchesImageSignature(output, outputMimeType)) {
    throw new HuggingFaceImageError(502, 'تعذّر التحقق من الصورة الناتجة من مزوّد Fal.');
  }

  return {
    image: `data:${outputMimeType};base64,${output.toString('base64')}`,
    mimeType: outputMimeType,
    model: modelId,
    provider
  };
}
