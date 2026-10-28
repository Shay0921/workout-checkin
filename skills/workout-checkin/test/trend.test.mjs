/**
 * 趋势与上期归档测试
 * 覆盖：findPrevReport 本年命中/跨年回退/首期兜底、
 *       redPacketTrendText、returnWelcome 回归判定
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPrevReport, buildStats } from '../scripts/calc.mjs';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const fixturesDir = dirname(fileURLToPath(import.meta.url)) + '/fixtures';
const config = JSON.parse(readFileSync(resolve(fixturesDir, 'members.test.json'), 'utf-8'));
const prevReport = JSON.parse(readFileSync(resolve(fixturesDir, 'prev-report.json'), 'utf-8'));
const weekWindow = { weekStart: '2026-10-12', weekEnd: '2026-10-18' };

const run = (records, leaves = [], prev = null) =>
  buildStats({ records, leaves, config, weekWindow, issueNo: 2, prevReport: prev, generatedAt: '2026-10-19 20:30' });

// ---------- findPrevReport ----------

test('findPrevReport：本年上期命中', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'wk-'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, '2026-issue01.json'), JSON.stringify(prevReport));
    const found = findPrevReport(dir, 2, '2026');
    assert.equal(found.issueNo, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findPrevReport：期号 1 跨年回退查上一年最大期号（2027-issue01 → 2026-issue05）', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'wk-'));
  try {
    writeFileSync(resolve(dir, '2026-issue05.json'), JSON.stringify({ issueNo: 5 }));
    writeFileSync(resolve(dir, '2027-issue01.json'), JSON.stringify({ issueNo: 1 }));
    const found = findPrevReport(dir, 1, '2027');
    assert.equal(found.issueNo, 5); // 期号跨年连续递增：上一年最后一期
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findPrevReport：跨年回退扫描上一年最大期号', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'wk-'));
  try {
    writeFileSync(resolve(dir, '2026-issue05.json'), JSON.stringify({ issueNo: 5 }));
    writeFileSync(resolve(dir, '2026-issue03.json'), JSON.stringify({ issueNo: 3 }));
    writeFileSync(resolve(dir, '2027-issue01.json'), JSON.stringify({ issueNo: 1 }));
    const found = findPrevReport(dir, 1, '2027');
    assert.equal(found.issueNo, 5); // 2027-issue01 的上期是 2026-issue05
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findPrevReport：跨年回退必须恰好是 NN-1（2027-issue14 → 2026-issue13）', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'wk-'));
  try {
    writeFileSync(resolve(dir, '2026-issue12.json'), JSON.stringify({ issueNo: 12 }));
    writeFileSync(resolve(dir, '2026-issue13.json'), JSON.stringify({ issueNo: 13 }));
    assert.equal(findPrevReport(dir, 14, '2027').issueNo, 13);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findPrevReport：跨年只接受 NN-1，缺环时返回 null 而不是拿更早一期顶替', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'wk-'));
  try {
    // 2027-issue14 缺失，上一年最后一期是 13：第 15 期绝不能退回 13
    writeFileSync(resolve(dir, '2026-issue12.json'), JSON.stringify({ issueNo: 12 }));
    writeFileSync(resolve(dir, '2026-issue13.json'), JSON.stringify({ issueNo: 13 }));
    writeFileSync(resolve(dir, '2027-issue15.json'), JSON.stringify({ issueNo: 15 }));
    assert.equal(findPrevReport(dir, 15, '2027'), null);
    // 第 6 期缺第 5 期，上一年最后一期是第 4 期：也不能拿第 4 期顶替
    writeFileSync(resolve(dir, '2025-issue04.json'), JSON.stringify({ issueNo: 4 }));
    assert.equal(findPrevReport(dir, 6, '2026'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findPrevReport：目录不存在 → null（首期）', () => {
  assert.equal(findPrevReport(resolve(tmpdir(), 'wk-not-exist-dir'), 2, '2026'), null);
});

test('findPrevReport：归档文件损坏 → 警告并按 null 兜底', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'wk-'));
  try {
    writeFileSync(resolve(dir, '2026-issue01.json'), '{broken json');
    assert.equal(findPrevReport(dir, 2, '2026'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findPrevReport：同年归档内容期号不符 → null，不跨年拿别的文件顶替', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'wk-'));
  try {
    writeFileSync(resolve(dir, '2026-issue01.json'), JSON.stringify({ issueNo: 5 }));
    writeFileSync(resolve(dir, '2025-issue01.json'), JSON.stringify({ issueNo: 1 }));
    assert.equal(findPrevReport(dir, 2, '2026'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findPrevReport：跨年归档内容期号不符 → null', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'wk-'));
  try {
    writeFileSync(resolve(dir, '2026-issue12.json'), JSON.stringify({ issueNo: 12 }));
    writeFileSync(resolve(dir, '2026-issue13.json'), JSON.stringify({ issueNo: 12 }));
    assert.equal(findPrevReport(dir, 14, '2027'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 首期兜底 ----------

test('首期兜底：无上期归档时趋势字段全部兜底', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '羽毛球', quantity: 1, unit: 'h' },
  ]);
  assert.equal(data.redPacketTrendText, '首期 · 暂无对比');
  assert.equal(data.returnWelcome, null);
});

// ---------- 红包趋势文案 ----------
// 以下三个用例：records/leaves 全空 → 7 名 active 全部 0 次未打卡 → 红包 ¥70（7 × ¥10）

test('redPacketTrendText：较上期上升', () => {
  const data = run([], [], { ...prevReport, redPacketTotal: 10 });
  assert.equal(data.redPacketTotal, 70);
  assert.equal(data.redPacketTrendText, '较上期 +¥60');
});

test('redPacketTrendText：较上期下降', () => {
  const data = run([], [], { ...prevReport, redPacketTotal: 100 });
  assert.equal(data.redPacketTrendText, '较上期 −¥30');
});

test('redPacketTrendText：与上期持平', () => {
  const data = run([], [], { ...prevReport, redPacketTotal: 70 });
  assert.equal(data.redPacketTrendText, '与上期持平');
});

// ---------- returnWelcome 回归判定 ----------

test('returnWelcome：上期请假、本周打卡 → 回归（多人取分钟最多）', () => {
  const data = run(
    [
      { nickname: '小芳', ordinal: 1, sport: '跑步', quantity: 60, unit: 'min' }, // 上期请假，回归 60 分钟
      { nickname: '小周', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' }, // 上期未请假，不算回归
    ],
    [],
    { ...prevReport, leaveList: [{ nickname: '小芳', reason: '病假' }] }
  );
  assert.equal(data.returnWelcome.nickname, '小芳');
  assert.equal(data.returnWelcome.initial, '小');
  assert.equal(data.returnWelcome.message, '上周请假，本周回归打卡 60 分钟，欢迎回来！');
});

test('returnWelcome：英文昵称首字母大写', () => {
  const data = run(
    [{ nickname: 'Huahua', ordinal: 1, sport: '跑步', quantity: 60, unit: 'min' }],
    [],
    { ...prevReport, leaveList: [{ nickname: 'Huahua', reason: '病假' }] }
  );
  assert.equal(data.returnWelcome.initial, 'H');
});

test('returnWelcome：上期请假者本周仍请假 → 不算回归', () => {
  const data = run(
    [],
    [{ nickname: '小芳', reason: '事假' }],
    { ...prevReport, leaveList: [{ nickname: '小芳', reason: '病假' }] }
  );
  assert.equal(data.returnWelcome, null);
});
