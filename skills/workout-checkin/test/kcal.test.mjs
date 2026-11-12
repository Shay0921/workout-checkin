/**
 * 格式 C（接龙自带 kcal / 不写第几次）测试
 *
 * 覆盖：实测优先、逐条 MET 兜底、一行多项目分组、覆盖率、非法值、
 *       无体重、补充贴合并、兜底格式 A/B 100% 回归。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { buildStats, resolveCalories, calcCalories } from '../scripts/calc.mjs';
import {
  buildCumulative,
  defaultMemberCumulative,
  defaultGroupCumulative,
} from '../scripts/cumulative.mjs';

const fixturesDir = dirname(fileURLToPath(import.meta.url)) + '/fixtures';
const config = JSON.parse(readFileSync(resolve(fixturesDir, 'members.test.json'), 'utf-8'));
const weekWindow = { weekStart: '2026-10-12', weekEnd: '2026-10-18' };

const run = (records, leaves = [], cfg = config) =>
  buildStats({ records, leaves, config: cfg, weekWindow, issueNo: 2, prevReport: null, generatedAt: '2026-10-19 20:30' });
const rowOf = (data, nick) => data.checkinList.find((r) => r.nickname === nick);
// 兜底期望值随 fixture 体重走，避免把 70kg 硬编码进断言
const amingWeight = config.members.find((m) => m.nickname === '阿明').weightKg;

test('resolveCalories：实测优先，缺体重也允许；无 kcal 才需要体重', () => {
  assert.deepEqual(
    resolveCalories({ kcal: 613, met: 7, weightKg: null, minutes: 53 }),
    { calories: 613, source: 'reported' }
  );
  assert.deepEqual(
    resolveCalories({ kcal: null, met: 7, weightKg: 60, minutes: 60 }),
    { calories: 420, source: 'met' }
  );
  assert.throws(
    () => resolveCalories({ kcal: null, met: 7, weightKg: null, minutes: 53 }),
    /体重缺失/
  );
  assert.equal(calcCalories(8, 60, 60), 480); // 旧兜底函数保持原口径
});

test('格式 C：单条实测 kcal 直接计入，不再按 MET 估算', () => {
  const data = run([
    { nickname: '阿明', session: 'L1', sport: '游泳', quantity: 53, unit: 'min', kcal: 613 },
  ]);
  assert.equal(rowOf(data, '阿明').totalCalories, 613);
  assert.equal(data.totalCaloriesSum, 613);
  assert.equal(data.calorieCoverage.reported, 1);
  assert.equal(data.calorieCoverage.estimated, 0);
  assert.match(data.calorieCoverage.note, /全部取接龙实测值/);
  // 强度维度仍只由 MET 决定，与能量来源无关
  assert.equal(rowOf(data, '阿明').loadScore, 7 * 53);
  assert.notEqual(rowOf(data, '阿明').totalCalories, calcCalories(7, amingWeight, 53));
});

test('逐条兜底：同一周实测与 MET 估算可以混用', () => {
  const data = run([
    { nickname: '阿明', session: 'L1', sport: '游泳', quantity: 53, unit: 'min', kcal: 613 },
    { nickname: '阿明', session: 'L2', sport: '跑步', quantity: 30, unit: 'min' }, // MET 兜底
  ]);
  const metFallback = calcCalories(8, amingWeight, 30);
  assert.equal(rowOf(data, '阿明').totalCalories, 613 + metFallback);
  assert.equal(data.totalCaloriesSum, 613 + metFallback);
  assert.equal(data.calorieCoverage.reported, 1);
  assert.equal(data.calorieCoverage.estimated, 1);
  assert.match(data.calorieCoverage.note, /实测 1\/2 条/);
});

test('session 分组：一行两项目 = 1 次打卡 / 2 个项目人次 / kcal 累加', () => {
  const data = run([
    { nickname: '阿明', session: 'L1', sport: '自由活动', quantity: 46, unit: 'min', kcal: 210 },
    { nickname: '阿明', session: 'L1', sport: '羽毛球', quantity: 1.85, unit: 'h', kcal: 570 },
    { nickname: '阿明', session: 'L2', sport: '跑步', quantity: 30, unit: 'min', kcal: 300 },
  ]);
  const row = rowOf(data, '阿明');
  assert.equal(row.checkinCount, 2, 'L1 一行 + L2 一行，只算 2 次打卡');
  assert.equal(row.totalMinutes, 46 + 111 + 30);
  assert.equal(row.totalCalories, 210 + 570 + 300);
  assert.equal(data.totalSessions, 3, '3 条流水 = 3 个人次');
  const byName = Object.fromEntries(data.sportStats.map((s) => [s.name, s.count]));
  assert.equal(byName['自由活动'], 1);
  assert.equal(byName['羽毛球'], 1);
  assert.equal(byName['跑步'], 1);
});

test('session 与显式 ordinal 混贴：ordinal 优先，同组后续记录复用', () => {
  const data = run([
    { nickname: '阿明', ordinal: 2, session: 'L1', sport: '跑步', quantity: 30, unit: 'min', kcal: 300 },
    { nickname: '阿明', session: 'L1', sport: '瑜伽', quantity: 20, unit: 'min', kcal: 100 },
  ]);
  assert.equal(rowOf(data, '阿明').checkinCount, 1);
  assert.equal(rowOf(data, '阿明').totalCalories, 400);
});

test('兜底格式 A/B 100% 兼容：无 kcal / 无 session 时仍按 MET × 体重 × 时长', () => {
  const data = run([
    { nickname: '老王', ordinal: 1, sport: '跑步', quantity: 60, unit: 'min' },
  ]);
  assert.equal(rowOf(data, '老王').totalCalories, 480);
  assert.equal(data.calorieCoverage.reported, 0);
  assert.equal(data.calorieCoverage.estimated, 1);
  assert.match(data.calorieCoverage.note, /未标注按项目与时长折算/);
});

test('kcal 非法值一律整期拦下，null / 省略才走兜底', () => {
  for (const bad of ['613', 0, -1, '约600', NaN, Infinity]) {
    assert.throws(
      () => run([{ nickname: '阿明', sport: '游泳', quantity: 53, unit: 'min', kcal: bad }]),
      /卡路里非法/,
      `kcal=${String(bad)} 应报错`
    );
  }
  const d = run([{ nickname: '阿明', sport: '游泳', quantity: 60, unit: 'min', kcal: null }]);
  assert.equal(rowOf(d, '阿明').totalCalories, calcCalories(7, amingWeight, 60));
});

test('session 非法值一律整期拦下', () => {
  for (const bad of ['', 0, -1, 1.5, {}]) {
    assert.throws(
      () => run([{ nickname: '阿明', session: bad, sport: '游泳', quantity: 53, unit: 'min', kcal: 613 }]),
      /分组标注非法/,
      `session=${String(bad)} 应报错`
    );
  }
});

test('本期全部自带 kcal 时 calc 不要求体重（Step 0 体检仍要求配置兜底默认值）', () => {
  const cfg = JSON.parse(JSON.stringify(config));
  delete cfg.defaultWeightKg;
  for (const m of cfg.members) delete m.weightKg;

  const data = run([
    { nickname: '阿明', session: 'L1', sport: '游泳', quantity: 53, unit: 'min', kcal: 613 },
  ], [], cfg);
  assert.equal(rowOf(data, '阿明').totalCalories, 613);

  assert.throws(
    () => run([{ nickname: '阿明', sport: '游泳', quantity: 60, unit: 'min' }], [], cfg),
    /体重无效/,
    '没写 kcal 又没体重必须拦下，不能静默按 0 算'
  );
});

test('补充贴合并：分钟累加时实测 kcal 同步累加', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min', kcal: 300 },
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 15, unit: 'min', kcal: 150 },
  ]);
  assert.equal(rowOf(data, '阿明').totalMinutes, 45);
  assert.equal(rowOf(data, '阿明').totalCalories, 450);
  assert.equal(rowOf(data, '阿明').checkinCount, 1);
});

test('空记录期：覆盖率 total=0，脚注仍给出完整口径说明', () => {
  const data = run([]);
  assert.equal(data.calorieCoverage.total, 0);
  assert.equal(data.calorieCoverage.reported, 0);
  assert.match(data.calorieCoverage.note, /优先用接龙实测值/);
});

test('历史档位不变：切换实测 kcal 只影响本期，历史 recentWeeks 原样保留', () => {
  // 前三期都是 MET 估算出来的消耗，本期起改用接龙实测 kcal
  const history = [
    { issue: 1, minutes: 100, calories: 400, checkins: 2, status: 'met', redPacket: 0 },
    { issue: 2, minutes: 100, calories: 350, checkins: 2, status: 'met', redPacket: 0 },
    { issue: 3, minutes: 100, calories: 380, checkins: 2, status: 'met', redPacket: 0 },
  ];
  const prevCumulative = {
    group: defaultGroupCumulative(),
    members: {
      阿明: {
        ...defaultMemberCumulative(),
        totalCalories: 400 + 350 + 380,
        totalMinutes: 300,
        recentWeeks: history.map((w) => ({ ...w })),
      },
    },
  };
  const cur = {
    nickname: '阿明',
    lastStatus: 'met',
    checkinCount: 2,
    totalMinutes: 100,
    totalCalories: 613, // 实测 kcal，不再由 MET 估算
    loadScore: 700,
    weightKg: config.defaultWeightKg,
    redPacketAmount: 0,
    sports: { 游泳: 2 },
  };
  const cum = buildCumulative({ prevCumulative, memberStats: [cur], config, issueNo: 4 });
  const recent = cum.members['阿明'].recentWeeks;

  // 历史三期逐字不变：不回溯、不按新口径重算
  assert.deepEqual(recent.slice(0, 3), prevCumulative.members['阿明'].recentWeeks);
  assert.equal(recent[0].calories, 400);
  assert.equal(recent[2].calories, 380);
  // 只有本期新增的一条取实测值，累计 = 历史原值 + 本期实测
  assert.equal(recent[3].calories, 613);
  assert.equal(cum.members['阿明'].totalCalories, 400 + 350 + 380 + 613);
  assert.equal(cum.members['阿明'].bestCalories, 613);
});

// ── 严格模式回归：以下每一条都曾静默算错，必须锁死 ──

test('严格：同项目同分钟却写了不同 kcal → 整期拦下，不静默丢实测值', () => {
  assert.throws(
    () => run([
      { nickname: '阿明', ordinal: 1, sport: '游泳', quantity: 53, unit: 'min', kcal: 613 },
      { nickname: '阿明', ordinal: 1, sport: '游泳', quantity: 53, unit: 'min', kcal: 700 },
    ]),
    /能量冲突/
  );
});

test('严格：完全相同的重复贴去重（格式 A/B 与格式 C 都成立）', () => {
  const withKcal = run([
    { nickname: '阿明', ordinal: 1, sport: '游泳', quantity: 53, unit: 'min', kcal: 613 },
    { nickname: '阿明', ordinal: 1, sport: '游泳', quantity: 53, unit: 'min', kcal: 613 },
  ]);
  assert.equal(withKcal.totalCaloriesSum, 613);
  assert.equal(withKcal.totalMinutesSum, 53);

  const legacy = run([
    { nickname: '老王', ordinal: 1, sport: '跑步', quantity: 60, unit: 'min' },
    { nickname: '老王', ordinal: 1, sport: '跑步', quantity: 60, unit: 'min' },
  ]);
  assert.equal(legacy.totalCaloriesSum, 480);
});

test('严格：三条补充贴 30/20/50 分钟完整累加，第三条不被误判重复贴', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min', kcal: 300 },
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 20, unit: 'min', kcal: 200 },
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 50, unit: 'min', kcal: 500 },
  ]);
  assert.equal(data.totalMinutesSum, 100);
  assert.equal(data.totalCaloriesSum, 1000);
  assert.equal(data.calorieCoverage.reported, 1);
});

test('严格：mixed 合并行不得被写成「全部实测」，三类覆盖率分开记', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min', kcal: 300 },
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 15, unit: 'min' }, // MET 8×70×0.25 = 140
  ]);
  assert.equal(data.totalCaloriesSum, 440);
  assert.equal(data.calorieCoverage.reported, 0);
  assert.equal(data.calorieCoverage.estimated, 0);
  assert.equal(data.calorieCoverage.mixed, 1);
  assert.equal(data.calorieCoverage.total, 1);
  assert.doesNotMatch(data.calorieCoverage.note, /全部取接龙实测值/);
  assert.match(data.calorieCoverage.note, /含 MET 折算/);
});

test('严格：session 组内显式 ordinal 出现在后面，仍只算 1 次打卡', () => {
  const data = run([
    { nickname: '阿明', session: 'L1', sport: '游泳', quantity: 53, unit: 'min', kcal: 613 },
    { nickname: '阿明', session: 'L1', ordinal: 2, sport: '羽毛球', quantity: 30, unit: 'min', kcal: 200 },
  ]);
  assert.equal(rowOf(data, '阿明').checkinCount, 1);
  assert.equal(data.totalCaloriesSum, 813);
});

test('严格：同一行写了两个不同「第 N 次」→ 整期拦下', () => {
  assert.throws(
    () => run([
      { nickname: '阿明', session: 'L1', ordinal: 1, sport: '游泳', quantity: 53, unit: 'min', kcal: 613 },
      { nickname: '阿明', session: 'L1', ordinal: 2, sport: '羽毛球', quantity: 30, unit: 'min', kcal: 200 },
    ]),
    /分组标注冲突/
  );
});

test('严格：小数 kcal 四舍五入计入', () => {
  const data = run([
    { nickname: '阿明', sport: '游泳', quantity: 53, unit: 'min', kcal: 613.5 },
  ]);
  assert.equal(data.totalCaloriesSum, 614);
});
