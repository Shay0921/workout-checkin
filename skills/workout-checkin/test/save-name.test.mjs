/**
 * 保存图片文件名：周报 HTML 的下载名必须按周期期号生成，而不是保存当天日期。
 * 格式：<weekStart 年>-issue<NN>-<MM.DD>.png（与 reports/ 归档命名同源）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSaveName } from '../scripts/render.mjs';

test('保存图片文件名：按 weekStart 年 + 期号 + 月.日', () => {
  assert.equal(formatSaveName('2026-10-08', 1), '2026-issue01-10.08.png');
  assert.equal(formatSaveName('2026-10-12', 2), '2026-issue02-10.12.png');
});

test('保存图片文件名：月日保持两位、期号跨年连续', () => {
  assert.equal(formatSaveName('2026-01-05', 12), '2026-issue12-01.05.png');
  assert.equal(formatSaveName('2027-01-04', 14), '2027-issue14-01.04.png');
  assert.equal(formatSaveName('2027-01-11', 100), '2027-issue100-01.11.png');
});
