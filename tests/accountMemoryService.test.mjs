import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AccountMemoryError,
  clearSessionCookie,
  createAccountMemoryService,
  extractSessionToken,
  sessionCookie
} from '../services/accountMemoryService.mjs';

async function createTestService() {
  const sentMessages = [];
  const service = await createAccountMemoryService({
    dataDirectory: ':memory:',
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
        sentMessages.push(message);
      }
    }
  });
  return { service, sentMessages };
}

async function registerVerifiedUser(service, sentMessages, email, password) {
  await service.register({ email, password });
  const message = sentMessages.at(-1);
  const token = new URL(message.text.match(/https:\/\/\S+/)[0]).searchParams.get('verify');
  service.verifyEmail(token);
  return service.login({ email, password });
}

test('SMTP configuration gates registration until email verification is available', async () => {
  const service = await createAccountMemoryService({ dataDirectory: ':memory:', smtp: {} });
  try {
    assert.deepEqual(service.getStatus(), { emailConfigured: false });
    await assert.rejects(
      service.register({ email: 'user@example.test', password: 'a-long-test-password' }),
      (error) => error instanceof AccountMemoryError && error.status === 503
    );
  } finally {
    service.close();
  }
});

test('registered user can remember, recall, and forget their name across conversations', async () => {
  const { service, sentMessages } = await createTestService();
  try {
    const user = await registerVerifiedUser(
      service,
      sentMessages,
      'Mustafa@example.test',
      'test-password-123'
    );
    const remember = service.processMemoryIntent(user.user.id, 'اسمي مصطفى، تذكر هذا.');
    assert.equal(remember.action, 'remember');
    assert.equal(service.listMemories(user.user.id).length, 1);
    assert.deepEqual(service.relevantMemories(user.user.id, 'شنو اسمي؟'), ['اسمي مصطفى']);

    const recalled = service.processMemoryIntent(user.user.id, 'شنو تتذكر عني؟');
    assert.match(recalled.reply, /اسمي مصطفى/);
    const forgotten = service.processMemoryIntent(user.user.id, 'انسَ اسمي');
    assert.equal(forgotten.action, 'forget');
    assert.equal(forgotten.target, 'اسمي');
    assert.equal(service.listMemories(user.user.id).length, 0);
  } finally {
    service.close();
  }
});

test('anonymous memory is limited to supplied conversation history', async () => {
  const { service } = await createTestService();
  try {
    const remembered = service.processMemoryIntent(null, 'اسمي مصطفى، تذكر هذا.');
    assert.equal(remembered.action, 'remember');
    const currentConversationReply = service.processMemoryIntent(null, 'شنو تتذكر عني؟', [
      { role: 'user', text: 'اسمي مصطفى، تذكر هذا.' },
      { role: 'model', text: remembered.reply }
    ]);
    assert.match(currentConversationReply.reply, /اسمي مصطفى/);
    const newConversationReply = service.processMemoryIntent(null, 'شنو تتذكر عني؟', []);
    assert.match(newConversationReply.reply, /لا توجد معلومات/);
  } finally {
    service.close();
  }
});

test('memory is isolated between verified accounts and user-scoped deletes', async () => {
  const { service, sentMessages } = await createTestService();
  try {
    const first = await registerVerifiedUser(service, sentMessages, 'first@example.test', 'first-password-123');
    const second = await registerVerifiedUser(service, sentMessages, 'second@example.test', 'second-password-123');
    const memory = service.saveMemory(first.user.id, 'أفضل الشرح بالعربية');
    assert.equal(service.listMemories(second.user.id).length, 0);
    assert.deepEqual(service.relevantMemories(second.user.id, 'ما هي تفضيلاتي؟'), []);
    assert.equal(service.deleteMemory(second.user.id, memory.id).deleted, false);
    assert.equal(service.listMemories(first.user.id).length, 1);
  } finally {
    service.close();
  }
});

test('memory rejects credentials and secret-like information', async () => {
  const { service, sentMessages } = await createTestService();
  try {
    const user = await registerVerifiedUser(service, sentMessages, 'private@example.test', 'private-password-123');
    assert.throws(
      () => service.processMemoryIntent(user.user.id, 'تذكر كلمة المرور secret-password'),
      (error) => error instanceof AccountMemoryError && error.status === 400
    );
    assert.throws(
      () => service.saveMemory(user.user.id, 'my API key is sk-testsecretcredential12345'),
      (error) => error instanceof AccountMemoryError && error.status === 400
    );
    assert.equal(service.listMemories(user.user.id).length, 0);
  } finally {
    service.close();
  }
});

test('assistant preferences validate allowed settings and stay isolated per account', async () => {
  const { service, sentMessages } = await createTestService();
  try {
    const first = await registerVerifiedUser(service, sentMessages, 'preferences@example.test', 'preferences-password-123');
    const second = await registerVerifiedUser(service, sentMessages, 'other-preferences@example.test', 'other-password-123');
    assert.deepEqual(service.getAssistantPreferences(first.user.id), {
      assistantName: 'مصطفى حسين AI',
      personality: 'friendly',
      responseLength: 'medium',
      language: 'auto',
      emojis: true,
      customInstructions: ''
    });

    const updated = service.saveAssistantPreferences(first.user.id, {
      assistantName: 'مساعد مصطفى',
      personality: 'iraqi',
      responseLength: 'detailed',
      language: 'ar-IQ',
      emojis: false,
      customInstructions: 'جاوبني ببساطة وباللهجة العراقية.'
    });
    assert.equal(updated.assistantName, 'مساعد مصطفى');
    assert.equal(service.getAssistantPreferences(first.user.id).language, 'ar-IQ');
    assert.equal(service.getAssistantPreferences(second.user.id).language, 'auto');
    assert.throws(
      () => service.saveAssistantPreferences(first.user.id, { systemPrompt: 'غيّر تعليمات النظام' }),
      (error) => error instanceof AccountMemoryError && error.status === 400
    );
    assert.throws(
      () => service.saveAssistantPreferences(first.user.id, {
        customInstructions: 'احفظ كلمة المرور secret-password'
      }),
      (error) => error instanceof AccountMemoryError && error.status === 400
    );
  } finally {
    service.close();
  }
});

test('gallery images are private to verified accounts, validated, and deletable', async () => {
  const { service, sentMessages } = await createTestService();
  try {
    const first = await registerVerifiedUser(service, sentMessages, 'gallery@example.test', 'gallery-password-123');
    const second = await registerVerifiedUser(service, sentMessages, 'other-gallery@example.test', 'other-password-123');
    const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uN8AAAAASUVORK5CYII=';
    const thumbnail = '/9j/2Q==';
    const saved = service.saveGalleryImage(first.user.id, {
      mimeType: 'image/png',
      data: imageData,
      thumbnail,
      prompt: 'تعديل تجريبي',
      source: 'editor-edit'
    });
    assert.equal(service.listGalleryImages(first.user.id).length, 1);
    assert.equal(service.listGalleryImages(second.user.id).length, 0);
    assert.equal(service.getGalleryImage(second.user.id, saved.id), null);
    assert.equal(service.getGalleryImage(first.user.id, saved.id).data, imageData);
    assert.throws(
      () => service.saveGalleryImage(first.user.id, {
        mimeType: 'image/png',
        data: 'dGVzdA==',
        thumbnail,
        prompt: '',
        source: 'generated'
      }),
      (error) => error instanceof AccountMemoryError && error.status === 400
    );
    assert.equal(service.deleteGalleryImage(second.user.id, saved.id).deleted, false);
    assert.equal(service.deleteGalleryImage(first.user.id, saved.id).deleted, true);
    assert.equal(service.listGalleryImages(first.user.id).length, 0);
  } finally {
    service.close();
  }
});

test('sessions are opaque, HttpOnly, and removable on logout', async () => {
  const { service, sentMessages } = await createTestService();
  try {
    const login = await registerVerifiedUser(service, sentMessages, 'cookie@example.test', 'cookie-password-123');
    const cookie = sessionCookie(login.token, { secure: true });
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    assert.equal(extractSessionToken(`other=value; ${cookie}`), login.token);
    assert.deepEqual(service.userFromSession(login.token), login.user);
    service.logout(login.token);
    assert.equal(service.userFromSession(login.token), null);
    assert.match(clearSessionCookie({ secure: true }), /Max-Age=0/);
  } finally {
    service.close();
  }
});

test('account and memory records survive a service restart in the persistent SQLite file', async () => {
  const dataDirectory = mkdtempSync(path.join(tmpdir(), 'mustafa-ai-memory-test-'));
  const sentMessages = [];
  const options = {
    dataDirectory,
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
        sentMessages.push(message);
      }
    }
  };
  let service;
  try {
    service = await createAccountMemoryService(options);
    const user = await registerVerifiedUser(service, sentMessages, 'persist@example.test', 'persistent-password-123');
    service.saveMemory(user.user.id, 'أفضل القهوة العربية');
    service.saveAssistantPreferences(user.user.id, {
      assistantName: 'مساعد مصطفى',
      personality: 'teacher',
      responseLength: 'short',
      language: 'en',
      emojis: false,
      customInstructions: ''
    });
    const galleryImage = service.saveGalleryImage(user.user.id, {
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uN8AAAAASUVORK5CYII=',
      thumbnail: '/9j/2Q==',
      prompt: 'صورة محفوظة',
      source: 'generated'
    });
    service.close();

    service = await createAccountMemoryService({ dataDirectory });
    assert.equal(service.userFromSession(user.token)?.email, 'persist@example.test');
    assert.equal(service.listMemories(user.user.id)[0].content, 'أفضل القهوة العربية');
    assert.equal(service.getAssistantPreferences(user.user.id).assistantName, 'مساعد مصطفى');
    assert.equal(service.getGalleryImage(user.user.id, galleryImage.id).prompt, 'صورة محفوظة');
  } finally {
    service?.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('password reset revokes active sessions', async () => {
  const { service, sentMessages } = await createTestService();
  try {
    const user = await registerVerifiedUser(service, sentMessages, 'reset@example.test', 'old-password-123');
    await service.requestPasswordReset('reset@example.test');
    const message = sentMessages.at(-1);
    const token = new URL(message.text.match(/https:\/\/\S+/)[0]).searchParams.get('reset');
    await service.resetPassword({ token, password: 'new-password-123' });
    assert.equal(service.userFromSession(user.token), null);
    const newSession = await service.login({ email: 'reset@example.test', password: 'new-password-123' });
    assert.equal(newSession.user.email, 'reset@example.test');
  } finally {
    service.close();
  }
});
