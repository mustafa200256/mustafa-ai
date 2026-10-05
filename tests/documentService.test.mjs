import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { extractDocument, DocumentServiceError } from '../services/documentService.mjs';
import { createAccountMemoryService } from '../services/accountMemoryService.mjs';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content);
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBuffer);
    localOffset += localHeader.length + nameBuffer.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(Object.keys(files).length, 8);
  endRecord.writeUInt16LE(Object.keys(files).length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function makeFile(name, mimeType, buffer) {
  return { name, mimeType, data: buffer.toString('base64') };
}

function createPdf(text) {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf);
}

const originalFetch = globalThis.fetch;
const originalGeminiKey = process.env.GEMINI_API_KEY;
const originalPort = process.env.PORT;
const originalDataDirectory = process.env.DATA_DIR;
const originalGoogleSearchGroundingFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
const originalSmtpEnvironment = Object.fromEntries(
  ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'APP_BASE_URL']
    .map((key) => [key, process.env[key]])
);
const testDataDirectory = mkdtempSync(path.join(tmpdir(), 'mustafa-ai-server-test-'));
const requests = [];
let holdImageAnalysisRequest = false;
let imageAnalysisStarted;
let activeImageAnalysisSignal;
let transientStreamFailures = 0;
let forcedStreamStatus = 0;
let partialStreamFailures = 0;
let forcedInteractionStatus = 0;
let forcedTranscriptionFailure = false;
process.env.GEMINI_API_KEY = 'test-only-key';
process.env.DATA_DIR = testDataDirectory;
process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = 'true';
for (const key of Object.keys(originalSmtpEnvironment)) delete process.env[key];
const seedMail = [];
const seedService = await createAccountMemoryService({
  dataDirectory: testDataDirectory,
  appBaseUrl: 'https://mustafa.example',
  smtp: {
    host: 'smtp.example',
    port: 587,
    secure: false,
    user: 'smtp-user',
    password: 'smtp-password',
    from: 'Mustafa AI <noreply@example.test>'
  },
  mailTransporter: {
    async sendMail(message) {
      seedMail.push(message);
    }
  }
});
await seedService.register({ email: 'first@example.test', password: 'first-password-123' });
const verificationToken = new URL(seedMail.at(-1).text.match(/https:\/\/\S+/)[0]).searchParams.get('verify');
seedService.verifyEmail(verificationToken);
const firstAccount = await seedService.login({ email: 'first@example.test', password: 'first-password-123' });
seedService.saveMemory(firstAccount.user.id, 'اسمي مصطفى');
await seedService.register({ email: 'second@example.test', password: 'second-password-123' });
const secondVerificationToken = new URL(seedMail.at(-1).text.match(/https:\/\/\S+/)[0]).searchParams.get('verify');
seedService.verifyEmail(secondVerificationToken);
const secondAccount = await seedService.login({ email: 'second@example.test', password: 'second-password-123' });
seedService.close();
const portProbe = createNetServer();
await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
process.env.PORT = String(portProbe.address().port);
await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  requests.push({ url: String(url), body });
  if (String(url).endsWith('/v1beta/interactions')) {
    if (forcedInteractionStatus) {
      return new Response(JSON.stringify({
        error: { code: forcedInteractionStatus, message: 'grounding unavailable' }
      }), { status: forcedInteractionStatus });
    }
    if (body.stream) {
      const answer = 'معلومة حديثة من الويب.';
      const events = [
        { event_type: 'step.start', step: { type: 'google_search_call' } },
        { event_type: 'step.start', step: { type: 'model_output' } },
        {
          event_type: 'step.delta',
          delta: {
            type: 'text',
            text: answer,
            annotations: [{
              type: 'url_citation',
              title: 'مصدر تجريبي',
              url: 'https://example.test/news',
              start_index: 0,
              end_index: 8
            }]
          }
        },
        { event_type: 'interaction.completed', interaction: { status: 'completed' } }
      ];
      return new Response(events.map((event) => `event:${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }
    return new Response(JSON.stringify({
      interaction: {
        steps: [{
          type: 'model_output',
          content: [{
            type: 'text',
            text: 'إجابة حديثة مع مصدر.',
            annotations: [{
              type: 'url_citation',
              title: 'مصدر تجريبي',
              url: 'https://example.test/article',
              start_index: 0,
              end_index: 11
            }]
          }]
        }, {
          type: 'google_search_call',
          arguments: { queries: ['اختبار بحث Google'] }
        }]
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  const audioPart = body.contents?.at(-1)?.parts?.find((part) =>
    part.inline_data?.mime_type?.startsWith('audio/')
  );
  if (audioPart) {
    if (forcedTranscriptionFailure) {
      return new Response(JSON.stringify({ error: { message: 'temporary transcription failure' } }), { status: 503 });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'هذا اختبار باللهجة العراقية.' }] } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (String(url).includes(':streamGenerateContent')) {
    if (forcedStreamStatus) {
      return new Response(JSON.stringify({ error: { message: 'request rejected' } }), { status: forcedStreamStatus });
    }
    if (transientStreamFailures > 0) {
      transientStreamFailures -= 1;
      return new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), { status: 503 });
    }
    if (partialStreamFailures > 0) {
      partialStreamFailures -= 1;
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'جزء غير مكتمل' }] } }]
          })}\n\n`));
          setTimeout(() => controller.error(new Error('connection reset')), 20);
        }
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    const streamEvents = [
      { candidates: [{ content: { parts: [{ text: 'إجابة ' }] } }] },
      { candidates: [{ content: { parts: [{ text: '**تدريجية** و`منسقة`.' }] }, finishReason: 'STOP' }] }
    ];
    return new Response(streamEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  }
  if (
    holdImageAnalysisRequest &&
    body.system_instruction?.parts?.[0]?.text.includes('حلّل الصورة المرفقة')
  ) {
    activeImageAnalysisSignal = options.signal;
    imageAnalysisStarted?.();
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }
  if (body.system_instruction?.parts?.[0]?.text.includes('مخطط أدوات محدود')) {
    const planningRequest = body.contents.at(-1).parts[0].text;
    const candidates = planningRequest
      .match(/الأدوات المتاحة لهذه المهمة:\s*([^\n]+)/u)?.[1]
      ?.split(', ')
      .filter(Boolean) ?? [];
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ tools: candidates }) }] } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (String(url).includes('gemini-3.1-flash-image')) {
    return new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [
            { text: 'تم تعديل الصورة.' },
            { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uN8AAAAASUVORK5CYII=' } }
          ]
        }
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'إجابة اختبارية.' }] } }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { server } = await import('../server.mjs');
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  globalThis.fetch = originalFetch;
  if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiKey;
  if (originalPort === undefined) delete process.env.PORT;
  else process.env.PORT = originalPort;
  if (originalDataDirectory === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDirectory;
  if (originalGoogleSearchGroundingFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = originalGoogleSearchGroundingFlag;
  for (const [key, value] of Object.entries(originalSmtpEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testDataDirectory, { recursive: true, force: true });
});

function postJson(route, payload, extraHeaders = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: route,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        ...extraHeaders
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
            headers: response.headers
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

function postNdjson(route, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: route,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        ...extraHeaders
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try {
          resolve({
            status: response.statusCode,
            events: text.split('\n').filter(Boolean).map((line) => JSON.parse(line)),
            headers: response.headers
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

function putJson(route, payload, extraHeaders = {}) {
  return postJson(route, payload, extraHeaders, 'PUT');
}

function getJson(route, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: route, headers: extraHeaders }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

test('regular chat still uses the existing Gemini chat flow', async () => {
  const result = await postJson('/api/chat', { message: 'رسالة عادية', history: [], category: 'general' });
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'إجابة اختبارية.');
  assert.equal(requests.at(-1).body.contents.at(-1).parts[0].text, 'رسالة عادية');
});

test('audio transcription accepts supported audio and returns Arabic speech as editable text', async () => {
  const result = await postJson('/api/transcribe', {
    mimeType: 'audio/webm;codecs=opus',
    audioBase64: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString('base64')
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.text, 'هذا اختبار باللهجة العراقية.');
  const providerRequest = requests.at(-1);
  assert.match(providerRequest.url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(providerRequest.body.contents.at(-1).parts.at(-1).inline_data.mime_type, 'audio/webm');
  assert.equal(providerRequest.body.contents.at(-1).parts.at(-1).inline_data.data, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString('base64'));
  assert.match(providerRequest.body.system_instruction.parts[0].text, /اللهجة العراقية/);
});

test('audio transcription supports consecutive WAV, MP3, WebM, and M4A requests', async () => {
  const audioBase64 = Buffer.from([1, 2, 3, 4]).toString('base64');
  for (const [mimeType, expectedMimeType] of [
    ['audio/wav', 'audio/wav'],
    ['audio/mpeg', 'audio/mpeg'],
    ['audio/webm', 'audio/webm'],
    ['audio/mp4', 'audio/mp4']
  ]) {
    const result = await postJson('/api/transcribe', { mimeType, audioBase64 });
    assert.equal(result.status, 200);
    assert.equal(requests.at(-1).body.contents.at(-1).parts.at(-1).inline_data.mime_type, expectedMimeType);
  }
});

test('audio transcription rejects empty and unsupported recordings without calling Gemini', async () => {
  const requestCount = requests.length;
  const empty = await postJson('/api/transcribe', { mimeType: 'audio/wav', audioBase64: '' });
  const unsupported = await postJson('/api/transcribe', {
    mimeType: 'application/octet-stream',
    audioBase64: Buffer.from([1, 2]).toString('base64')
  });
  assert.equal(empty.status, 400);
  assert.equal(unsupported.status, 400);
  assert.equal(requests.length, requestCount);
});

test('audio transcription enforces the 8 MiB backend limit', async () => {
  const audioBase64 = Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64');
  const result = await postJson('/api/transcribe', { mimeType: 'audio/wav', audioBase64 });
  assert.equal(result.status, 413);
  assert.match(result.body.error, /8 ميغابايت/u);
});

test('Gemini transcription failures return a safe error for the browser speech fallback', async () => {
  forcedTranscriptionFailure = true;
  try {
    const result = await postJson('/api/transcribe', {
      mimeType: 'audio/mp4',
      audioBase64: Buffer.from([1, 2, 3]).toString('base64')
    });
    assert.equal(result.status, 502);
    assert.match(result.body.error, /الإملاء الصوتي في المتصفح/u);
    assert.equal(JSON.stringify(result.body).includes('GEMINI_API_KEY'), false);
  } finally {
    forcedTranscriptionFailure = false;
  }
});

test('chat streams Gemini text and retries transient provider failures at most twice', async () => {
  const requestCount = requests.length;
  transientStreamFailures = 2;
  const result = await postNdjson('/api/chat', {
    message: 'اعطني رداً تدريجياً',
    history: [],
    category: 'general',
    stream: true
  });
  assert.equal(result.status, 200);
  assert.equal(result.events.at(-1).type, 'result');
  assert.equal(result.events.at(-1).reply, 'إجابة **تدريجية** و`منسقة`.');
  assert.equal(result.events.filter((event) => event.type === 'delta').length, 2);
  assert.equal(requests.length, requestCount + 3);
  assert.match(requests.at(-1).url, /:streamGenerateContent\?alt=sse$/);
});

test('chat does not retry non-transient provider permission failures', async () => {
  const requestCount = requests.length;
  forcedStreamStatus = 403;
  try {
    const result = await postNdjson('/api/chat', {
      message: 'سؤال بصلاحيات غير متاحة',
      history: [],
      stream: true
    });
    assert.equal(result.status, 200);
    assert.equal(result.events.at(-1).type, 'error');
    assert.equal(requests.length, requestCount + 1);
  } finally {
    forcedStreamStatus = 0;
  }
});

test('chat streaming stops after two additional transient retries', async () => {
  const requestCount = requests.length;
  transientStreamFailures = 3;
  const result = await postNdjson('/api/chat', {
    message: 'سؤال مؤقت الفشل',
    history: [],
    stream: true
  });
  assert.equal(result.events.at(-1).type, 'error');
  assert.equal(
    requests.slice(requestCount).filter(({ url }) => url.includes(':streamGenerateContent')).length,
    3
  );
});

test('stream retry resets partial text before emitting the retried answer', async () => {
  partialStreamFailures = 1;
  const result = await postNdjson('/api/chat', {
    message: 'أعد الاتصال بعد انقطاع مؤقت',
    history: [],
    stream: true
  });
  assert.equal(result.events.at(-1).type, 'result');
  assert.equal(result.events.some((event) => event.type === 'reset'), true);
  assert.equal(result.events.at(-1).reply, 'إجابة **تدريجية** و`منسقة`.');
});

test('AI modes add bounded contextual guidance without changing the Gemini model', async () => {
  const expectedGuidance = {
    general: null,
    coding: /ركّز على البرمجة وتصحيح الأخطاء وشرح الكود/,
    study: /ركّز على التعليم التدريجي/,
    writing: /ركّز على الكتابة وإعادة الصياغة/,
    analysis: /حلّل المعلومات والمشاكل بتأنٍ/,
    creative: /ركّز على توليد أفكار ومحتوى إبداعي/
  };

  for (const [aiMode, guidance] of Object.entries(expectedGuidance)) {
    const result = await postJson('/api/chat', {
      message: 'سؤال اختبار',
      history: [],
      category: 'general',
      aiMode
    });
    assert.equal(result.status, 200);
    const request = requests.at(-1);
    assert.match(request.url, /gemini-3\.8-flash:generateContent$/);
    const systemPrompt = request.body.system_instruction.parts[0].text;
    if (guidance) assert.match(systemPrompt, guidance);
    else assert.doesNotMatch(systemPrompt, /وضع المساعد المختار هو توجيه سياقي/);
  }

  const invalidMode = await postJson('/api/chat', {
    message: 'سؤال اختبار',
    history: [],
    aiMode: 'replace-system-prompt'
  });
  assert.equal(invalidMode.status, 400);
});

test('agent mode with no required tools answers without creating an unnecessary tool plan', async () => {
  const requestCount = requests.length;
  const result = await postNdjson('/api/agent', {
    message: 'ما عاصمة العراق؟',
    history: [],
    category: 'general',
    aiMode: 'general'
  });
  assert.equal(result.status, 200);
  assert.equal(result.events.at(-1).type, 'result');
  assert.equal(result.events.at(-1).reply, 'إجابة **تدريجية** و`منسقة`.');
  assert.deepEqual(result.events.at(-1).steps, []);
  assert.equal(requests.length, requestCount + 1);
});

test('agent analyzes an uploaded file and grounds its web search with citations', async () => {
  const result = await postNdjson('/api/agent', {
    message: 'حلل هذا الملف وابحث على الإنترنت عن المعلومات الناقصة',
    history: [],
    category: 'general',
    aiMode: 'analysis',
    file: makeFile('notes.txt', 'text/plain', Buffer.from('حقائق الملف للاختبار'))
  });
  assert.equal(result.status, 200);
  const final = result.events.at(-1);
  assert.equal(final.type, 'result');
  assert.deepEqual(final.steps, [
    { tool: 'تحليل الملف', status: 'ok' },
    { tool: 'البحث على الإنترنت', status: 'ok' }
  ]);
  assert.equal(final.sources[0].url, 'https://example.test/article');
  assert.equal(result.events.some((event) => event.status === '📚 أراجع نتائج البحث...'), true);
  const synthesisRequest = requests.at(-1).body;
  const synthesisText = synthesisRequest.contents.at(-1).parts[0].text;
  assert.match(synthesisText, /حقائق الملف للاختبار/);
  assert.match(synthesisText, /البحث على الإنترنت/);
  assert.match(synthesisText, /إجابة حديثة مع مصدر/);
  assert.equal(requests.some(({ url, body }) => url.endsWith('/v1beta/interactions') &&
    body.tools?.some((tool) => tool.type === 'google_search')), true);
});

test('agent analyzes and edits only an explicitly requested uploaded image', async () => {
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uN8AAAAASUVORK5CYII=';
  const analysis = await postNdjson('/api/agent', {
    message: 'اشرح محتوى الصورة',
    history: [],
    category: 'general',
    image: { mimeType: 'image/png', imageBase64 }
  });
  assert.equal(analysis.events.at(-1).type, 'result');
  assert.deepEqual(analysis.events.at(-1).steps, [{ tool: 'تحليل الصورة', status: 'ok' }]);
  assert.equal(requests.some(({ body }) =>
    body.contents?.at(-1)?.parts?.some((part) => part.inline_data?.data === imageBase64)
  ), true);

  const edit = await postNdjson('/api/agent', {
    message: 'غيّر الخلفية إلى الليل',
    history: [],
    category: 'general',
    image: { mimeType: 'image/png', imageBase64 }
  });
  assert.equal(edit.events.at(-1).type, 'result');
  assert.equal(edit.events.at(-1).steps[0].tool, 'تعديل الصورة');
  assert.equal(edit.events.at(-1).image.mimeType, 'image/png');
});

test('disconnecting during an agent tool aborts the provider request', async () => {
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uN8AAAAASUVORK5CYII=';
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  let notifyAbort;
  const aborted = new Promise((resolve) => { notifyAbort = resolve; });
  holdImageAnalysisRequest = true;
  imageAnalysisStarted = notifyStarted;

  const body = Buffer.from(JSON.stringify({
    message: 'اشرح محتوى الصورة',
    history: [],
    image: { mimeType: 'image/png', imageBase64 }
  }));
  const request = httpRequest({
    hostname: '127.0.0.1',
    port,
    path: '/api/agent',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
  }, (response) => {
    response.on('data', (chunk) => {
      if (chunk.toString().includes('أفحص الصورة')) request.destroy();
    });
  });
  request.on('error', () => {});
  request.end(body);

  const abortWatch = setInterval(() => {
    if (activeImageAnalysisSignal?.aborted) notifyAbort();
  }, 5);
  try {
    await Promise.race([
      Promise.all([started, aborted]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Agent cancellation timed out')), 2000))
    ]);
    assert.equal(activeImageAnalysisSignal.aborted, true);
  } finally {
    clearInterval(abortWatch);
    holdImageAnalysisRequest = false;
    imageAnalysisStarted = null;
    activeImageAnalysisSignal = null;
    request.destroy();
  }
});

test('agent validates uploaded images and never accepts frontend tool calls', async () => {
  const forgedTools = await postJson('/api/agent', {
    message: 'سؤال',
    history: [],
    tools: ['execute_shell']
  });
  assert.equal(forgedTools.status, 400);

  const invalidImage = await postJson('/api/agent', {
    message: 'اشرح محتوى الصورة',
    history: [],
    image: { mimeType: 'image/png', imageBase64: Buffer.from('not an image').toString('base64') }
  });
  assert.equal(invalidImage.status, 400);
});

test('account memory is unavailable without a verified account and SMTP configuration', async () => {
  const status = await getJson('/api/auth/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { emailConfigured: false });
  const memories = await getJson('/api/memories');
  assert.equal(memories.status, 401);
});

test('account registration stays closed until SMTP is configured and rejects cross-origin writes', async () => {
  const crossOrigin = await postJson('/api/auth/register', {
    email: 'someone@example.test',
    password: 'long-test-password'
  }, { Origin: 'https://attacker.example' });
  assert.equal(crossOrigin.status, 403);

  const unavailable = await postJson('/api/auth/register', {
    email: 'someone@example.test',
    password: 'long-test-password'
  });
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.body.error, /SMTP/);
});

test('assistant preferences are authenticated, account-scoped, and applied without accepting system prompt overrides', async () => {
  assert.equal((await getJson('/api/assistant-preferences')).status, 401);
  assert.equal((await putJson('/api/assistant-preferences', { preferences: {} })).status, 401);

  const firstLogin = await postJson('/api/auth/login', {
    email: 'first@example.test',
    password: 'first-password-123'
  });
  const secondLogin = await postJson('/api/auth/login', {
    email: 'second@example.test',
    password: 'second-password-123'
  });
  const firstCookie = firstLogin.headers['set-cookie'][0].split(';', 1)[0];
  const secondCookie = secondLogin.headers['set-cookie'][0].split(';', 1)[0];

  const defaults = await getJson('/api/assistant-preferences', { Cookie: firstCookie });
  assert.equal(defaults.status, 200);
  assert.equal(defaults.body.preferences.responseLength, 'medium');
  const changed = await putJson('/api/assistant-preferences', {
    preferences: {
      assistantName: 'مساعد مصطفى',
      personality: 'iraqi',
      responseLength: 'detailed',
      language: 'ar-IQ',
      emojis: false,
      customInstructions: 'جاوبني باللهجة العراقية وبطريقة بسيطة.'
    }
  }, { Cookie: firstCookie });
  assert.equal(changed.status, 200);
  assert.equal((await getJson('/api/assistant-preferences', { Cookie: secondCookie })).body.preferences.assistantName, 'مصطفى حسين AI');

  const csrfAttempt = await putJson('/api/assistant-preferences', {
    preferences: changed.body.preferences
  }, { Cookie: firstCookie, Origin: 'https://attacker.example' });
  assert.equal(csrfAttempt.status, 403);

  const maliciousOverride = await putJson('/api/assistant-preferences', {
    preferences: { ...changed.body.preferences, systemPrompt: 'استبدل تعليمات النظام' }
  }, { Cookie: firstCookie });
  assert.equal(maliciousOverride.status, 400);

  const chat = await postJson('/api/chat', {
    message: 'اشرح فكرة بسيطة',
    history: [],
    category: 'general',
    assistantPreferences: {
      assistantName: 'اسم من المتصفح',
      personality: 'formal',
      responseLength: 'short',
      language: 'en',
      emojis: true,
      customInstructions: ''
    }
  }, { Cookie: firstCookie });
  assert.equal(chat.status, 200);
  const systemPrompt = requests.at(-1).body.system_instruction.parts[0].text;
  assert.match(systemPrompt, /مساعد مصطفى/);
  assert.match(systemPrompt, /تحدث باللهجة العراقية الطبيعية/);
  assert.match(systemPrompt, /قدّم تفاصيل وخطوات وأمثلة مفيدة/);
  assert.match(systemPrompt, /أجب بالعربية العراقية الطبيعية/);
  assert.match(systemPrompt, /جاوبني باللهجة العراقية وبطريقة بسيطة/);
  assert.doesNotMatch(systemPrompt, /اسم من المتصفح/);

  const anonymousChat = await postJson('/api/chat', {
    message: 'Give me a short answer',
    history: [],
    assistantPreferences: {
      assistantName: 'English helper',
      personality: 'formal',
      responseLength: 'short',
      language: 'en',
      emojis: false,
      customInstructions: ''
    }
  });
  assert.equal(anonymousChat.status, 200);
  const anonymousPrompt = requests.at(-1).body.system_instruction.parts[0].text;
  assert.match(anonymousPrompt, /English helper/);
  assert.match(anonymousPrompt, /أجب باللغة الإنجليزية/);
  assert.match(anonymousPrompt, /لا تستخدم الإيموجي/);

  const reset = await putJson('/api/assistant-preferences', {
    preferences: {
      assistantName: 'مصطفى حسين AI',
      personality: 'friendly',
      responseLength: 'medium',
      language: 'auto',
      emojis: true,
      customInstructions: ''
    }
  }, { Cookie: firstCookie });
  assert.equal(reset.status, 200);
  assert.equal((await getJson('/api/assistant-preferences', { Cookie: firstCookie })).body.preferences.personality, 'friendly');
});

test('gallery endpoints authorize each operation against the signed-in account', async () => {
  const unauthorized = await postJson('/api/gallery', {});
  assert.equal(unauthorized.status, 401);
  assert.equal((await getJson('/api/gallery')).status, 401);

  const firstLogin = await postJson('/api/auth/login', {
    email: 'first@example.test',
    password: 'first-password-123'
  });
  const secondLogin = await postJson('/api/auth/login', {
    email: 'second@example.test',
    password: 'second-password-123'
  });
  const firstCookie = firstLogin.headers['set-cookie'][0].split(';', 1)[0];
  const secondCookie = secondLogin.headers['set-cookie'][0].split(';', 1)[0];
  const image = await postJson('/api/gallery', {
    mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uN8AAAAASUVORK5CYII=',
    thumbnail: '/9j/2Q==',
    prompt: 'تعديل تجريبي',
    source: 'editor-edit'
  }, { Cookie: firstCookie });
  assert.equal(image.status, 201);

  const firstGallery = await getJson('/api/gallery', { Cookie: firstCookie });
  const secondGallery = await getJson('/api/gallery', { Cookie: secondCookie });
  assert.equal(firstGallery.body.images.length, 1);
  assert.equal(secondGallery.body.images.length, 0);
  const imageId = image.body.image.id;
  assert.equal((await getJson(`/api/gallery/${imageId}`, { Cookie: secondCookie })).status, 404);
  const csrfAttempt = await postJson('/api/gallery', {
    mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uN8AAAAASUVORK5CYII=',
    thumbnail: '/9j/2Q==',
    prompt: '',
    source: 'generated'
  }, { Cookie: firstCookie, Origin: 'https://attacker.example' });
  assert.equal(csrfAttempt.status, 403);
  assert.equal((await postJson('/api/gallery', {
    mimeType: 'image/png',
    data: 'dGVzdA==',
    thumbnail: '/9j/2Q==',
    prompt: '',
    source: 'generated'
  }, { Cookie: firstCookie })).status, 400);
  assert.equal((await postJson(`/api/gallery/${imageId}`, {}, { Cookie: secondCookie }, 'DELETE')).status, 404);
  assert.equal((await postJson(`/api/gallery/${imageId}`, {}, { Cookie: firstCookie }, 'DELETE')).body.deleted, true);
});

test('chat recalls verified account memory but does not expose it to another account', async () => {
  const firstLogin = await postJson('/api/auth/login', {
    email: 'first@example.test',
    password: 'first-password-123'
  });
  const secondLogin = await postJson('/api/auth/login', {
    email: 'second@example.test',
    password: 'second-password-123'
  });
  assert.equal(firstLogin.status, 200);
  assert.equal(firstLogin.headers['set-cookie'][0].includes('HttpOnly'), true);
  assert.equal(firstLogin.headers['set-cookie'][0].includes('SameSite=Strict'), true);
  const firstCookie = firstLogin.headers['set-cookie'][0].split(';', 1)[0];
  const secondCookie = secondLogin.headers['set-cookie'][0].split(';', 1)[0];
  const firstResponse = await postJson('/api/chat', {
    message: 'شنو اسمي؟',
    history: [],
    category: 'general'
  }, { Cookie: firstCookie });
  assert.equal(firstResponse.status, 200);
  assert.ok(requests.at(-1).body.system_instruction.parts[0].text.includes('اسمي مصطفى'));

  const secondResponse = await postJson('/api/chat', {
    message: 'شنو اسمي؟',
    history: [],
    category: 'general'
  }, { Cookie: secondCookie });
  assert.equal(secondResponse.status, 200);
  assert.ok(!requests.at(-1).body.system_instruction.parts[0].text.includes('اسمي مصطفى'));
  assert.equal((await getJson('/api/memories', { Cookie: firstCookie })).body.memories.length, 1);
  assert.deepEqual((await getJson('/api/memories', { Cookie: secondCookie })).body.memories, []);
});

test('web search endpoint uses Gemini Google Search Grounding and returns cited sources', async () => {
  const result = await postJson('/api/web-search', {
    query: 'ما آخر الأخبار؟',
    history: [],
    category: 'general'
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.reply, 'إجابة حديثة مع مصدر.');
  assert.equal(result.body.searchPerformed, true);
  assert.equal(result.body.sources[0].title, 'مصدر تجريبي');
  assert.equal(result.body.sources[0].url, 'https://example.test/article');
  const interactionRequest = requests.at(-1);
  assert.match(interactionRequest.url, /\/v1beta\/interactions$/);
  assert.deepEqual(interactionRequest.body.tools, [{ type: 'google_search' }]);
  assert.equal(interactionRequest.body.store, false);
  assert.equal(interactionRequest.body.model, 'gemini-3.8-flash');
});

test('web search endpoint validates empty queries without calling chat providers', async () => {
  const requestCount = requests.length;
  const result = await postJson('/api/web-search', { query: ' ' });
  assert.equal(result.status, 400);
  assert.deepEqual(result.body.sources, []);
  assert.equal(requests.length, requestCount);
});

test('search state does not leak across consecutive searched and ordinary messages', async () => {
  const requestCount = requests.length;
  const firstSearch = await postJson('/api/web-search', {
    query: 'آخر خبر تقني',
    history: [],
    category: 'general'
  });
  const ordinaryChat = await postJson('/api/chat', {
    message: 'اشرح مفهوم الذاكرة المؤقتة',
    history: [],
    category: 'general'
  });
  const secondSearch = await postJson('/api/web-search', {
    query: 'تحديث الطقس لهذا الأسبوع',
    history: [],
    category: 'general'
  });
  const newRequests = requests.slice(requestCount);
  assert.equal(firstSearch.status, 200);
  assert.equal(ordinaryChat.status, 200);
  assert.equal(secondSearch.status, 200);
  assert.equal(newRequests.filter(({ url }) => url.endsWith('/v1beta/interactions')).length, 2);
  assert.equal(newRequests.find(({ url }) => url.includes(':generateContent'))?.body.contents.at(-1).parts[0].text,
    'اشرح مفهوم الذاكرة المؤقتة');
});

test('web search streams Gemini output and grounding citations from ordinary chat', async () => {
  const result = await postNdjson('/api/chat', {
    message: 'ما آخر المستجدات؟',
    history: [],
    category: 'general',
    stream: true,
    webSearchEnabled: true
  });
  assert.equal(result.status, 200);
  assert.equal(result.events.some((event) => event.status === '🔎 أبحث في الويب...'), true);
  assert.equal(result.events.some((event) => event.status === '✅ تم البحث'), true);
  assert.equal(result.events.at(-1).reply, 'معلومة حديثة من الويب.');
  assert.equal(result.events.at(-1).searchPerformed, true);
  assert.equal(result.events.at(-1).sources[0].url, 'https://example.test/news');
});

test('Google Search grounding failures fall back to regular Gemini streaming', async () => {
  forcedInteractionStatus = 403;
  try {
    const result = await postNdjson('/api/chat', {
      message: 'اشرح لي هذا السؤال مع البحث',
      history: [],
      stream: true,
      webSearchEnabled: true
    });
    assert.equal(result.status, 200);
    assert.equal(result.events.some((event) => event.status?.includes('أتابع بإجابة Gemini العادية')), true);
    assert.equal(result.events.at(-1).reply, 'إجابة **تدريجية** و`منسقة`.');
    assert.equal(result.events.at(-1).searchPerformed, false);
    assert.deepEqual(result.events.at(-1).sources, []);
  } finally {
    forcedInteractionStatus = 0;
  }
});

test('Google Search Grounding stays disabled by default to avoid paid-tier requests', async () => {
  const configuredFlag = process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  const requestCount = requests.length;
  delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
  try {
    const result = await postNdjson('/api/chat', {
      message: 'ما آخر المستجدات؟',
      history: [],
      stream: true,
      webSearchEnabled: true
    });
    assert.equal(result.status, 200);
    assert.equal(requests.slice(requestCount).some(({ url }) => url.endsWith('/v1beta/interactions')), false);
    assert.match(result.events.at(-1).searchNotice, /غير مفعّل لتجنب أي تكلفة/u);
    assert.equal(result.events.at(-1).reply, 'إجابة **تدريجية** و`منسقة`.');
  } finally {
    if (configuredFlag === undefined) delete process.env.GOOGLE_SEARCH_GROUNDING_ENABLED;
    else process.env.GOOGLE_SEARCH_GROUNDING_ENABLED = configuredFlag;
  }
});

test('TXT, PDF, DOCX, and XLSX contents are extracted and sent through chat', async (context) => {
  const docx = createZip({
    '[Content_Types].xml': '<Types></Types>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX analysis sample</w:t></w:r></w:p></w:body></w:document>'
  });
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Summary').addRow(['Quarter', 'Revenue']);
  workbook.getWorksheet('Summary').addRow(['Q1', 120]);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const documents = [
    makeFile('notes.txt', 'text/plain', Buffer.from('TXT analysis sample')),
    makeFile('report.pdf', 'application/pdf', createPdf('PDF analysis sample')),
    makeFile('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx),
    makeFile('report.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx)
  ];

  for (const file of documents) {
    await context.test(file.name, async () => {
      const result = await postJson('/api/chat', {
        message: 'لخص هذا الملف',
        history: [],
        category: 'general',
        file
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.reply, 'إجابة اختبارية.');
      const prompt = requests.at(-1).body.contents.at(-1).parts[0].text;
      assert.ok(prompt.includes('محتوى الملف المرفق'));
      assert.ok(prompt.includes('بداية محتوى الملف'));
      assert.ok(prompt.includes(file.name));
      assert.ok(prompt.includes(file.name.endsWith('.txt')
        ? 'TXT analysis sample'
        : file.name.endsWith('.pdf')
          ? 'PDF analysis sample'
          : file.name.endsWith('.docx')
            ? 'DOCX analysis sample'
            : 'Revenue'));
    });
  }
});

test('existing image-edit endpoint remains reachable', async () => {
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uN8AAAAASUVORK5CYII=';
  const result = await postJson('/api/image-edit', {
    prompt: 'اختبار',
    mimeType: 'image/png',
    imageBase64
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.image.mimeType, 'image/png');
});

test('unsupported or mismatched documents are rejected before calling Gemini', async () => {
  const requestCount = requests.length;
  const result = await postJson('/api/chat', {
    message: 'حلل الملف',
    history: [],
    category: 'general',
    file: makeFile('malware.exe', 'application/octet-stream', Buffer.from('not a document'))
  });
  assert.equal(result.status, 415);
  assert.equal(requests.length, requestCount);
});

test('document extraction rejects a MIME mismatch', async () => {
  await assert.rejects(
    extractDocument(makeFile('report.pdf', 'text/plain', Buffer.from('%PDF-1.4'))),
    (error) => error instanceof DocumentServiceError && error.status === 415
  );
});

test('document extraction rejects files over the backend size limit', async () => {
  await assert.rejects(
    extractDocument(makeFile('large.txt', 'text/plain', Buffer.alloc(8 * 1024 * 1024 + 1, 0x61))),
    (error) => error instanceof DocumentServiceError && error.status === 413
  );
});
