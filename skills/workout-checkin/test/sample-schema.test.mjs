/**
 * data.sample.json 契约守卫（结构 + 取值域）
 *
 * 定位：assets/data.sample.json 是「结构与取值样例」，只服务于人/AI 参照与测试，
 *       不参与任何生产链路（初始化用 members.sample.*，真实产出由 calc 生成）。
 *       因此其中的人员是化名占位，不要求覆盖全名单、也不要求剧情自洽；
 *       但**字段集与字段取值必须与 calc / 模板契约保持同步**——本文件负责锁死这一点。
 *
 * 覆盖：顶层字段集、metSnapshot、cumulative 成员/周记录字段集、
 *       枚举值域（statusClass / personaClass / spotlight.type / badge / capsule.style）、
 *       可推导数值（徽章等级、星级得主、百分比与角度闭环、条宽排序）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, copyFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { streakCapsule, badgeLevel, buildBadgeIntro, streakCapsuleTiers, EFFICIENCY_STAR_MIN_MINUTES } from '../scripts/cumulative.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(testDir, 'fixtures');
const skillDir = resolve(testDir, '..');
const samplePath = resolve(skillDir, 'assets/data.sample.json');
const membersPath = resolve(skillDir, 'assets/members.sample.json');
const calcPath = resolve(skillDir, 'scripts/calc.mjs');

const sample = JSON.parse(readFileSync(samplePath, 'utf-8'));
const members = JSON.parse(readFileSync(membersPath, 'utf-8'));

const SPOTLIGHT_LABELS = {
  recordBreaker: '破纪录',
  return: '回归战士',
  efficiencyStar: '燃效之星',
  progressStar: '进步之星',
  calorieKing: '消耗之星',
};

/** 在临时目录跑一次 calc，拿到当前真实输出（上期归档沿用 fixture，保证趋势字段齐备） */
function buildFreshData() {
  const ws = mkdtempSync(resolve(tmpdir(), 'wk-sample-'));
  try {
    copyFileSync(resolve(fixturesDir, 'mock-records.json'), resolve(ws, 'records.json'));
    mkdirSync(resolve(ws, 'reports'), { recursive: true });
    copyFileSync(resolve(fixturesDir, 'prev-report.json'), resolve(ws, 'reports/2026-issue01.json'));
    const out = resolve(ws, 'data.json');
    const r = spawnSync(
      process.execPath,
      [calcPath, resolve(ws, 'records.json'), '--members', resolve(fixturesDir, 'members.test.json'), '--week', '2026-10-15', '-o', out],
      { encoding: 'utf-8' }
    );
    assert.equal(r.status, 0, `calc 失败：${r.stderr}`);
    assert.ok(existsSync(out));
    return JSON.parse(readFileSync(out, 'utf-8'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

test('结构：顶层字段集与 calc 当前输出一致', () => {
  const fresh = buildFreshData();
  const sampleKeys = Object.keys(sample).sort();
  const freshKeys = Object.keys(fresh).sort();
  const missing = freshKeys.filter((k) => !sampleKeys.includes(k));
  const stale = sampleKeys.filter((k) => !freshKeys.includes(k));
  assert.deepEqual(missing, [], `sample 缺少 calc 新增字段：${missing.join(', ')}`);
  assert.deepEqual(stale, [], `sample 含 calc 已废弃字段：${stale.join(', ')}`);
});

test('结构：metSnapshot 与 members.sample.json 的 met 同步', () => {
  const snapMet = sample.metSnapshot.met;
  const missing = Object.keys(members.met).filter((k) => !(k in snapMet));
  const extra = Object.keys(snapMet).filter((k) => !(k in members.met));
  assert.deepEqual(missing, [], `metSnapshot 缺少项目：${missing.join(', ')}`);
  assert.deepEqual(extra, [], `metSnapshot 含已移除项目：${extra.join(', ')}`);
  for (const [sport, met] of Object.entries(members.met)) {
    assert.equal(snapMet[sport], met, `metSnapshot.${sport} 与 members.json 不一致`);
  }
  assert.deepEqual(sample.metSnapshot.convert, members.convert, 'metSnapshot.convert 与 members.json 不一致');
});

test('结构：cumulative.members / recentWeeks 字段集与 calc 输出一致', () => {
  const fresh = buildFreshData();
  const freshMember = Object.values(fresh.cumulative.members)[0];
  const freshWeek = freshMember.recentWeeks[0];
  for (const [nick, cum] of Object.entries(sample.cumulative.members)) {
    assert.deepEqual(
      Object.keys(cum).sort(), Object.keys(freshMember).sort(),
      `cumulative.members.${nick} 字段集与 calc 输出不一致`
    );
    assert.ok(['met', 'partial', 'leave', 'absent'].includes(cum.lastStatus), `${nick}.lastStatus 非法`);
    for (const w of cum.recentWeeks) {
      assert.deepEqual(Object.keys(w).sort(), Object.keys(freshWeek).sort(), `${nick}.recentWeeks 字段集不一致`);
      assert.ok(['met', 'partial', 'leave', 'absent'].includes(w.status), `${nick}.recentWeeks.status 非法`);
    }
  }
});

test('取值：checkinList 派生字段结构、枚举与胶囊口径', () => {
  const capsuleKeys = Object.keys(streakCapsule(2)).sort();
  const capsuleStyles = new Set(streakCapsuleTiers().map((t) => t.style));
  const personaClasses = new Set(['burn', 'balance', 'relax', null]);

  for (const item of sample.checkinList) {
    assert.ok(['success', 'warning', 'danger'].includes(item.statusClass), `${item.nickname} statusClass 非法`);
    assert.ok(personaClasses.has(item.personaClass), `${item.nickname} personaClass 非法：${item.personaClass}`);
    assert.ok(
      ['达标', '未打卡'].includes(item.gapText) || /^差 \d+ 次$|^达标\+\d+请假$/.test(item.gapText),
      `${item.nickname} gapText 文案不合契约：${item.gapText}`
    );

    if (item.streakCapsule) {
      assert.deepEqual(
        Object.keys(item.streakCapsule).sort(), capsuleKeys,
        `${item.nickname} streakCapsule 字段与 streakCapsule() 输出不一致`
      );
      assert.equal(item.streakCapsule.streak, item.streak, `${item.nickname} 胶囊连击与 streak 不一致`);
      assert.ok(capsuleStyles.has(item.streakCapsule.style), `${item.nickname} 胶囊 style 非法：${item.streakCapsule.style}`);
      const expectEmoji = { legendaryGlow: '👑', flameGold: '🔥' }[item.streakCapsule.style] || null;
      assert.equal(item.streakCapsule.emoji, expectEmoji, `${item.nickname} 胶囊 emoji 与档位不符`);
    } else {
      assert.ok(item.streak < 2, `${item.nickname} streak≥2 时不应为 null 胶囊`);
    }
  }
});

test('取值：spotlight / spotlights 类型与标签一一对应', () => {
  const checkSpot = (obj, where) => {
    assert.ok(obj.type in SPOTLIGHT_LABELS, `${where}.type 非法：${obj.type}`);
    assert.equal(obj.label, SPOTLIGHT_LABELS[obj.type], `${where}.label 与 type 不匹配`);
  };
  for (const item of sample.checkinList) if (item.spotlight) checkSpot(item.spotlight, `${item.nickname}.spotlight`);
  for (const [nick, sp] of Object.entries(sample.spotlights)) checkSpot(sp, `spotlights.${nick}`);
  for (const [nick, sp] of Object.entries(sample.spotlights)) {
    const row = sample.checkinList.find((c) => c.nickname === nick);
    assert.ok(row, `spotlights 含名单外成员：${nick}`);
    assert.deepEqual(sp, row.spotlight, `spotlights.${nick} 与名单行内 spotlight 不一致`);
  }
});

test('取值：里程碑等级与 badges 阈值自洽', () => {
  const intro = buildBadgeIntro(members);
  const metaByKey = Object.fromEntries(intro.map((b) => [b.key, b]));
  for (const c of sample.milestoneCelebrations) {
    const meta = metaByKey[c.badge];
    assert.ok(meta, `未知徽章：${c.badge}`);
    assert.equal(c.label, meta.name, `里程碑 label 与徽章名不一致：${c.label} vs ${meta.name}`);
    assert.equal(c.unit, meta.unit, '里程碑 unit 与徽章单位不一致');
    const tiers = members.badges[c.badge];
    const expectLv = badgeLevel(c.value, tiers, meta.isStreak);
    assert.equal(c.level, expectLv, `${c.label} 等级与阈值不符（value=${c.value} 应为 Lv${expectLv}）`);
  }
});

test('取值：星级得主与名单数值一致、进步之星需 ≥4 期历史', () => {
  const maxKcal = Math.max(...sample.checkinList.map((m) => m.totalCalories));
  // 燃效之星口径：avgMET = Σ(MET×分钟)/Σ分钟，需本周时长 ≥ EFFICIENCY_STAR_MIN_MINUTES 分钟
  const eligible = sample.checkinList.filter((m) => m.totalMinutes >= EFFICIENCY_STAR_MIN_MINUTES);
  const maxAvgMet = Math.max(...eligible.map((m) => m.loadScore / m.totalMinutes));

  if (sample.calorieKing) {
    assert.equal(sample.calorieKing.kcal, maxKcal, '消耗之星 kcal 不等于名单最高消耗');
    const row = sample.checkinList.find((m) => m.nickname === sample.calorieKing.nickname);
    assert.equal(row?.totalCalories, maxKcal, '消耗之星得主不是名单消耗第一');
  }
  if (sample.efficiencyStar) {
    assert.equal(sample.efficiencyStar.avgMet, Math.round(maxAvgMet * 10) / 10, '燃效之星 avgMet 不等于名单最高平均强度');
    const row = sample.checkinList.find((m) => m.nickname === sample.efficiencyStar.nickname);
    assert.ok(row && row.totalMinutes >= EFFICIENCY_STAR_MIN_MINUTES, `燃效之星得主本周时长不足 ${EFFICIENCY_STAR_MIN_MINUTES} 分钟`);
    assert.equal(Math.round((row.loadScore / row.totalMinutes) * 10) / 10, sample.efficiencyStar.avgMet,
      '燃效之星得主 avgMET 与名单数值不一致');
  }
  if (sample.progressStar) {
    const cum = sample.cumulative.members[sample.progressStar.nickname];
    assert.ok(cum && cum.recentWeeks.length >= 4, '进步之星要求该成员 ≥4 期历史（recentWeeks）');
  }
});

test('取值：百分比与角度口径（整数 / 1 位小数 / 闭环）', () => {
  const d = sample;
  for (const k of ['totalMembers', 'metCount', 'notMetCount', 'targetRate', 'checkinCount', 'leaveCount', 'absentCount',
    'redPacketTotal', 'totalPeople', 'totalMinutesSum', 'totalCaloriesSum']) {
    assert.ok(Number.isInteger(d[k]), `${k} 应为整数：${d[k]}`);
  }
  assert.equal(d.targetRate, Math.round((d.metCount / d.totalMembers) * 100), 'targetRate 口径错');
  assert.equal(d.checkinPercent, Math.round((d.checkinCount / d.totalMembers) * 100), 'checkinPercent 口径错');
  assert.equal(d.leavePercent, Math.round((d.leaveCount / d.totalMembers) * 100), 'leavePercent 口径错');
  assert.equal(d.absentPercent, Math.round((d.absentCount / d.totalMembers) * 100), 'absentPercent 口径错');
  assert.equal(d.absentCount, d.totalMembers - d.checkinCount - d.leaveCount, 'absentCount 应为总数−打卡−请假');

  for (const k of ['targetRateAngle', 'checkinAngle', 'leaveAngle', 'absentAngle']) {
    assert.equal(Math.round(d[k] * 10) / 10, d[k], `${k} 应保留 1 位小数：${d[k]}`);
  }
  assert.equal(d.targetRateAngle, Math.round(d.targetRate * 3.6 * 10) / 10, 'targetRateAngle 口径错');
  assert.equal(d.checkinAngle, Math.round(d.checkinPercent * 3.6 * 10) / 10, 'checkinAngle 口径错');
  assert.equal(d.leaveAngle, Math.round(d.leavePercent * 3.6 * 10) / 10, 'leaveAngle 口径错');
  assert.equal(d.absentAngle, Math.round((360 - d.checkinAngle - d.leaveAngle) * 10) / 10, 'absentAngle 应为 360 闭环');
});

test('取值：运动项目条宽与排序口径', () => {
  const counts = sample.sportStats.map((s) => s.count);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), 'sportStats 应按人次降序');
  const max = counts[0];
  for (const s of sample.sportStats) {
    assert.equal(s.barWidthPercent, Math.round((s.count / max) * 100), `${s.name} barWidthPercent 口径错`);
  }
  if (sample.hasOtherSports) {
    assert.equal(sample.otherBarWidthPercent, Math.round((sample.otherSportTotal / max) * 100), 'otherBarWidthPercent 口径错');
  }
});

test('取值：sportStats 子字段集与 calc 同步，人次/时长派生量闭环', () => {
  const fresh = buildFreshData();
  const freshItem = fresh.sportStats[0];
  assert.ok(freshItem, 'calc 未产出 sportStats，无法校验子字段');
  for (const s of sample.sportStats) {
    assert.deepEqual(
      Object.keys(s).sort(),
      Object.keys(freshItem).sort(),
      `${s.name} 的 sportStats 子字段集与 calc 输出不一致（insights 取材字段不能单边新增）`
    );
    assert.equal(
      s.kcalPerMin,
      s.minutes > 0 ? Math.round((s.calories / s.minutes) * 10) / 10 : 0,
      `${s.name} kcalPerMin 应 = calories ÷ minutes`
    );
  }
  // 「其他」聚合不计入 sportStats，闭环时须加回 otherSportTotal
  const sumCount = sample.sportStats.reduce((a, s) => a + s.count, 0) + (sample.hasOtherSports ? sample.otherSportTotal : 0);
  assert.equal(sample.totalSessions, sumCount, 'totalSessions 应等于全群人次数（含「其他」聚合）');
  assert.equal(
    sample.avgMinutesPerSession,
    sample.totalSessions > 0 ? Math.round(sample.totalMinutesSum / sample.totalSessions) : 0,
    'avgMinutesPerSession 的分母是人次，不是人数'
  );
});
