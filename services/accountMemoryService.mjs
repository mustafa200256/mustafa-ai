import { randomBytes, scrypt as scryptCallback, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import nodemailer from 'nodemailer';

const scrypt = promisify(scryptCallback);
const wasmPath = fileURLToPath(new URL('../node_modules/sql.js/dist/sql-wasm.wasm', import.meta.url));
const sensitiveContent = /(?:password|passcode|api[\s_-]?key|secret|access[\s_-]?token|phone(?:\s+number)?|telephone|mobile\s+number|home\s+address|date\s+of\s+birth|birthdate|medical\s+history|diagnosis|medication|credit\s+card|social\s+security|national\s+id|كلمة\s*المرور|كلمة\s*السر|باسورد|رمز\s*(?:التحقق|الدخول)|مفتاح\s*(?:api|السر)|بيانات\s*البطاقة|رقم\s*البطاقة|رقم\s*الحساب|رقم\s*الهاتف|رقم\s*تلفون|رقم\s*هويتي|جواز\s*السفر|عنوان(?:ي)?\s*(?:المنزل|البيت)?|تاريخ\s*(?:ميلادي|ولادتي)|حالتي\s*الصحية|مرض[ي]?|دوائ[ي]?|تشخيص[ي]?|حساب[ي]?\s*البنكي)/i;
const sensitiveValue = /\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{16,})\b/;
const sensitiveContactValue = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+?\d[\s().-]*){8,}/;
const stopWords = new Set([
  'انا', 'اني', 'انيه', 'تذكر', 'عن', 'عني', 'شنو', 'ماذا', 'ما', 'هو', 'هي',
  'هذا', 'هذه', 'ذلك', 'المعلومة', 'المعلومات', 'احفظ', 'احفظها', 'لي', 'من', 'في',
  'the', 'my', 'i', 'me', 'what', 'remember', 'about', 'this', 'that', 'please'
]);
export const defaultAssistantPreferences = Object.freeze({
  assistantName: 'مصطفى حسين AI',
  personality: 'friendly',
  responseLength: 'medium',
  language: 'auto',
  emojis: true,
  customInstructions: ''
});
const preferenceOptions = {
  personality: new Set(['friendly', 'formal', 'iraqi', 'technical', 'teacher', 'concise', 'detailed']),
  responseLength: new Set(['short', 'medium', 'detailed']),
  language: new Set(['auto', 'ar', 'ar-IQ', 'en'])
};

export class AccountMemoryError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AccountMemoryError';
    this.status = status;
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function makeToken() {
  return randomBytes(32).toString('base64url');
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function normalizeText(text) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي');
}

function tokens(text) {
  return normalizeText(text)
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.startsWith('ال') && token.length > 3 ? token.slice(2) : token)
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

function detectMemoryIntent(message) {
  const text = message.trim();
  const forget = text.match(/^(?:من\s+فضلك\s+)?(?:انس[َِ]?|انسى|احذف\s+من\s+ذاكرتك|forget)(?:\s+لي)?\s+(.+?)\s*[.!؟?]*$/i);
  if (forget) return { type: 'forget', target: forget[1].trim() };
  if (/^(?:شنو|ماذا|ما)\s+(?:الذي\s+)?(?:تتذكر|تذكر)\s+(?:عني|عنّي|عن\s+حسابي)|^(?:شنو|ماذا)\s+تتذكرني/i.test(text)) {
    return { type: 'recall' };
  }

  let fact = '';
  const leadingInstruction = text.match(/^(?:من\s+فضلك\s+)?(?:تذكر|تذكّر|احفظ)(?:\s+(?:لي|هذا|ذلك))?\s*[:،]?\s*(?:(?:أنني|اني|إني|ان|أن)\s*)?(.+)$/i);
  if (leadingInstruction) fact = leadingInstruction[1];
  if (!fact) {
    const trailingInstruction = text.match(/^(.+?)[،,؛]?\s*(?:تذكر|تذكّر|احفظ)(?:\s+(?:هذا|ذلك))?\s*[.!؟?]*$/i);
    if (trailingInstruction) fact = trailingInstruction[1];
  }
  if (!fact && /^(?:انا|أنا|اني|أني)\s*(?:أفضل|افضل|أحب|احب|ما\s+أحب|لا\s+أحب)|^(?:أفضل|افضل|أحب|احب|ما\s+أحب|لا\s+أحب)|^(?:i\s+prefer|i\s+like)\b/i.test(text)) {
    fact = text;
  }
  if (fact) return { type: 'remember', fact: fact.replace(/^[\s،,:-]+|[\s،,:.!؟?]+$/g, '').trim() };
  return null;
}

function safeMemoryFact(fact) {
  if (!fact || Array.from(fact).length > 300) {
    throw new AccountMemoryError(400, 'الذكرى فارغة أو طويلة جداً. أرسل معلومة موجزة لا تتجاوز 300 حرف.');
  }
  if (sensitiveContent.test(fact) || sensitiveValue.test(fact) || sensitiveContactValue.test(fact)) {
    throw new AccountMemoryError(400, 'لا أحفظ كلمات المرور أو مفاتيح API أو معلومات الهوية والبيانات الحساسة.');
  }
  return fact;
}

export function normalizeAssistantPreferences(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountMemoryError(400, 'إعدادات تخصيص المساعد غير صالحة.');
  }

  const allowedKeys = new Set(Object.keys(defaultAssistantPreferences));
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new AccountMemoryError(400, 'تحتوي الإعدادات على خيار غير مدعوم.');
  }

  const preferences = { ...defaultAssistantPreferences, ...value };
  if (
    typeof preferences.assistantName !== 'string' ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,39}$/u.test(preferences.assistantName.trim())
  ) {
    throw new AccountMemoryError(400, 'اسم المساعد يجب أن يكون من 1 إلى 40 حرفاً أو رقماً.');
  }
  preferences.assistantName = preferences.assistantName.trim();

  if (!preferenceOptions.personality.has(preferences.personality)) {
    throw new AccountMemoryError(400, 'أسلوب الشخصية المختار غير صالح.');
  }
  if (!preferenceOptions.responseLength.has(preferences.responseLength)) {
    throw new AccountMemoryError(400, 'طول الإجابة المختار غير صالح.');
  }
  if (!preferenceOptions.language.has(preferences.language)) {
    throw new AccountMemoryError(400, 'لغة الرد المختارة غير صالحة.');
  }
  if (typeof preferences.emojis !== 'boolean') {
    throw new AccountMemoryError(400, 'إعداد الإيموجي غير صالح.');
  }
  if (
    typeof preferences.customInstructions !== 'string' ||
    Array.from(preferences.customInstructions).length > 600
  ) {
    throw new AccountMemoryError(400, 'التعليمات الخاصة يجب ألا تتجاوز 600 حرف.');
  }
  if (
    sensitiveContent.test(preferences.customInstructions) ||
    sensitiveValue.test(preferences.customInstructions) ||
    sensitiveContactValue.test(preferences.customInstructions)
  ) {
    throw new AccountMemoryError(400, 'لا تحفظ كلمات المرور أو مفاتيح API أو البيانات الحساسة ضمن التعليمات.');
  }
  preferences.customInstructions = preferences.customInstructions.trim();
  return preferences;
}

function safeBaseUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function createAccountMemoryService({
  dataDirectory = process.env.DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data'),
  smtp = {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    from: process.env.SMTP_FROM
  },
  appBaseUrl = process.env.APP_BASE_URL,
  mailTransporter,
  database
} = {}) {
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const databasePath = dataDirectory === ':memory:' ? null : path.join(dataDirectory, 'mustafa-ai.sqlite');
  if (!database && databasePath) mkdirSync(dataDirectory, { recursive: true });
  const db = database || new SQL.Database(
    databasePath && existsSync(databasePath) ? new Uint8Array(readFileSync(databasePath)) : undefined
  );
  db.run('PRAGMA foreign_keys = ON');
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      verified_at INTEGER,
      verification_hash TEXT,
      verification_expires INTEGER,
      reset_hash TEXT,
      reset_expires INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assistant_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      preferences TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gallery_images (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mime_type TEXT NOT NULL,
      image_data BLOB NOT NULL,
      thumbnail_data BLOB NOT NULL,
      prompt TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memories_user_updated ON memories(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS gallery_user_created ON gallery_images(user_id, created_at DESC);
  `);

  const baseUrl = safeBaseUrl(appBaseUrl);
  const smtpReady = Boolean(
    smtp?.host &&
    smtp?.port &&
    smtp?.user &&
    smtp?.password &&
    smtp?.from &&
    baseUrl
  );
  const transporter = smtpReady
    ? mailTransporter || nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: Boolean(smtp.secure),
      auth: { user: smtp.user, pass: smtp.password },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    })
    : null;

  function persist() {
    if (!databasePath) return;
    const temporaryPath = `${databasePath}.tmp`;
    writeFileSync(temporaryPath, Buffer.from(db.export()), { mode: 0o600 });
    renameSync(temporaryPath, databasePath);
  }

  function getOne(sql, values = []) {
    const statement = db.prepare(sql);
    try {
      statement.bind(values);
      return statement.step() ? statement.getAsObject() : null;
    } finally {
      statement.free();
    }
  }

  function getAll(sql, values = []) {
    const statement = db.prepare(sql);
    try {
      statement.bind(values);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  }

  function run(sql, values = []) {
    db.run(sql, values);
  }

  async function sendEmail({ to, subject, text, html }) {
    if (!transporter) {
      throw new AccountMemoryError(503, 'التسجيل بالبريد غير مفعّل بعد. يضبط مسؤول الموقع إعدادات SMTP ورابط الموقع أولاً.');
    }
    try {
      await transporter.sendMail({ from: smtp.from, to, subject, text, html });
    } catch {
      throw new AccountMemoryError(503, 'تعذّر إرسال رسالة التحقق. تحقّق من إعدادات البريد وحاول مرة أخرى.');
    }
  }

  async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
    const hash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return { salt, hash: Buffer.from(hash).toString('hex') };
  }

  function issueUrl(kind, token) {
    const url = new URL('/', `${baseUrl}/`);
    url.searchParams.set(kind, token);
    return url.href;
  }

  function memoryRecord(row) {
    return {
      id: row.id,
      content: row.content,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  function isOwner(userId) {
    return typeof userId === 'string' && Boolean(getOne('SELECT id FROM users WHERE id = ? AND verified_at IS NOT NULL', [userId]));
  }

  function listMemories(userId) {
    if (!isOwner(userId)) throw new AccountMemoryError(401, 'سجّل الدخول لإدارة ذكريات الحساب.');
    return getAll(
      'SELECT id, content, created_at, updated_at FROM memories WHERE user_id = ? ORDER BY updated_at DESC',
      [userId]
    ).map(memoryRecord);
  }

  async function register({ email, password }) {
    if (!smtpReady) {
      throw new AccountMemoryError(503, 'التسجيل بالبريد غير متاح حتى يضبط مسؤول الموقع SMTP ورابط الموقع.');
    }
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
      throw new AccountMemoryError(400, 'أدخل بريداً إلكترونياً صالحاً.');
    }
    if (
      typeof password !== 'string' ||
      Array.from(password).length < 12 ||
      Array.from(password).length > 128
    ) {
      throw new AccountMemoryError(400, 'كلمة المرور يجب أن تكون بين 12 و128 حرفاً.');
    }

    const normalizedEmail = normalizeEmail(email);
    const verificationToken = makeToken();
    const passwordCredentials = await hashPassword(password);
    const userId = randomBytes(16).toString('hex');
    const now = Date.now();
    const expiresAt = now + 30 * 60 * 1000;
    try {
      run(
        `INSERT INTO users (id, email, password_hash, password_salt, verification_hash, verification_expires, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, normalizedEmail, passwordCredentials.hash, passwordCredentials.salt, digest(verificationToken), expiresAt, now]
      );
    } catch (insertError) {
      const existing = getOne(
        'SELECT id, verified_at FROM users WHERE email = ?',
        [normalizedEmail]
      );
      if (!existing) throw insertError;
      if (existing.verified_at) return { accepted: true };
      run(
        'UPDATE users SET verification_hash = ?, verification_expires = ? WHERE id = ?',
        [digest(verificationToken), expiresAt, existing.id]
      );
    }
    persist();

    try {
      const link = issueUrl('verify', verificationToken);
      await sendEmail({
        to: normalizedEmail,
        subject: 'تحقّق من بريدك — مصطفى حسين AI',
        text: `افتح الرابط لإكمال تسجيلك: ${link}\nينتهي الرابط بعد 30 دقيقة.`,
        html: `<p>افتح الرابط لإكمال تسجيلك في مصطفى حسين AI:</p><p><a href="${link}">تأكيد البريد الإلكتروني</a></p><p>ينتهي الرابط بعد 30 دقيقة.</p>`
      });
    } catch (error) {
      if (!(error instanceof AccountMemoryError)) throw error;
      throw error;
    }
    return { accepted: true };
  }

  function verifyEmail(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) {
      throw new AccountMemoryError(400, 'رابط التحقق غير صالح أو منتهي الصلاحية.');
    }
    const user = getOne(
      'SELECT id FROM users WHERE verification_hash = ? AND verification_expires > ? AND verified_at IS NULL',
      [digest(token), Date.now()]
    );
    if (!user) throw new AccountMemoryError(400, 'رابط التحقق غير صالح أو منتهي الصلاحية.');
    run('UPDATE users SET verified_at = ?, verification_hash = NULL, verification_expires = NULL WHERE id = ?', [Date.now(), user.id]);
    persist();
    return { verified: true };
  }

  async function login({ email, password }) {
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new AccountMemoryError(400, 'أدخل البريد الإلكتروني وكلمة المرور.');
    }
    const user = getOne(
      'SELECT id, email, password_hash, password_salt, verified_at FROM users WHERE email = ?',
      [normalizeEmail(email)]
    );
    const credentials = await hashPassword(password, user?.password_salt || 'constant-login-salt');
    if (
      !user ||
      !user.verified_at ||
      !timingSafeEqual(Buffer.from(credentials.hash, 'hex'), Buffer.from(user.password_hash, 'hex'))
    ) {
      throw new AccountMemoryError(401, 'بيانات الدخول غير صحيحة أو لم يتم تأكيد البريد بعد.');
    }

    const sessionToken = makeToken();
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    run('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
    run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', [digest(sessionToken), user.id, expiresAt]);
    persist();
    return {
      token: sessionToken,
      expiresAt,
      user: { id: user.id, email: user.email }
    };
  }

  function userFromSession(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
    const row = getOne(
      `SELECT users.id, users.email
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.verified_at IS NOT NULL`,
      [digest(token), Date.now()]
    );
    return row ? { id: row.id, email: row.email } : null;
  }

  function logout(token) {
    if (typeof token !== 'string') return;
    run('DELETE FROM sessions WHERE token_hash = ?', [digest(token)]);
    persist();
  }

  async function requestPasswordReset(email) {
    if (!smtpReady) {
      throw new AccountMemoryError(503, 'استعادة كلمة المرور غير متاحة حتى يضبط مسؤول الموقع إعدادات البريد.');
    }
    if (typeof email !== 'string' || email.length > 254) return { accepted: true };
    const user = getOne('SELECT id, email FROM users WHERE email = ? AND verified_at IS NOT NULL', [normalizeEmail(email)]);
    if (!user) return { accepted: true };
    const token = makeToken();
    const expiresAt = Date.now() + 30 * 60 * 1000;
    run('UPDATE users SET reset_hash = ?, reset_expires = ? WHERE id = ?', [digest(token), expiresAt, user.id]);
    persist();
    const link = issueUrl('reset', token);
    await sendEmail({
      to: user.email,
      subject: 'استعادة كلمة المرور — مصطفى حسين AI',
      text: `استخدم الرابط لتعيين كلمة مرور جديدة: ${link}\nينتهي الرابط بعد 30 دقيقة.`,
      html: `<p><a href="${link}">تعيين كلمة مرور جديدة</a></p><p>ينتهي الرابط بعد 30 دقيقة.</p>`
    });
    return { accepted: true };
  }

  async function resetPassword({ token, password }) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) {
      throw new AccountMemoryError(400, 'رابط استعادة كلمة المرور غير صالح أو منتهي الصلاحية.');
    }
    if (typeof password !== 'string' || Array.from(password).length < 12 || Array.from(password).length > 128) {
      throw new AccountMemoryError(400, 'كلمة المرور يجب أن تكون بين 12 و128 حرفاً.');
    }
    const user = getOne(
      'SELECT id FROM users WHERE reset_hash = ? AND reset_expires > ? AND verified_at IS NOT NULL',
      [digest(token), Date.now()]
    );
    if (!user) throw new AccountMemoryError(400, 'رابط استعادة كلمة المرور غير صالح أو منتهي الصلاحية.');
    const credentials = await hashPassword(password);
    run(
      'UPDATE users SET password_hash = ?, password_salt = ?, reset_hash = NULL, reset_expires = NULL WHERE id = ?',
      [credentials.hash, credentials.salt, user.id]
    );
    run('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    persist();
    return { reset: true };
  }

  function saveMemory(userId, rawContent) {
    if (!isOwner(userId)) throw new AccountMemoryError(401, 'سجّل الدخول لحفظ الذكريات في حسابك.');
    const content = safeMemoryFact(rawContent);
    const now = Date.now();
    const existing = getOne('SELECT id FROM memories WHERE user_id = ? AND content = ?', [userId, content]);
    if (existing) {
      run('UPDATE memories SET updated_at = ? WHERE id = ? AND user_id = ?', [now, existing.id, userId]);
      persist();
      return { id: existing.id, content, updatedAt: now, createdAt: Number(getOne('SELECT created_at FROM memories WHERE id = ?', [existing.id]).created_at) };
    }
    const id = randomBytes(16).toString('hex');
    run('INSERT INTO memories (id, user_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, userId, content, now, now]);
    run(
      `DELETE FROM memories WHERE user_id = ? AND id NOT IN
       (SELECT id FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50)`,
      [userId, userId]
    );
    persist();
    return { id, content, createdAt: now, updatedAt: now };
  }

  function deleteMemory(userId, memoryId) {
    if (!isOwner(userId)) throw new AccountMemoryError(401, 'سجّل الدخول لإدارة ذكريات الحساب.');
    run('DELETE FROM memories WHERE id = ? AND user_id = ?', [memoryId, userId]);
    persist();
    return { deleted: db.getRowsModified() > 0 };
  }

  function deleteAllMemories(userId) {
    if (!isOwner(userId)) throw new AccountMemoryError(401, 'سجّل الدخول لإدارة ذكريات الحساب.');
    run('DELETE FROM memories WHERE user_id = ?', [userId]);
    const count = db.getRowsModified();
    persist();
    return { deleted: count };
  }

  function getAssistantPreferences(userId) {
    if (!isOwner(userId)) throw new AccountMemoryError(401, 'سجّل الدخول لإدارة تخصيص المساعد في حسابك.');
    const row = getOne('SELECT preferences FROM assistant_preferences WHERE user_id = ?', [userId]);
    return row ? normalizeAssistantPreferences(JSON.parse(row.preferences)) : { ...defaultAssistantPreferences };
  }

  function saveAssistantPreferences(userId, rawPreferences) {
    if (!isOwner(userId)) throw new AccountMemoryError(401, 'سجّل الدخول لحفظ تخصيص المساعد في حسابك.');
    const preferences = normalizeAssistantPreferences(rawPreferences);
    run(
      `INSERT INTO assistant_preferences (user_id, preferences, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET preferences = excluded.preferences, updated_at = excluded.updated_at`,
      [userId, JSON.stringify(preferences), Date.now()]
    );
    persist();
    return preferences;
  }

  function decodeGalleryImage(value, mimeType, maxBytes, label) {
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new AccountMemoryError(400, `${label} غير صالحة.`);
    }
    if (value.length > Math.ceil(maxBytes / 3) * 4) {
      throw new AccountMemoryError(413, `${label} تتجاوز الحجم المسموح.`);
    }
    const data = Buffer.from(value, 'base64');
    if (!data.length || data.length > maxBytes || data.toString('base64') !== value) {
      throw new AccountMemoryError(413, `${label} فارغة أو تتجاوز الحجم المسموح.`);
    }
    const validSignature = mimeType === 'image/png'
      ? data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : mimeType === 'image/jpeg'
        ? data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
        : data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
    if (!validSignature) throw new AccountMemoryError(400, `${label} لا تطابق نوع الصورة المعلن.`);
    return data;
  }

  function galleryImageRecord(row) {
    return {
      id: row.id,
      mimeType: row.mime_type,
      thumbnail: `data:image/jpeg;base64,${Buffer.from(row.thumbnail_data).toString('base64')}`,
      prompt: row.prompt,
      source: row.source,
      createdAt: Number(row.created_at)
    };
  }

  function listGalleryImages(userId) {
    if (!isOwner(userId)) throw new AccountMemoryError(401, 'سجّل الدخول لعرض معرض الصور الخاص بحسابك.');
    return getAll(
      `SELECT id, mime_type, thumbnail_data, prompt, source, created_at
       FROM gallery_images WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    ).map(galleryImageRecord);
  }

  function saveGalleryImage(userId, input = {}) {
    if (!isOwner(userId)) throw new AccountMemoryError(401, 'سجّل الدخول لحفظ الصور في معرض حسابك.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AccountMemoryError(400, 'بيانات الصورة غير صالحة.');
    }
    const allowedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
    if (!allowedMimeTypes.has(input.mimeType)) {
      throw new AccountMemoryError(400, 'نوع الصورة غير مدعوم. استخدم PNG أو JPEG أو WebP.');
    }
    if (typeof input.prompt !== 'string' || Array.from(input.prompt).length > 2000) {
      throw new AccountMemoryError(400, 'وصف تعديل الصورة غير صالح أو طويل جداً.');
    }
    if (!['chat-edit', 'editor-edit', 'generated'].includes(input.source)) {
      throw new AccountMemoryError(400, 'مصدر الصورة غير صالح.');
    }
    const image = decodeGalleryImage(input.data, input.mimeType, 8 * 1024 * 1024, 'الصورة');
    const thumbnail = decodeGalleryImage(input.thumbnail, 'image/jpeg', 256 * 1024, 'الصورة المصغرة');
    const imageId = randomBytes(16).toString('hex');
    const createdAt = Date.now();
    const count = Number(getOne('SELECT COUNT(*) AS count FROM gallery_images WHERE user_id = ?', [userId]).count);
    if (count >= 30) {
      throw new AccountMemoryError(413, 'وصل معرض الصور إلى الحد الأقصى (30 صورة). احذف بعض الصور قبل إضافة صور جديدة.');
    }
    run(
      `INSERT INTO gallery_images
       (id, user_id, mime_type, image_data, thumbnail_data, prompt, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [imageId, userId, input.mimeType, image, thumbnail, input.prompt.trim().slice(0, 2000), input.source, createdAt]
    );
    persist();
    return { id: imageId, mimeType: input.mimeType, createdAt };
  }

  function getGalleryImage(userId, imageId) {
    if (!isOwner(userId)) throw new AccountMemoryError(401, 'سجّل الدخول لعرض الصور المحفوظة في حسابك.');
    const row = getOne(
      'SELECT id, mime_type, image_data, prompt, source, created_at FROM gallery_images WHERE id = ? AND user_id = ?',
      [imageId, userId]
    );
    if (!row) return null;
    return {
      id: row.id,
      mimeType: row.mime_type,
      data: Buffer.from(row.image_data).toString('base64'),
      prompt: row.prompt,
      source: row.source,
      createdAt: Number(row.created_at)
    };
  }

  function deleteGalleryImage(userId, imageId) {
    if (!isOwner(userId)) throw new AccountMemoryError(401, 'سجّل الدخول لإدارة معرض الصور الخاص بحسابك.');
    run('DELETE FROM gallery_images WHERE id = ? AND user_id = ?', [imageId, userId]);
    const deleted = db.getRowsModified() > 0;
    if (deleted) persist();
    return { deleted };
  }

  function deleteMatchingMemory(userId, target) {
    if (!isOwner(userId)) throw new AccountMemoryError(401, 'سجّل الدخول لإدارة الذكريات طويلة المدى.');
    const memories = listMemories(userId);
    if (!memories.length) return { deleted: 0 };
    const targetWords = tokens(target);
    const selected = targetWords.length
      ? memories.filter((memory) => {
        const contentWords = new Set(tokens(memory.content));
        return targetWords.some((word) => contentWords.has(word));
      })
      : memories.slice(0, 1);
    if (!selected.length) return { deleted: 0 };
    const statement = db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?');
    try {
      for (const memory of selected) {
        statement.run([memory.id, userId]);
      }
    } finally {
      statement.free();
    }
    const deleted = selected.length;
    persist();
    return { deleted };
  }

  function relevantMemories(userId, query) {
    if (!isOwner(userId)) return [];
    const memories = listMemories(userId);
    const asksAll = /(?:شنو|ماذا|ما)\s+(?:الذي\s+)?(?:تتذكر|تذكر)\s+(?:عني|عنّي|عن\s+حسابي)|(?:شنو|ماذا)\s+تتذكرني/i.test(query);
    const queryWords = new Set(tokens(query));
    const selected = asksAll
      ? memories
      : memories.filter((memory) => tokens(memory.content).some((word) => queryWords.has(word)));
    return selected.slice(0, 8).map((memory) => memory.content);
  }

  function processMemoryIntent(userId, message, history = []) {
    const intent = detectMemoryIntent(message);
    if (!intent) return null;
    if (!userId || !isOwner(userId)) {
      if (intent.type === 'remember') {
        return {
          action: intent.type,
          reply: 'أقدر أراعي هذه المعلومة ضمن المحادثة الحالية، لكن حفظها بين المحادثات يتطلب تسجيل الدخول وتأكيد البريد.'
        };
      }
      if (intent.type === 'forget') {
        return {
          action: intent.type,
          target: intent.target,
          reply: 'تم. لن أستخدم المعلومة من الآن ضمن سياق هذه المحادثة.'
        };
      }
      const transientMemories = history
        .filter((item) => item?.role === 'user' && typeof item.text === 'string')
        .map((item) => detectMemoryIntent(item.text))
        .filter((item) => item?.type === 'remember')
        .map((item) => item.fact);
      const uniqueMemories = [...new Set(transientMemories)];
      return {
        action: intent.type,
        reply: uniqueMemories.length
          ? `أتذكر من هذه المحادثة:\n${uniqueMemories.map((memory) => `- ${memory}`).join('\n')}`
          : 'لا توجد معلومات طلبت مني تذكرها في سياق هذه المحادثة حتى الآن.'
      };
    }

    if (intent.type === 'remember') {
      const memory = saveMemory(userId, intent.fact);
      return { action: intent.type, reply: 'تم حفظ هذه المعلومة في ذاكرتك. يمكنك مراجعتها أو حذفها من قسم الذاكرة.', memory };
    }
    if (intent.type === 'forget') {
      const result = deleteMatchingMemory(userId, intent.target);
      return {
        action: intent.type,
        target: intent.target,
        reply: result.deleted
          ? 'تم حذف المعلومة المطابقة من ذاكرتك.'
          : 'لم أجد ذكرى مطابقة لحذفها.'
      };
    }
    const memories = listMemories(userId);
    return {
      action: intent.type,
      reply: memories.length
        ? `هذه المعلومات المحفوظة في ذاكرتك:\n${memories.map((memory) => `- ${memory.content}`).join('\n')}`
        : 'لا توجد ذكريات محفوظة في حسابك حالياً.'
    };
  }

  function getStatus() {
    return { emailConfigured: smtpReady };
  }

  return {
    getStatus,
    register,
    verifyEmail,
    login,
    userFromSession,
    logout,
    requestPasswordReset,
    resetPassword,
    listMemories,
    saveMemory,
    deleteMemory,
    deleteAllMemories,
    getAssistantPreferences,
    saveAssistantPreferences,
    listGalleryImages,
    saveGalleryImage,
    getGalleryImage,
    deleteGalleryImage,
    normalizeAssistantPreferences,
    deleteMatchingMemory,
    relevantMemories,
    processMemoryIntent,
    close() {
      db.close();
    }
  };
}

export function extractSessionToken(cookieHeader) {
  if (typeof cookieHeader !== 'string') return null;
  const cookie = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith('mustafa_session='));
  if (!cookie) return null;
  try {
    return decodeURIComponent(cookie.slice('mustafa_session='.length));
  } catch {
    return null;
  }
}

export function sessionCookie(token, { secure = process.env.NODE_ENV === 'production' } = {}) {
  return `mustafa_session=${encodeURIComponent(token)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie({ secure = process.env.NODE_ENV === 'production' } = {}) {
  return `mustafa_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function isSameOriginRequest(request) {
  const origin = request.get('origin');
  if (!origin) return request.get('sec-fetch-site') !== 'cross-site';
  try {
    const parsedOrigin = new URL(origin);
    return parsedOrigin.host === request.get('host') &&
      ['http:', 'https:'].includes(parsedOrigin.protocol);
  } catch {
    return false;
  }
}

export function sanitizeCookieToken(request) {
  return extractSessionToken(request.headers.cookie);
}
