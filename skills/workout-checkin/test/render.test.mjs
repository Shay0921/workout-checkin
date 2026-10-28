/**
 * 渲染契约守卫：模板占位符提取、数据字段校验、残留占位符检测。
 *
 * 这三个环节一旦走样，表现是「render 报缺字段」（提取错）或「多余字段告警刷屏」
 * （白名单漂移），都会把真实问题淹没在噪声里。此处直接对纯函数断言，不跑完整渲染。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractTopLevelVars,
  validateData,
  findLeftoverPlaceholders,
  EXTRA_FIELDS_WHITELIST,
} from '../scripts/render.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const samplePath = resolve(testDir, '../assets/data.sample.json');

test('extractTopLevelVars：剔除 HTML 注释，each 内字段不算顶层，块集合与 if 条件算顶层', () => {
  const tpl = [
    '<!-- 契约注释里的 {{hiddenInComment}} 不能计入 -->',
    '{{title}}',
    '{{#each rows}}{{name}}{{/each}}',
    '{{#if hasRows}}{{obj.field}}{{/if}}',
    '{{@index}}{{else}}',
  ].join('\n');

  const vars = extractTopLevelVars(tpl);
  // rows = each 的集合（顶层必须提供）；name = each 内字段（作用域内）
  assert.deepEqual([...vars].sort(), ['hasRows', 'obj', 'rows', 'title']);
});

test('extractTopLevelVars：嵌套 each 内的字段一律不计入顶层', () => {
  const tpl = '{{#each groups}}{{#each items}}{{deepField}}{{/each}}{{midField}}{{/each}}';
  const vars = extractTopLevelVars(tpl);
  assert.deepEqual([...vars], ['groups']);
});

test('validateData：缺字段报缺失、白名单字段不告警、真多余字段才告警', () => {
  const required = new Set(['title', 'rows']);

  assert.deepEqual(validateData({ title: 'x', rows: [] }, required), { missing: [], extra: [] });

  assert.deepEqual(validateData({ title: 'x' }, required).missing, ['rows']);

  // 白名单内的扩展字段（calc 合法输出、模板不消费）不应产生告警噪声
  assert.deepEqual(validateData({ title: 'x', rows: [], spotlights: {} }, required).extra, []);

  // 未登记的字段（多为拼写错误）必须报出来
  assert.deepEqual(validateData({ title: 'x', rows: [], titre: 'typo' }, required).extra, ['titre']);
});

test('EXTRA_FIELDS_WHITELIST 无漂移：每个豁免键都必须是 calc 真实产出的字段', () => {
  // data.sample.json 的字段集由 sample-schema.test.mjs 锁定为 calc 当前输出，
  // 因此「白名单键 ⊆ sample 键」等价于「白名单键 ⊆ calc 输出」，无需在此重跑 calc。
  const sample = JSON.parse(readFileSync(samplePath, 'utf-8'));
  const sampleKeys = new Set(Object.keys(sample));
  const ghosts = [...EXTRA_FIELDS_WHITELIST].filter((k) => !sampleKeys.has(k));
  assert.deepEqual(
    ghosts,
    [],
    `白名单含 calc 已不再产出的字段（会掩盖真正的多余字段告警，请删掉这些键）：${ghosts.join(', ')}`
  );
});

test('findLeftoverPlaceholders：干净结果返回空数组，残留按全部命中计数', () => {
  assert.deepEqual(findLeftoverPlaceholders('<p>全部求值完成</p>'), []);

  // 同一写法重复出现 + 另一种写法：计数 3、去重后 2
  const html = '<b>{{a}}</b><b>{{a}}</b>{{#if b}}';
  const hits = findLeftoverPlaceholders(html);
  assert.equal(hits.length, 3, '计数应包含重复命中');
  assert.equal(new Set(hits).size, 2, '去重后只剩 2 种写法，与 render 的展示口径一致');
});
