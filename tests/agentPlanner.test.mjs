import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateExpression,
  createAgentCapabilities,
  parseAgentPlan
} from '../services/agentPlanner.mjs';

test('agent capabilities only expose tools supported by the request and attachments', () => {
  assert.deepEqual(createAgentCapabilities({
    message: 'مرحبا، كيف حالك؟',
    hasFile: false,
    hasImage: false,
    authenticated: false
  }), { candidates: [], imageGenerationUnavailable: false });

  const fileAndSearch = createAgentCapabilities({
    message: 'حلل هذا الملف وابحث على الإنترنت عن المعلومات الناقصة',
    hasFile: true,
    hasImage: false,
    authenticated: false
  });
  assert.deepEqual(fileAndSearch.candidates, ['document_analysis', 'web_search']);

  const imageEdit = createAgentCapabilities({
    message: 'خلي الخلفية ليلية',
    hasFile: false,
    hasImage: true,
    authenticated: false
  });
  assert.deepEqual(imageEdit.candidates, ['image_edit']);

  const imageAnalysis = createAgentCapabilities({
    message: 'اشرح محتوى الصورة',
    hasFile: false,
    hasImage: true,
    authenticated: false
  });
  assert.deepEqual(imageAnalysis.candidates, ['image_analysis']);
});

test('agent planner filters untrusted tool names and caps steps', () => {
  const available = ['document_analysis', 'web_search', 'calculator', 'code_analysis', 'memory'];
  assert.deepEqual(parseAgentPlan(JSON.stringify({
    tools: ['document_analysis', 'execute_shell', 'web_search', 'calculator', 'code_analysis', 'memory']
  }), available, 4), ['document_analysis', 'web_search', 'calculator', 'code_analysis']);
  assert.deepEqual(parseAgentPlan('not json', available, 4), available.slice(0, 4));
  assert.deepEqual(parseAgentPlan('{"tools":["web_search"]}', ['calculator']), []);
});

test('agent calculator supports basic arithmetic and rejects executable input', () => {
  assert.equal(calculateExpression('احسب 2+3*4'), 14);
  assert.equal(calculateExpression('احسب 2^3'), 8);
  assert.equal(calculateExpression('احسب ٢+٣'), 5);
  assert.throws(() => calculateExpression('احسب 2/0'), /القسمة على صفر/);
  assert.throws(() => calculateExpression('احسب 2+3;process.exit()'));
});
