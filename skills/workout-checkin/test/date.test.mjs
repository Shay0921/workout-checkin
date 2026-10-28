/**
 * 日期与期号计算测试
 * 回归锁：日期一律按本地时区拼接，东八区零点不得倒退一天
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getWeekWindow, calcIssueNo, getIssueWindow, fmtDate, fmtDateTime, parseLocalDate } from '../scripts/calc.mjs';

const periodConfig = { anchorIssue: 1, anchorWeekStart: '2026-10-05' };

test('getWeekWindow：周四归到所在周一~周日', () => {
  const w = getWeekWindow(new Date(2026, 9, 15)); // 2026-10-15 周四
  assert.equal(w.weekStart, '2026-10-12');
  assert.equal(w.weekEnd, '2026-10-18');
});

test('getWeekWindow：周日仍归本周（周一为起点）', () => {
  const w = getWeekWindow(new Date(2026, 9, 18, 23, 59)); // 周日深夜
  assert.equal(w.weekStart, '2026-10-12');
  assert.equal(w.weekEnd, '2026-10-18');
});

test('getWeekWindow：周一归自身', () => {
  const w = getWeekWindow(new Date(2026, 9, 12, 0, 0)); // 周一零点（东八区敏感时刻）
  assert.equal(w.weekStart, '2026-10-12');
  assert.equal(w.weekEnd, '2026-10-18');
});

test('getWeekWindow：零点日期不倒退', () => {
  // toISOString() 取的是 UTC，东八区零点会得到前一天，因此不用它；
  // 断言本地拼接结果在零点/深夜两端都稳定指向当天。
  assert.equal(fmtDate(new Date(2026, 9, 12, 0, 0, 0)), '2026-10-12');
  assert.equal(fmtDate(new Date(2026, 9, 12, 23, 59, 59)), '2026-10-12');
});

test('getWeekWindow：跨月边界（10-11月的周一）', () => {
  const w = getWeekWindow(new Date(2026, 10, 3)); // 2026-11-03 周二
  assert.equal(w.weekStart, '2026-11-02');
  assert.equal(w.weekEnd, '2026-11-08');
});

test('calcIssueNo：锚点周为第 1 期', () => {
  assert.equal(calcIssueNo('2026-10-05', periodConfig), 1);
});

test('calcIssueNo：次周为第 2 期', () => {
  assert.equal(calcIssueNo('2026-10-12', periodConfig), 2);
});

test('calcIssueNo：跨多周（4 周后 = 第 5 期）', () => {
  assert.equal(calcIssueNo('2026-11-02', periodConfig), 5);
});

test('calcIssueNo：真实锚点（anchorIssue=2, 10-12 起）', () => {
  assert.equal(calcIssueNo('2026-10-19', { anchorIssue: 2, anchorWeekStart: '2026-10-12' }), 3);
});

test('calcIssueNo：首期短周锚点落在周四（10-08）→ 后续仍按周递增', () => {
  const shortWeek = { anchorIssue: 1, anchorWeekStart: '2026-10-08' };
  assert.equal(calcIssueNo('2026-10-05', shortWeek), 1);
  assert.equal(calcIssueNo('2026-10-12', shortWeek), 2);
  assert.equal(calcIssueNo('2026-10-19', shortWeek), 3);
  assert.equal(calcIssueNo('2026-11-09', shortWeek), 6);
});

test('getIssueWindow：首期短周按锚点实际起止，不扩成周一', () => {
  const shortWeek = { anchorIssue: 1, anchorWeekStart: '2026-10-08', anchorWeekEnd: '2026-10-11' };
  assert.deepEqual(getIssueWindow(new Date(2026, 9, 8), shortWeek), {
    weekStart: '2026-10-08',
    weekEnd: '2026-10-11',
    issueNo: 1,
  });
  assert.deepEqual(getIssueWindow(new Date(2026, 9, 5), shortWeek), {
    weekStart: '2026-10-08',
    weekEnd: '2026-10-11',
    issueNo: 1,
  });
});

test('getIssueWindow：次周恢复自然周（周一~周日）', () => {
  const shortWeek = { anchorIssue: 1, anchorWeekStart: '2026-10-08', anchorWeekEnd: '2026-10-11' };
  assert.deepEqual(getIssueWindow(new Date(2026, 9, 15), shortWeek), {
    weekStart: '2026-10-12',
    weekEnd: '2026-10-18',
    issueNo: 2,
  });
});

test('calcIssueNo：首期从周五开始（10-16）→ 次一自然周仍是第 2 期', () => {
  const fri = { anchorIssue: 1, anchorWeekStart: '2026-10-16', anchorWeekEnd: '2026-10-18' };
  assert.equal(calcIssueNo('2026-10-12', fri), 1); // 锚点所在自然周 = 第 1 期
  assert.equal(calcIssueNo('2026-10-19', fri), 2); // 回归锁：旧 round(3/7) 会算成第 1 期
  assert.equal(calcIssueNo('2026-11-02', fri), 4);
});

test('calcIssueNo：首期从周六（10-17）/ 周日（10-18）开始同样按自然周递增', () => {
  for (const start of ['2026-10-17', '2026-10-18']) {
    const cfg = { anchorIssue: 1, anchorWeekStart: start, anchorWeekEnd: '2026-10-18' };
    assert.equal(calcIssueNo('2026-10-12', cfg), 1);
    assert.equal(calcIssueNo('2026-10-19', cfg), 2);
    assert.equal(calcIssueNo('2026-10-26', cfg), 3);
  }
});

test('getIssueWindow：周五开统首期只覆盖 10-16~10-18，次周恢复自然周', () => {
  const fri = { anchorIssue: 1, anchorWeekStart: '2026-10-16', anchorWeekEnd: '2026-10-18' };
  assert.deepEqual(getIssueWindow(new Date(2026, 9, 17), fri), {
    weekStart: '2026-10-16',
    weekEnd: '2026-10-18',
    issueNo: 1,
  });
  assert.deepEqual(getIssueWindow(new Date(2026, 9, 21), fri), {
    weekStart: '2026-10-19',
    weekEnd: '2026-10-25',
    issueNo: 2,
  });
});

test('getIssueWindow：完整周锚点与自然周一致', () => {
  const fullWeek = { anchorIssue: 1, anchorWeekStart: '2026-10-12', anchorWeekEnd: '2026-10-18' };
  assert.deepEqual(getIssueWindow(new Date(2026, 9, 14), fullWeek), {
    weekStart: '2026-10-12',
    weekEnd: '2026-10-18',
    issueNo: 1,
  });
});

test('fmtDateTime：本地时区 YYYY-MM-DD HH:mm', () => {
  assert.equal(fmtDateTime(new Date(2026, 9, 19, 20, 5)), '2026-10-19 20:05');
});

// ── parseLocalDate：不存在的日历日期必须返回 null，不能像 new Date() 那样静默滚到下个月 ──

test('parseLocalDate：真实日期返回本地时区当日零点', () => {
  const d = parseLocalDate('2026-10-15');
  assert.equal(fmtDate(d), '2026-10-15');
  assert.equal(d.getHours(), 0);
});

test('parseLocalDate：溢出日期（2 月 30 / 13 月 / 0 月 / 4 月 31）→ null', () => {
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31']) {
    assert.equal(parseLocalDate(bad), null, `${bad} 不是真实日期`);
  }
});

test('parseLocalDate：月日不补零的真实日期同样合法（2026-3-5 = 2026-03-05）', () => {
  assert.equal(fmtDate(parseLocalDate('2026-3-5')), '2026-03-05');
  assert.equal(fmtDate(parseLocalDate('2026-12-3')), '2026-12-03');
  // 不补零也不放过溢出：2026-2-30 与 2026-02-30 一样非法
  assert.equal(parseLocalDate('2026-2-30'), null);
  assert.equal(parseLocalDate('2026-13-1'), null);
});

test('parseLocalDate：格式不符（非数字 / 带时间 / 位数超出 / 非字符串）→ null', () => {
  for (const bad of ['2026/10/05', '2026-10-05T00:00', '2026-105-1', 'abc', '', null, undefined, 20261005]) {
    assert.equal(parseLocalDate(bad), null, `${String(bad)} 应判为非法`);
  }
});

test('parseLocalDate：闰年 2 月 29 合法，平年非法', () => {
  assert.equal(fmtDate(parseLocalDate('2028-02-29')), '2028-02-29');
  assert.equal(parseLocalDate('2026-02-29'), null);
});
