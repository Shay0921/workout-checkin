/**
 * 本周之星口径回归
 *
 * 进步之星判定与展示统一为真实 kcal/min，返回值与体重解耦。
 * 燃效之星可由 members.json 的 efficiencyStarMetric 切到真实 kcal/min 排名；
 * 默认 avgMet（体重归一），且三星卡 / 蝉联 / spotlight 三处口径必须一致。
 *
 * 归档、达标线、红包、徽章档位、recentWeeks 一律不碰。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import {
  computeStars,
  computeSpotlights,
  buildCumulative,
  resolveEfficiencyMetric,
  EFFICIENCY_STAR_MIN_MINUTES,
  defaultMemberCumulative,
  defaultGroupCumulative,
  EFFICIENCY_STAR_METRICS,
} from '../scripts/cumulative.mjs';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const config = JSON.parse(readFileSync(resolve(fixturesDir, 'members.test.json'), 'utf-8'));

/** 构造 memberStats：显式给 loadScore，模拟「强度」与「真实消耗速率」排序相反的情形 */
const ms = (overrides) => ({
  nickname: '甲',
  lastStatus: 'met',
  checkinCount: 3,
  totalMinutes: 100,
  totalCalories: 500,
  redPacketAmount: 0,
  sports: { 跑步: 3 },
  weightKg: 60,
  loadScore: 500,
  ...overrides,
});

// 甲：强度高（avgMet 8.0）但真实消耗速率低（5.0 kcal/min）
// 乙：强度低（avgMet 4.0）但真实消耗速率高（9.0 kcal/min）——体重/设备差异的典型样本
// 丙：速率极高但只有 20 分钟，应被参与门槛挡在榜外
const memberStats = [
  ms({ nickname: '甲', totalMinutes: 100, totalCalories: 500, loadScore: 800 }),
  ms({ nickname: '乙', totalMinutes: 100, totalCalories: 900, loadScore: 400 }),
  ms({ nickname: '丙', totalMinutes: 20, totalCalories: 400, loadScore: 1000 }),
];

test('resolveEfficiencyMetric：缺失/拼错一律回退默认 avgMet', () => {
  assert.deepEqual(EFFICIENCY_STAR_METRICS, ['avgMet', 'kcalPerMin']);
  assert.equal(resolveEfficiencyMetric(null), 'avgMet');
  assert.equal(resolveEfficiencyMetric({}), 'avgMet');
  assert.equal(resolveEfficiencyMetric({ efficiencyStarMetric: 'avgMet' }), 'avgMet');
  assert.equal(resolveEfficiencyMetric({ efficiencyStarMetric: 'kcalPerMin' }), 'kcalPerMin');
  assert.equal(resolveEfficiencyMetric({ efficiencyStarMetric: 'KCAL' }), 'avgMet');
  assert.equal(resolveEfficiencyMetric({ efficiencyStarMetric: 1 }), 'avgMet');
});

test('默认 avgMet：得主按平均训练强度，附带该人真实 kcal/min 但不参与排名', () => {
  const stars = computeStars({ memberStats, prevCumulative: null });
  const es = stars.efficiencyStar;
  assert.equal(es.nickname, '甲', '默认口径应比强度，甲 avgMet 8.0 > 乙 4.0');
  assert.equal(es.metric, 'avgMet');
  assert.equal(es.unit, 'MET');
  assert.equal(es.value, 8.0);
  assert.equal(es.realKcalPerMin, 5.0, '附带值应是得主真实 500/100，不是榜首速率 9.0');
});

test('kcalPerMin：得主切换为真实消耗速率第一，value/unit 同步', () => {
  const stars = computeStars({ memberStats, prevCumulative: null, efficiencyMetric: 'kcalPerMin' });
  const es = stars.efficiencyStar;
  assert.equal(es.nickname, '乙', '真实口径应由 9.0 kcal/min 的乙胜出');
  assert.equal(es.metric, 'kcalPerMin');
  assert.equal(es.unit, 'kcal/min');
  assert.equal(es.value, 9.0);
  assert.equal(es.realKcalPerMin, 9.0);
});

test('两种口径都保留 ≥30 分钟参与门槛，短时高比率刷不了榜', () => {
  for (const metric of EFFICIENCY_STAR_METRICS) {
    const stars = computeStars({ memberStats, prevCumulative: null, efficiencyMetric: metric });
    assert.notEqual(stars.efficiencyStar.nickname, '丙', `${metric} 不得让 20 分钟的丙上榜`);
  }
  assert.equal(EFFICIENCY_STAR_MIN_MINUTES, 30);
});

test('B 口径贯穿三处：三星卡 / 蝉联统计 / spotlight 徽章指向同一人', () => {
  const cfg = { ...config, efficiencyStarMetric: 'kcalPerMin' };
  const prev = {
    group: defaultGroupCumulative(),
    members: {
      甲: { ...defaultMemberCumulative(), lastStatus: 'met', bestCalories: 2000 },
      乙: { ...defaultMemberCumulative(), lastStatus: 'met', bestCalories: 2000 },
      丙: { ...defaultMemberCumulative(), lastStatus: 'met', bestCalories: 2000 },
    },
  };

  const stars = computeStars({ memberStats, prevCumulative: prev, efficiencyMetric: resolveEfficiencyMetric(cfg) });
  const cum = buildCumulative({ prevCumulative: prev, memberStats, config: cfg, issueNo: 2, weekStart: '2026-10-12' });
  const sp = computeSpotlights({ memberStats, prevCumulative: prev, config: cfg });

  assert.equal(stars.efficiencyStar.nickname, '乙', '三星卡口径');
  assert.equal(cum.group.efficiencyStarStreak.nickname, '乙', '蝉联统计口径');
  assert.equal(sp['乙']?.type, 'efficiencyStar', 'spotlight 徽章口径');
  assert.equal(stars.calorieKing.nickname, '乙', '消耗之星不受燃效口径影响');
});

test('不传 config 时 computeSpotlights / buildCumulative 仍按默认 avgMet（旧调用零回归）', () => {
  const cum = buildCumulative({ prevCumulative: null, memberStats, config, issueNo: 1, weekStart: '2026-10-12' });
  assert.equal(cum.group.efficiencyStarStreak.nickname, '甲');
  const stars = computeStars({ memberStats, prevCumulative: null });
  assert.equal(stars.efficiencyStar.nickname, '甲');
});

test('切换燃效口径不改变任何能量/历史数值（recentWeeks / totalCalories / minutes）', () => {
  const prev = {
    group: defaultGroupCumulative(),
    members: {
      甲: { ...defaultMemberCumulative(), recentWeeks: [{ issue: 1, minutes: 90, calories: 430, checkins: 1, status: 'met', redPacket: 0 }] },
      乙: { ...defaultMemberCumulative(), recentWeeks: [{ issue: 1, minutes: 60, calories: 300, checkins: 1, status: 'met', redPacket: 0 }] },
      丙: { ...defaultMemberCumulative() },
    },
  };
  const base = buildCumulative({ prevCumulative: prev, memberStats, config, issueNo: 2, weekStart: '2026-10-12' });
  const real = buildCumulative({
    prevCumulative: prev, memberStats,
    config: { ...config, efficiencyStarMetric: 'kcalPerMin' },
    issueNo: 2, weekStart: '2026-10-12',
  });
  assert.deepEqual(real.members['甲'].recentWeeks, base.members['甲'].recentWeeks, '历史周记录不得被重算');
  assert.equal(real.members['甲'].recentWeeks[0].calories, 430);
  assert.equal(real.members['甲'].totalCalories, base.members['甲'].totalCalories);
  assert.equal(real.group.totalCalories, base.group.totalCalories);
  assert.equal(real.group.totalMinutes, base.group.totalMinutes);
  assert.notEqual(real.group.efficiencyStarStreak.nickname, base.group.efficiencyStarStreak.nickname,
    '唯一差异应只落在星级得主');
});

test('A：进步之星返回真实 kcal/min，提升率不变且与体重彻底解耦', () => {
  const week = (issue, minutes, calories) => ({ issue, minutes, calories, checkins: 1, status: 'met', redPacket: 0 });
  const prev = {
    group: defaultGroupCumulative(),
    members: {
      甲: {
        ...defaultMemberCumulative(),
        lastStatus: 'met', bestCalories: 2000,
        recentWeeks: [week(1, 100, 500), week(2, 100, 500), week(3, 100, 500), week(4, 100, 500)],
      },
    },
  };
  const stats = [
    ms({ nickname: '甲', totalMinutes: 100, totalCalories: 750, loadScore: 800, weightKg: 35 }),
    ms({ nickname: '乙', totalMinutes: 100, totalCalories: 900, loadScore: 400 }), // 无历史，不参与
  ];
  const light = computeStars({ memberStats: stats, prevCumulative: prev });
  const heavy = computeStars({
    memberStats: stats.map((m) => m.nickname === '甲' ? { ...m, weightKg: 95 } : m),
    prevCumulative: prev,
  });

  assert.equal(light.progressStar.nickname, '甲');
  assert.equal(light.progressStar.prevKcalPerMin, 5, '前 3 周均值 = 500/100');
  assert.equal(light.progressStar.curKcalPerMin, 7.5, '本期 = 750/100');
  assert.equal(light.progressStar.improvement, 0.5, '提升率 (7.5-5)/5 = 50%');
  assert.equal(light.progressStar.prevAvgMet, undefined, '不输出 prevAvgMet/curMet 字段');
  assert.equal(light.progressStar.curMet, undefined);
  assert.deepEqual(heavy.progressStar, light.progressStar, '体重从 35 改到 95 不得影响任何返回字段');
});
