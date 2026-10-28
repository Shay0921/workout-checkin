/**
 * 解析与归一化测试
 * 回归锁：自由训练必须直查 MET（3.5），不得被别名映射到自由活动（3.0）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNickname, resolveSport, toMinutes, calcCalories } from '../scripts/calc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const fixturesDir = dirname(fileURLToPath(import.meta.url)) + '/fixtures';
const config = JSON.parse(readFileSync(resolve(fixturesDir, 'members.test.json'), 'utf-8'));
const members = config.members.filter((m) => m.status === 'active');
const { met, sportAlias, convert } = config;

// ---------- 昵称归一化 ----------

test('normalizeNickname：精确匹配', () => {
  assert.equal(normalizeNickname('阿明', members)?.nickname, '阿明');
});

test('normalizeNickname：别名匹配（阿明~）', () => {
  assert.equal(normalizeNickname('阿明~', members)?.nickname, '阿明');
});

test('normalizeNickname：emoji 剥离（别名含 emoji：小张🍀 命中 小张）', () => {
  assert.equal(normalizeNickname('小张🍀', members)?.nickname, '小张');
});

test('normalizeNickname：大小写与下划线不敏感', () => {
  assert.equal(normalizeNickname('HUA_HUA', members)?.nickname, 'Huahua');
});

test('normalizeNickname：未命中返回 null', () => {
  assert.equal(normalizeNickname('陌生人', members), null);
  assert.equal(normalizeNickname('', members), null);
});

test('normalizeNickname：前缀兜底（昵称+后缀备注）', () => {
  // 「Huahua年底目标60KG」类长变体：接龙昵称以成员昵称开头即唯一命中
  assert.equal(normalizeNickname('阿明年底目标70KG', members)?.nickname, '阿明');
});

test('normalizeNickname：前缀兜底支持别名开头', () => {
  assert.equal(normalizeNickname('阿明~冲刺打卡', members)?.nickname, '阿明');
});

test('normalizeNickname：前缀命中多个成员抛歧义异常', () => {
  const ms = [
    { nickname: '小明', aliases: [], status: 'active' },
    { nickname: '小明哥', aliases: [], status: 'active' },
  ];
  assert.throws(
    () => normalizeNickname('小明哥今天跑步', ms),
    (e) => e.code === 'AMBIGUOUS_NICKNAME' && e.message.includes('小明')
  );
});

test('normalizeNickname：精确匹配优先，不受前缀歧义影响', () => {
  const ms = [
    { nickname: '小明', aliases: [], status: 'active' },
    { nickname: '小明哥', aliases: [], status: 'active' },
  ];
  assert.equal(normalizeNickname('小明', ms)?.nickname, '小明');
});

test('normalizeNickname：单字候选不参与前缀匹配', () => {
  const ms = [{ nickname: '王', aliases: [], status: 'active' }];
  assert.equal(normalizeNickname('王小明跑步', ms), null);
});

test('normalizeNickname：接龙昵称不含成员前缀则不误伤', () => {
  const ms = [{ nickname: '阿明', aliases: [], status: 'active' }];
  assert.equal(normalizeNickname('陌生人阿明', ms), null);
});

// ---------- 运动项目归一化 ----------

test('resolveSport：MET 表直查优先（力训是独立条目）', () => {
  assert.deepEqual(resolveSport('力训', met, sportAlias), { name: '力训', met: 5.0 });
});

test('resolveSport：自由训练直查命中 3.5，禁止映射到自由活动 3.0', () => {
  assert.deepEqual(resolveSport('自由训练', met, sportAlias), { name: '自由训练', met: 3.5 });
});

test('resolveSport：自由活动直查命中，不受别名影响', () => {
  assert.deepEqual(resolveSport('自由活动', met, sportAlias), { name: '自由活动', met: 3.0 });
});

test('resolveSport：别名兜底（力量训练 → 力训）', () => {
  assert.deepEqual(resolveSport('力量训练', met, sportAlias), { name: '力训', met: 5.0 });
});

test('resolveSport：未知项目返回 null（禁止猜测）', () => {
  assert.equal(resolveSport('蹦极', met, sportAlias), null);
});

// ---------- 量纲换算 ----------

test('toMinutes：小时换算（1.85h = 111min）', () => {
  assert.equal(toMinutes(1.85, 'h', convert), 111);
});

test('toMinutes：分钟原值', () => {
  assert.equal(toMinutes(46, 'min', convert), 46);
});

test('toMinutes：爬楼换算（33 层 × 0.4 = 13.2 → 取整 13）', () => {
  assert.equal(toMinutes(33, 'floor', convert), 13);
});

test('toMinutes：km 按项目换算，游泳固定 30min/km', () => {
  assert.equal(toMinutes(1, 'km', convert, '游泳'), 30);
});

test('toMinutes：km 按项目换算，跑步与骑行不再误用游泳配速', () => {
  assert.equal(toMinutes(3, 'km', convert, '跑步'), 18);
  assert.equal(toMinutes(12, 'km', convert, '骑行'), 36);
});

test('toMinutes：未配置 km 的项目返回 null，禁止回退到游泳配速', () => {
  assert.equal(toMinutes(3, 'km', convert, '徒步'), null);
});

test('toMinutes：count 按项目换算（跳绳 1000 个 × 0.01 = 10min）', () => {
  assert.equal(toMinutes(1000, 'count', convert, '跳绳'), 10);
});

test('toMinutes：未知单位返回 null', () => {
  assert.equal(toMinutes(100, 'step', convert), null);
});

// ---------- 卡路里 ----------

test('calcCalories：MET × 体重 × 时长h，四舍五入', () => {
  assert.equal(calcCalories(7, 70, 90), 735); // 7×70×1.5
  assert.equal(calcCalories(8, 70, 25), 233); // 8×70×(25/60)=233.33
});
