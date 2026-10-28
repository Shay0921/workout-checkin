/**
 * cumulative.mjs 单元测试
 * 覆盖：链式累计、streak 边界、attendanceStreak、recentWeeks 滚动、
 *       badgeLevel/nextTier、专精判定、人格标签、spotlight 优先级、默认值
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import {
  buildCumulative,
  canonicalizeCumulative,
  computeSpotlights,
  computeStars,
  computeStreakBreaks,
  buildBadgeCells,
  computePersona,
  getSportIntensityMap,
  primaryPersonaTag,
  computeMilestoneCelebrations,
  badgeLevel,
  nextTier,
  streakCapsule,
  buildBadgeIntro,
  streakCapsuleTiers,
  defaultMemberCumulative,
  defaultGroupCumulative,
} from '../scripts/cumulative.mjs';
import { buildNicknameIndex } from '../scripts/nickname.mjs';

const fixturesDir = dirname(fileURLToPath(import.meta.url)) + '/fixtures';
const config = JSON.parse(readFileSync(resolve(fixturesDir, 'members.test.json'), 'utf-8'));

/** 构造一个 memberStats 条目
 *  测试约定：体重固定 60kg，此时 loadScore ≡ totalCalories（MET×分钟 = kcal×60/体重），
 *  因此原「kcal/min」断言值可直接作为 avgMET 使用，排名不变。 */
const ms = (overrides) => {
  const merged = {
    nickname: '阿明',
    lastStatus: 'met',
    checkinCount: 3,
    totalMinutes: 100,
    totalCalories: 500,
    redPacketAmount: 0,
    sports: { 跑步: 3 },
    ...overrides,
  };
  return {
    ...merged,
    weightKg: overrides.weightKg ?? 60,
    loadScore: overrides.loadScore ?? merged.totalCalories,
  };
};

test('默认值：新成员补零', () => {
  const d = defaultMemberCumulative();
  assert.equal(d.streak, 0);
  assert.equal(d.bestStreak, 0);
  assert.equal(d.totalCheckins, 0);
  assert.equal(d.bestCalories, 0);
  assert.deepEqual(d.sports, {});
  assert.equal(d.lastStatus, 'absent');
  assert.deepEqual(d.recentWeeks, []);
});

test('canonicalizeCumulative：归档旧昵称按 aliases/归一化归到规范名', () => {
  const index = buildNicknameIndex([
    { nickname: '甲乙', aliases: ['甲旧名'], status: 'active' },
    { nickname: '乙~', aliases: [], status: 'active' },
  ]);
  const prev = {
    group: {
      ...defaultGroupCumulative(),
      issueCount: 6,
      efficiencyStarStreak: { nickname: '甲旧名', weeks: 2 },
      calorieKingStreak: { nickname: '乙', weeks: 1 },
    },
    members: {
      甲旧名: {
        ...defaultMemberCumulative(),
        streak: 4, bestStreak: 6, attendanceStreak: 5, metWeeks: 5,
        totalCheckins: 30, totalMinutes: 300, totalCalories: 3000, bestCalories: 800,
        sports: { 跑步: 30 }, lastStatus: 'met',
        recentWeeks: [{ issue: 6, minutes: 300, calories: 3000, checkins: 30, status: 'met', redPacket: 0 }],
      },
      // 仅差波浪号：归一化本身就能命中，不依赖 aliases
      乙: {
        ...defaultMemberCumulative(),
        streak: 2, totalCheckins: 10, totalCalories: 900,
        sports: { 游泳: 10 }, lastStatus: 'met',
      },
    },
  };

  const out = canonicalizeCumulative(prev, index);
  assert.deepEqual(Object.keys(out.members).sort(), ['乙~', '甲乙'].sort());
  assert.equal(out.members['甲乙'].totalCheckins, 30);
  assert.equal(out.members['甲乙'].sports['跑步'], 30);
  assert.equal(out.members['乙~'].totalCheckins, 10);
  assert.equal(out.group.efficiencyStarStreak.nickname, '甲乙');
  assert.equal(out.group.calorieKingStreak.nickname, '乙~');
  // 纯函数：不修改入参
  assert.ok(prev.members['甲旧名']);
  assert.equal(prev.members['甲乙'], undefined);
});

test('canonicalizeCumulative：改名后链式累计接续，旧 key 不再向下传递', () => {
  const index = buildNicknameIndex([{ nickname: '甲乙', aliases: ['甲旧名'], status: 'active' }]);
  const prev = {
    group: defaultGroupCumulative(),
    members: {
      甲旧名: {
        ...defaultMemberCumulative(),
        streak: 4, bestStreak: 6, metWeeks: 5,
        totalCheckins: 30, totalMinutes: 300, totalCalories: 3000,
        sports: { 跑步: 30 }, lastStatus: 'met',
        recentWeeks: [{ issue: 6, minutes: 300, calories: 3000, checkins: 30, status: 'met', redPacket: 0 }],
      },
    },
  };
  const canon = canonicalizeCumulative(prev, index);
  const cur = ms({ nickname: '甲乙', totalMinutes: 30, totalCalories: 240, checkinCount: 1, sports: { 跑步: 1 } });
  const cum = buildCumulative({ prevCumulative: canon, memberStats: [cur], config, issueNo: 7 });

  assert.equal(cum.members['甲乙'].streak, 5);
  assert.equal(cum.members['甲乙'].bestStreak, 6);
  assert.equal(cum.members['甲乙'].totalCheckins, 31);
  assert.equal(cum.members['甲乙'].totalCalories, 3240);
  assert.equal(cum.members['甲乙'].sports['跑步'], 31);
  assert.equal(cum.members['甲旧名'], undefined);
  assert.deepEqual(canonicalizeCumulative(canon, index), canon, '归一必须幂等');
  assert.deepEqual(canonicalizeCumulative(cum, index), cum, '新归档只含规范名，再次归一必须不变');
});

test('canonicalizeCumulative：新旧 key 并存时合并，当前状态取更晚一段', () => {
  const index = buildNicknameIndex([{ nickname: '甲乙', aliases: ['甲旧名'], status: 'active' }]);
  const prev = {
    group: { ...defaultGroupCumulative(), efficiencyStarStreak: { nickname: '甲乙', weeks: 2 } },
    members: {
      甲乙: {
        ...defaultMemberCumulative(),
        streak: 2, bestStreak: 3, metWeeks: 2, totalCheckins: 5, totalMinutes: 50, totalCalories: 500,
        sports: { 游泳: 5 }, lastStatus: 'met',
        recentWeeks: [{ issue: 6, minutes: 50, calories: 500, checkins: 5, status: 'met', redPacket: 0 }],
      },
      甲旧名: {
        ...defaultMemberCumulative(),
        streak: 4, bestStreak: 6, metWeeks: 3, totalCheckins: 10, totalMinutes: 100, totalCalories: 1000,
        sports: { 跑步: 10 }, lastStatus: 'met',
        recentWeeks: [{ issue: 3, minutes: 100, calories: 1000, checkins: 10, status: 'met', redPacket: 0 }],
      },
    },
  };
  const m = canonicalizeCumulative(prev, index).members['甲乙'];
  assert.equal(m.totalCheckins, 15);
  assert.equal(m.totalMinutes, 150);
  assert.equal(m.totalCalories, 1500);
  assert.equal(m.metWeeks, 5);
  assert.equal(m.streak, 2);              // 更晚的一段（issue 6）
  assert.equal(m.bestStreak, 6);
  assert.deepEqual(m.sports, { 游泳: 5, 跑步: 10 });
  assert.deepEqual(m.recentWeeks.map((w) => w.issue), [3, 6]);
});

test('badgeLevel：未达第一档返回 0，逐级递增', () => {
  const tiers = [1000, 3000, 5000];
  assert.equal(badgeLevel(999, tiers), 0);
  assert.equal(badgeLevel(1000, tiers), 1);
  assert.equal(badgeLevel(2999, tiers), 1);
  assert.equal(badgeLevel(3000, tiers), 2);
  assert.equal(badgeLevel(5000, tiers), 3);
  assert.equal(badgeLevel(99999, tiers), 3); // 满级
});

test('badgeLevel：连击 30+ 等级继续（40→Lv6、50→Lv7）', () => {
  const tiers = config.badges.streak; // [3,5,10,20,30]（30 为最高展示档，之后每 +10 周等级继续）
  assert.equal(badgeLevel(2, tiers, true), 0);
  assert.equal(badgeLevel(3, tiers, true), 1);
  assert.equal(badgeLevel(5, tiers, true), 2);
  assert.equal(badgeLevel(10, tiers, true), 3);
  assert.equal(badgeLevel(20, tiers, true), 4);
  assert.equal(badgeLevel(30, tiers, true), 5);
  assert.equal(badgeLevel(40, tiers, true), 6);
  assert.equal(badgeLevel(42, tiers, true), 6);
  assert.equal(badgeLevel(50, tiers, true), 7);
  assert.equal(badgeLevel(60, tiers, true), 8);
});

test('nextTier：满级返回 null，连击 30+ 向上取整 +10', () => {
  const tiers = config.badges.streak;
  assert.equal(nextTier(2, tiers, true), 3);
  assert.equal(nextTier(10, tiers, true), 20);
  assert.equal(nextTier(30, tiers, true), 40);
  assert.equal(nextTier(39, tiers, true), 40);
  assert.equal(nextTier(40, tiers, true), 50); // 正好在档位上 → 指向下一档 50
  assert.equal(nextTier(41, tiers, true), 50);
  assert.equal(nextTier(50, tiers, true), 60);
  // 非连击满级
  assert.equal(nextTier(5000, [1000, 3000, 5000], false), null);
  assert.equal(nextTier(3000, [1000, 3000, 5000], false), 5000);
});

test('streakCapsule：<2 不显示，20–29 皇冠👑，30+ 真金火炼🔥', () => {
  assert.equal(streakCapsule(1), null);
  assert.equal(streakCapsule(2).style, 'lightGold');
  assert.equal(streakCapsule(5).style, 'darkGold');
  assert.equal(streakCapsule(15).style, 'darkGoldGlow');
  assert.equal(streakCapsule(25).style, 'legendaryGlow');
  assert.equal(streakCapsule(25).emoji, '👑');
  assert.equal(streakCapsule(19).emoji, null);
  assert.equal(streakCapsule(29).isLegendary, false);
  assert.equal(streakCapsule(30).style, 'flameGold');
  assert.equal(streakCapsule(30).emoji, '🔥');
  assert.equal(streakCapsule(30).isLegendary, true);
  assert.equal(streakCapsule(50).isLegendary, true); // 真金火炼档每 +10 周延伸，样式不变
});

test('链式累计：首期 + 第二期累加正确', () => {
  const m1 = ms({ nickname: '阿明', totalMinutes: 100, totalCalories: 500, checkinCount: 3, sports: { 跑步: 3 } });
  const m2 = ms({ nickname: '小芳', totalMinutes: 60, totalCalories: 300, checkinCount: 3, sports: { 瑜伽: 3 } });

  const cum1 = buildCumulative({ prevCumulative: null, memberStats: [m1, m2], config, issueNo: 1 });
  assert.equal(cum1.group.issueCount, 1);
  assert.equal(cum1.group.totalCheckins, 6);
  assert.equal(cum1.group.totalMinutes, 160);
  assert.equal(cum1.group.totalCalories, 800);
  assert.equal(cum1.members['阿明'].streak, 1);
  assert.equal(cum1.members['阿明'].totalCalories, 500);

  // 第二期
  const m1b = ms({ nickname: '阿明', totalMinutes: 80, totalCalories: 400, checkinCount: 2, sports: { 跑步: 2 } });
  const m2b = ms({ nickname: '小芳', lastStatus: 'leave', totalMinutes: 0, totalCalories: 0, checkinCount: 0, sports: {} });
  const cum2 = buildCumulative({ prevCumulative: cum1, memberStats: [m1b, m2b], config, issueNo: 2 });

  assert.equal(cum2.group.issueCount, 2);
  assert.equal(cum2.members['阿明'].streak, 2); // met → +1
  assert.equal(cum2.members['阿明'].totalCalories, 900); // 500 + 400
  assert.equal(cum2.members['小芳'].streak, 0); // leave → 归 0
  assert.equal(cum2.members['小芳'].totalMinutes, 60); // 不变
});

test('streak 边界：仅 met+1；leave/partial/absent 一律归 0 / bestStreak 取最大', () => {
  const prev = { group: defaultGroupCumulative(), members: { 阿明: { ...defaultMemberCumulative(), streak: 3, bestStreak: 5 } } };

  const met = ms({ lastStatus: 'met' });
  const cum1 = buildCumulative({ prevCumulative: prev, memberStats: [met], config, issueNo: 2 });
  assert.equal(cum1.members['阿明'].streak, 4);
  assert.equal(cum1.members['阿明'].bestStreak, 5);

  const leave = ms({ lastStatus: 'leave' });
  const cum2 = buildCumulative({ prevCumulative: prev, memberStats: [leave], config, issueNo: 2 });
  assert.equal(cum2.members['阿明'].streak, 0); // 整周请假 → 归 0

  const partial = ms({ lastStatus: 'partial' });
  const cum3 = buildCumulative({ prevCumulative: prev, memberStats: [partial], config, issueNo: 2 });
  assert.equal(cum3.members['阿明'].streak, 0);
  assert.equal(cum3.members['阿明'].bestStreak, 5); // bestStreak 保持
});

test('attendanceStreak：有打卡+1、0 打卡归 0', () => {
  const prev = { group: defaultGroupCumulative(), members: { 阿明: { ...defaultMemberCumulative(), attendanceStreak: 2 } } };
  const withCheckin = ms({ checkinCount: 1 });
  const cum1 = buildCumulative({ prevCumulative: prev, memberStats: [withCheckin], config, issueNo: 2 });
  assert.equal(cum1.members['阿明'].attendanceStreak, 3);

  const noCheckin = ms({ checkinCount: 0, totalMinutes: 0, totalCalories: 0, sports: {} });
  const cum2 = buildCumulative({ prevCumulative: prev, memberStats: [noCheckin], config, issueNo: 2 });
  assert.equal(cum2.members['阿明'].attendanceStreak, 0);
});

test('recentWeeks 滚动窗口：超 4 条 shift 最旧', () => {
  const prevWeeks = [1, 2, 3, 4].map((i) => ({ issue: i, minutes: 10, calories: 50, checkins: 1, status: 'met', redPacket: 0 }));
  const prev = { group: defaultGroupCumulative(), members: { 阿明: { ...defaultMemberCumulative(), recentWeeks: prevWeeks } } };
  const cur = ms({ totalMinutes: 20, totalCalories: 100 });
  const cum = buildCumulative({ prevCumulative: prev, memberStats: [cur], config, issueNo: 5 });
  const rw = cum.members['阿明'].recentWeeks;
  assert.equal(rw.length, 4);
  assert.equal(rw[0].issue, 2); // 最旧的 issue 1 被 shift
  assert.equal(rw[3].issue, 5);
});

test('sports 保留真实项目名（专精聚合由 computePersona 负责）', () => {
  const cur = ms({ sports: { 自由活动: 3, 自由训练: 2, 跑步: 1 } });
  const cum = buildCumulative({ prevCumulative: null, memberStats: [cur], config, issueNo: 1 });
  const sports = cum.members['阿明'].sports;
  assert.equal(sports['自由活动'], 3);
  assert.equal(sports['自由训练'], 2);
  assert.equal(sports['跑步'], 1);
});

test('computePersona 按 sportNickname 聚合：自由活动+自由训练 → 多面手 合并', () => {
  // 多面手 3+2=5（中强度门槛 15 未达）；追风者 1（高强度门槛 10 未达）→ 均无专精
  const p = computePersona({ sports: { 自由活动: 3, 自由训练: 2, 跑步: 1 }, config });
  assert.equal(p.specializations.length, 0);

  // 自由活动 15 + 自由训练 10 = 多面手 25 ≥ 中强度门槛 15 → 专精多面手
  const p2 = computePersona({ sports: { 自由活动: 15, 自由训练: 10 }, config });
  assert.equal(p2.specializations.length, 1);
  assert.equal(p2.specializations[0].nickname, '多面手');
  assert.equal(p2.specializations[0].count, 25);
});

test('人格标签：专精次数门槛（高 10 / 中 15 / 低 25）', () => {
  // 跑步 MET=8 高强度，门槛 10
  const p1 = computePersona({ sports: { 追风者: 10 }, config });
  assert.equal(p1.specializations.length, 1);
  assert.equal(p1.specializations[0].nickname, '追风者');

  // 瑜伽 MET=4.0 中强度，门槛 15；14 次不达标
  const p2 = computePersona({ sports: { 柔韧大师: 14 }, config });
  assert.equal(p2.specializations.length, 0);

  // 散步 MET=3.5 低强度，门槛 25
  const p3 = computePersona({ sports: { 街巷行者: 25 }, config });
  assert.equal(p3.specializations.length, 1);
});

test('人格标签：燃烧系/松弛系 >60%，其余一律均衡系（兜底）', () => {
  // 高强度占比 > 60% → 燃烧系
  const p1 = computePersona({ sports: { 追风者: 7, 柔韧大师: 3 }, config });
  assert.equal(p1.intensityType, '燃烧系');

  // 低强度占比 > 60% → 松弛系
  const p2 = computePersona({ sports: { 街巷行者: 7, 追风者: 3 }, config });
  assert.equal(p2.intensityType, '松弛系');

  // 中强度占比 > 60% → 均衡系（fixture：跳操 MET 6.0 → 操课达人 中强度）
  const p4 = computePersona({ sports: { 操课达人: 7, 追风者: 3 }, config });
  assert.equal(p4.intensityType, '均衡系');

  // 三档均不突出（各 50%）→ 兜底均衡系
  const p3 = computePersona({ sports: { 追风者: 5, 柔韧大师: 5 }, config });
  assert.equal(p3.intensityType, '均衡系');
});

test('intensityOverride：手工覆盖项目强度档（影响分型与专精门槛）', () => {
  // 力训 MET 6.0 默认中强度，override 上调为高强度
  const p1 = computePersona({ sports: { 撸铁狂人: 7, 柔韧大师: 3 }, config });
  assert.equal(p1.intensityType, '燃烧系');
  // 爬楼 MET 8.0 默认高强度，override 下调为中强度
  const p2 = computePersona({ sports: { 楼宇攀登者: 7, 追风者: 3 }, config });
  assert.equal(p2.intensityType, '均衡系');
  // 强度映射本身（fixture 无骑行昵称，key = 项目名「骑行」）
  const map = getSportIntensityMap(config);
  assert.equal(map['撸铁狂人'], 'high');
  assert.equal(map['骑行'], 'high');
  assert.equal(map['楼宇攀登者'], 'mid');
  assert.equal(map['绳上飞人'], 'mid');
});

test('primaryPersonaTag：有专精取专精，无专精取强度分型', () => {
  const p1 = computePersona({ sports: { 追风者: 10, 柔韧大师: 1 }, config });
  assert.equal(primaryPersonaTag(p1), '追风者');

  const p2 = computePersona({ sports: { 追风者: 2, 柔韧大师: 1 }, config });
  assert.equal(p2.specializations.length, 0);
  assert.equal(primaryPersonaTag(p2), '燃烧系');
});

test('spotlight：消耗之星 / 燃效之星 / 破纪录 / 回归', () => {
  const memberStats = [
    ms({ nickname: '阿明', totalMinutes: 100, totalCalories: 1000 }), // 消耗之星
    ms({ nickname: '小芳', totalMinutes: 50, totalCalories: 600 }),   // 燃效之星(12) > 阿明(10)
  ];
  const prev = {
    group: defaultGroupCumulative(),
    members: {
      阿明: { ...defaultMemberCumulative(), bestCalories: 800, lastStatus: 'met' },
      小芳: { ...defaultMemberCumulative(), bestCalories: 600, lastStatus: 'partial' },
    },
  };
  const sp = computeSpotlights({ memberStats, prevCumulative: prev });

  // 阿明：消耗之星(1000) + 破纪录(1000>800) → 优先级破纪录
  assert.equal(sp['阿明'].label, '破纪录');
  // 小芳：燃效之星(600/50=12)——partial→met 不产生标签
  assert.equal(sp['小芳'].label, '燃效之星');
});

test('spotlight：上期未达标本期达标不产生任何标签', () => {
  const memberStats = [
    ms({ nickname: '阿明', totalMinutes: 60, totalCalories: 400 }),   // eff 6.7，低于小芳
    ms({ nickname: '小芳', totalMinutes: 60, totalCalories: 600 }),   // 燃效/消耗之星
  ];
  const prev = { group: defaultGroupCumulative(), members: { 阿明: { ...defaultMemberCumulative(), bestCalories: 9999, lastStatus: 'absent' } } };
  const sp = computeSpotlights({ memberStats, prevCumulative: prev });
  assert.equal(sp['阿明'], undefined);
});

test('spotlight：回归战士（上期 leave → 本期 met）', () => {
  const memberStats = [ms({ nickname: '阿明', lastStatus: 'met' })];
  const prev = { group: defaultGroupCumulative(), members: { 阿明: { ...defaultMemberCumulative(), bestCalories: 500, lastStatus: 'leave' } } };
  const sp = computeSpotlights({ memberStats, prevCumulative: prev });
  assert.equal(sp['阿明'].label, '回归战士');
});

test('spotlight：进步之星（需 >3 周历史，相对前 3 周 kcal/min 均值正提升最大）', () => {
  const memberStats = [
    ms({ nickname: '阿明', totalMinutes: 100, totalCalories: 1000 }), // eff=10
    ms({ nickname: '小芳', totalMinutes: 100, totalCalories: 200 }),  // eff=2
  ];
  const prev = {
    group: defaultGroupCumulative(),
    members: {
      // 阿明前 4 周 kcal/min 均值 10 → 提升 0（不进入进步之星）
      阿明: { ...defaultMemberCumulative(), bestCalories: 1000, lastStatus: 'met', recentWeeks: [{ issue: 1, minutes: 100, calories: 1000, checkins: 1, status: 'met', redPacket: 0 }, { issue: 2, minutes: 100, calories: 1000, checkins: 1, status: 'met', redPacket: 0 }, { issue: 3, minutes: 100, calories: 1000, checkins: 1, status: 'met', redPacket: 0 }, { issue: 4, minutes: 100, calories: 1000, checkins: 1, status: 'met', redPacket: 0 }] },
      // 小芳前 4 周 kcal/min 均值 1 → 提升 (2-1)/1=100%
      小芳: { ...defaultMemberCumulative(), bestCalories: 200, lastStatus: 'met', recentWeeks: [{ issue: 1, minutes: 100, calories: 100, checkins: 1, status: 'met', redPacket: 0 }, { issue: 2, minutes: 100, calories: 100, checkins: 1, status: 'met', redPacket: 0 }, { issue: 3, minutes: 100, calories: 100, checkins: 1, status: 'met', redPacket: 0 }, { issue: 4, minutes: 100, calories: 100, checkins: 1, status: 'met', redPacket: 0 }] },
    },
  };
  const sp = computeSpotlights({ memberStats, prevCumulative: prev });
  // 小芳燃效提升更大 → 进步之星（但阿明同时是消耗之星/燃效之星，优先级高于进步之星）
  // 阿明：燃效之星(10) + 消耗之星(1000) → 燃效之星优先
  assert.equal(sp['阿明'].label, '燃效之星');
  assert.equal(sp['小芳'].label, '进步之星');
});

test('spotlight 优先级：破纪录 > 燃效之星 > 消耗之星', () => {
  const memberStats = [ms({ nickname: '阿明', totalMinutes: 100, totalCalories: 1000 })];
  const prev = { group: defaultGroupCumulative(), members: { 阿明: { ...defaultMemberCumulative(), bestCalories: 500 } } };
  const sp = computeSpotlights({ memberStats, prevCumulative: prev });
  // 阿明同时命中消耗之星 + 燃效之星 + 破纪录 → 破纪录
  assert.equal(sp['阿明'].type, 'recordBreaker');
});

test('efficiencyStarStreak：同一人连续 → weeks+1，换人重置', () => {
  const m1 = ms({ nickname: '阿明', totalMinutes: 100, totalCalories: 1000 });
  const cum1 = buildCumulative({ prevCumulative: null, memberStats: [m1], config, issueNo: 1 });
  assert.equal(cum1.group.efficiencyStarStreak.nickname, '阿明');
  assert.equal(cum1.group.efficiencyStarStreak.weeks, 1);

  const cum2 = buildCumulative({ prevCumulative: cum1, memberStats: [m1], config, issueNo: 2 });
  assert.equal(cum2.group.efficiencyStarStreak.weeks, 2); // 蝉联

  const m2 = ms({ nickname: '小芳', totalMinutes: 100, totalCalories: 2000 });
  const cum3 = buildCumulative({ prevCumulative: cum2, memberStats: [m2], config, issueNo: 3 });
  assert.equal(cum3.group.efficiencyStarStreak.nickname, '小芳');
  assert.equal(cum3.group.efficiencyStarStreak.weeks, 1); // 换人重置
});

test('calorieKingStreak：同一人连续 → weeks+1，换人重置', () => {
  const m1 = ms({ nickname: '阿明', totalMinutes: 60, totalCalories: 1000 });
  const cum1 = buildCumulative({ prevCumulative: null, memberStats: [m1], config, issueNo: 1 });
  assert.equal(cum1.group.calorieKingStreak.nickname, '阿明');
  assert.equal(cum1.group.calorieKingStreak.weeks, 1);

  const cum2 = buildCumulative({ prevCumulative: cum1, memberStats: [m1], config, issueNo: 2 });
  assert.equal(cum2.group.calorieKingStreak.weeks, 2); // 蝉联

  const m2 = ms({ nickname: '小芳', totalMinutes: 60, totalCalories: 2000 });
  const cum3 = buildCumulative({ prevCumulative: cum2, memberStats: [m2], config, issueNo: 3 });
  assert.equal(cum3.group.calorieKingStreak.nickname, '小芳');
  assert.equal(cum3.group.calorieKingStreak.weeks, 1); // 换人重置
});

test('里程碑庆祝：本期 badgeLevel > 上期 → 解锁', () => {
  const cur = ms({ nickname: '阿明', totalMinutes: 100, totalCalories: 1000 }); // fatBurner Lv1 (1000)
  const cum = buildCumulative({ prevCumulative: null, memberStats: [cur], config, issueNo: 1 });
  const celebs = computeMilestoneCelebrations({ cumulative: cum, prevCumulative: null, config });
  // 阿明累计消耗 1000 → 解锁燃脂狂魔 Lv1
  const fb = celebs.find((c) => c.badge === 'fatBurner');
  assert.ok(fb);
  assert.equal(fb.level, 1);
});

test('里程碑庆祝：连击断更后爬回不重复解锁，突破历史最高才庆祝', () => {
  // 第 1-10 周：连续达标 → streak 10（Lv3，首次解锁）
  let prev = null;
  let celebs = [];
  for (let i = 1; i <= 10; i++) {
    const cum = buildCumulative({ prevCumulative: prev, memberStats: [ms({})], config, issueNo: i });
    celebs = computeMilestoneCelebrations({ cumulative: cum, prevCumulative: prev, config });
    prev = cum;
  }
  assert.equal(prev.members['阿明'].streak, 10);
  assert.ok(celebs.some((c) => c.badge === 'streak' && c.level === 3)); // 首次解锁 LV3

  // 第 11 周：断更 → streak 归零，bestStreak 历史最高保留
  const brk = buildCumulative({
    prevCumulative: prev,
    memberStats: [ms({ lastStatus: 'partial', checkinCount: 0, sports: {} })],
    config,
    issueNo: 11,
  });
  prev = brk;
  assert.equal(prev.members['阿明'].streak, 0);
  assert.equal(prev.members['阿明'].bestStreak, 10);

  // 第 12-14 周：重新爬回 streak 3（Lv1）→ 历史已解锁过 LV3，不应重复庆祝
  for (let i = 12; i <= 14; i++) {
    const cum = buildCumulative({ prevCumulative: prev, memberStats: [ms({})], config, issueNo: i });
    const reCelebs = computeMilestoneCelebrations({ cumulative: cum, prevCumulative: prev, config });
    assert.equal(
      reCelebs.filter((c) => c.badge === 'streak').length, 0,
      `第 ${i} 周爬回已解锁等级不应重复庆祝连击`
    );
    prev = cum;
  }

  // 继续达标至 streak 20（Lv4）→ 突破历史最高 10（Lv3）→ 庆祝 LV4
  for (let i = 15; i <= 31; i++) {
    const cum = buildCumulative({ prevCumulative: prev, memberStats: [ms({})], config, issueNo: i });
    celebs = computeMilestoneCelebrations({ cumulative: cum, prevCumulative: prev, config });
    prev = cum;
  }
  assert.equal(prev.members['阿明'].streak, 20);
  const lv4 = celebs.find((c) => c.badge === 'streak');
  assert.ok(lv4, '突破历史最高连击应庆祝');
  assert.equal(lv4.level, 4);
});

test('computeStars：进步之星并列提升率时取本周燃效更高者（tie-break 统一）', () => {
  // 两人提升率同为 50%：小芳 curEff=3、阿明 curEff=7.5 → 阿明胜
  // 小芳排在前（若按遍历顺序先到先得会错选小芳，用于锁定 tie-break 行为）
  const memberStats = [
    ms({ nickname: '小芳', totalMinutes: 100, totalCalories: 300 }),  // eff=3
    ms({ nickname: '阿明', totalMinutes: 100, totalCalories: 750 }),  // eff=7.5
  ];
  const week = (issue, minutes, calories) => ({ issue, minutes, calories, checkins: 1, status: 'met', redPacket: 0 });
  const prev = {
    group: defaultGroupCumulative(),
    members: {
      // bestCalories 高于本周消耗 + lastStatus=met，排除破纪录干扰，专注验证进步之星 tie-break
      小芳: { ...defaultMemberCumulative(), lastStatus: 'met', bestCalories: 400, recentWeeks: [week(1, 100, 200), week(2, 100, 200), week(3, 100, 200), week(4, 100, 200)] }, // 前均值 2 → 提升 50%
      阿明: { ...defaultMemberCumulative(), lastStatus: 'met', bestCalories: 800, recentWeeks: [week(1, 100, 500), week(2, 100, 500), week(3, 100, 500), week(4, 100, 500)] }, // 前均值 5 → 提升 50%
    },
  };
  const stars = computeStars({ memberStats, prevCumulative: prev });
  assert.equal(stars.progressStar.nickname, '阿明'); // 并列 50% → curEff 7.5 > 3 胜出
  assert.equal(stars.calorieKing.nickname, '阿明');
  assert.equal(stars.efficiencyStar.nickname, '阿明');

  // spotlight 与 computeStars 口径一致（进步之星判定同源）
  const sp = computeSpotlights({ memberStats, prevCumulative: prev });
  assert.equal(sp['阿明'].label, '燃效之星'); // 阿明命中燃效之星+进步之星+消耗之星 → 优先级燃效之星
  assert.equal(sp['小芳'], undefined);        // 小芳并列落败且无其他星 → 无 spotlight
});

test('computeStreakBreaks：上期达标 → 本期未达标 = 断更提示（含宝座判定）', () => {
  const prev = {
    group: defaultGroupCumulative(),
    members: {
      阿明: { ...defaultMemberCumulative(), lastStatus: 'met', streak: 2 },
      小芳: { ...defaultMemberCumulative(), lastStatus: 'met', streak: 3 },
      老王: { ...defaultMemberCumulative(), lastStatus: 'partial', streak: 0 },
    },
  };
  const memberStats = [
    ms({ nickname: '阿明', lastStatus: 'absent', checkinCount: 0, totalMinutes: 0, totalCalories: 0, sports: {} }),
    ms({ nickname: '小芳', lastStatus: 'met' }),        // 连击延续 → 不提示
    ms({ nickname: '老王', lastStatus: 'partial' }),     // 上期未达标 → 不提示
  ];
  const current = {
    group: defaultGroupCumulative(),
    members: {
      阿明: { ...defaultMemberCumulative(), streak: 0 },
      小芳: { ...defaultMemberCumulative(), streak: 4 },
      老王: { ...defaultMemberCumulative(), streak: 0 },
    },
  };
  const breaks = computeStreakBreaks({ memberStats, prevCumulative: prev, currentCumulative: current });
  // 阿明 brokenStreak 2 < 小芳 3 → 非宝座持有者；新王 = 小芳（本期续到 4）
  assert.deepEqual(breaks, [
    { nickname: '阿明', brokenStreak: 2, wasTopStreak: false, newTop: { nickname: '小芳', streak: 4 } },
  ]);
});

test('computeStreakBreaks：宝座持有者断更 → wasTopStreak=true', () => {
  const prev = {
    group: defaultGroupCumulative(),
    members: {
      阿明: { ...defaultMemberCumulative(), lastStatus: 'met', streak: 5 },
      小芳: { ...defaultMemberCumulative(), lastStatus: 'met', streak: 3 },
    },
  };
  const memberStats = [
    ms({ nickname: '阿明', lastStatus: 'absent', checkinCount: 0, totalMinutes: 0, totalCalories: 0, sports: {} }),
    ms({ nickname: '小芳', lastStatus: 'met' }),
  ];
  const current = {
    group: defaultGroupCumulative(),
    members: {
      阿明: { ...defaultMemberCumulative(), streak: 0 },
      小芳: { ...defaultMemberCumulative(), streak: 4 },
    },
  };
  const breaks = computeStreakBreaks({ memberStats, prevCumulative: prev, currentCumulative: current });
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].wasTopStreak, true); // 5 ≥ 3 → 阿明此前持有宝座
  assert.deepEqual(breaks[0].newTop, { nickname: '小芳', streak: 4 });
});

test('computeStreakBreaks：上期 met → 本期整周请假 leave → 也触发断更', () => {
  const prev = {
    group: defaultGroupCumulative(),
    members: {
      阿明: { ...defaultMemberCumulative(), lastStatus: 'met', streak: 4 },
      小芳: { ...defaultMemberCumulative(), lastStatus: 'met', streak: 2 },
    },
  };
  const memberStats = [
    // 阿明整周请假（不是 absent/partial，是 leave）
    ms({ nickname: '阿明', lastStatus: 'leave', checkinCount: 0, totalMinutes: 0, totalCalories: 0, sports: {} }),
    ms({ nickname: '小芳', lastStatus: 'met' }),
  ];
  const current = {
    group: defaultGroupCumulative(),
    members: {
      阿明: { ...defaultMemberCumulative(), streak: 0 },   // leave → streak 归零
      小芳: { ...defaultMemberCumulative(), streak: 3 },
    },
  };
  const breaks = computeStreakBreaks({ memberStats, prevCumulative: prev, currentCumulative: current });
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].nickname, '阿明');
  assert.equal(breaks[0].brokenStreak, 4);
  assert.equal(breaks[0].wasTopStreak, true); // 4 ≥ 2 → 此前持有宝座
  assert.deepEqual(breaks[0].newTop, { nickname: '小芳', streak: 3 });
});

test('buildBadgeCells：6 格固定顺序、层级与满级文案', () => {
  const cum = {
    ...defaultMemberCumulative(),
    streak: 12,           // Lv3（[3,5,10,20,30]）→ next 20
    totalCalories: 6000,  // Lv3（[1000,3000,5000,...]）→ next 8000
    totalCheckins: 300,   // 铁人满级（[50,100,150,200,250,300]）→ 已满级
    attendanceStreak: 2,  // 未达第一档 4 → Lv0
    metWeeks: 4,          // Lv1（[4,8,...]）
    sports: { 跑步: 1, 游泳: 1 }, // 全能王 2 种 < 5 → Lv0
  };
  const cells = buildBadgeCells({ cum, config });
  assert.deepEqual(cells.map((c) => c.key), ['streak', 'fatBurner', 'ironMan', 'allRound', 'resident', 'selfDiscipline']);
  const byKey = Object.fromEntries(cells.map((c) => [c.key, c]));
  assert.equal(byKey.streak.level, 3);
  assert.equal(byKey.streak.nextText, '20');
  assert.equal(byKey.streak.unlocked, true);
  assert.equal(byKey.ironMan.level, 6);
  assert.equal(byKey.ironMan.nextText, '已满级');
  assert.equal(byKey.resident.unlocked, false);
  assert.equal(byKey.allRound.current, 2);
});

// ---------- 数据详情弹窗数据（buildBadgeIntro / streakCapsuleTiers） ----------

test('buildBadgeIntro：6 类徽章按固定顺序，tiersText 拼接层级，desc 全覆盖', () => {
  const intro = buildBadgeIntro(config);
  assert.equal(intro.length, 6);
  assert.deepEqual(intro.map((b) => b.key), ['streak', 'fatBurner', 'ironMan', 'allRound', 'resident', 'selfDiscipline']);
  const byKey = Object.fromEntries(intro.map((b) => [b.key, b]));
  assert.equal(byKey.streak.isStreak, true);
  assert.equal(byKey.streak.tiersText, 'Lv1 3周 · Lv2 5周 · Lv3 10周 · Lv4 20周 · Lv5 30周');
  assert.equal(byKey.ironMan.isStreak, false);
  assert.equal(byKey.ironMan.tiersText, 'Lv1 50次 · Lv2 100次 · Lv3 150次 · Lv4 200次 · Lv5 250次 · Lv6 300次');
  assert.equal(byKey.resident.tiersText, 'Lv1 4周 · Lv2 8周 · Lv3 16周 · Lv4 32周 · Lv5 64周 · Lv6 100周');
  assert.ok(byKey.fatBurner.color.startsWith('#'));
  // 六徽章全部带口径说明
  for (const b of intro) assert.ok(typeof b.desc === 'string' && b.desc.length > 8, `${b.key} 缺 desc`);
});

test('streakCapsuleTiers：5 档从 2 周起，20–29 皇冠 / 30+ 真金火炼', () => {
  const tiers = streakCapsuleTiers();
  assert.deepEqual(tiers.map((t) => t.style), ['lightGold', 'darkGold', 'darkGoldGlow', 'legendaryGlow', 'flameGold']);
  assert.deepEqual(tiers.map((t) => t.label), ['浅金', '深金', '深金·光晕', '👑 传奇金·光晕', '🔥 火焰金·光晕']);
  assert.deepEqual(tiers.map((t) => t.range), ['2–4', '5–9', '10–19', '20–29', '30+']);
  assert.equal(tiers[4].isLegendary, true);
  assert.equal(tiers.slice(0, 4).some((t) => t.isLegendary), false);
});
