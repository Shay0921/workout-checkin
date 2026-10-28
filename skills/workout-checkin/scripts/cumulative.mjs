#!/usr/bin/env node
/**
 * 运动打卡周报 · 累计快照共享层（纯函数，无 CLI、无副作用）
 *
 * 被 calc.mjs（链式写累计）与 personal.mjs（读归档展示）共同 import。
 * 职责：
 *   1. 链式累计 cumulative（本期 = 上期 + 本期增量）
 *   2. 徽章层级 badgeLevel / nextTier（含连击 30+ 等级延伸）
 *   3. 人格标签 persona（专精 + 燃烧/松弛强度分型）
 *   4. 本周 spotlight 判定（消耗之星/燃效之星/进步之星/破纪录/回归战士）
 *   5. 本周新解锁里程碑庆祝卡判定
 *   6. 连击胶囊样式
 *
 * 设计：全部函数纯、可单测；不读写文件、不依赖 calc.mjs 内部实现。
 */
import { normalizeName } from './nickname.mjs';

// ---------- 默认值 ----------

/** 单成员累计零值（新成员 / 首期兜底） */
export function defaultMemberCumulative() {
  return {
    streak: 0,
    bestStreak: 0,
    attendanceStreak: 0,
    metWeeks: 0,
    totalCheckins: 0,
    totalMinutes: 0,
    totalCalories: 0,
    bestCalories: 0,
    totalRedPacket: 0,
    sports: {},
    lastStatus: 'absent',
    recentWeeks: [],
  };
}

/** 群级累计零值 */
export function defaultGroupCumulative() {
  return {
    issueCount: 0,
    totalCheckins: 0,
    totalMinutes: 0,
    totalCalories: 0,
    totalRedPacket: 0,
    totalMetWeeks: 0,
    efficiencyStarStreak: { nickname: null, weeks: 0 },
    calorieKingStreak: { nickname: null, weeks: 0 },
  };
}

// ---------- 归档累计昵称归一 ----------

/** 单成员累计拷贝（旧归档缺字段时补零，避免 merge 时出现 NaN） */
function cloneMemberCumulative(m = {}) {
  const num = (v) => (Number.isFinite(v) ? v : 0);
  return {
    ...defaultMemberCumulative(),
    ...m,
    streak: num(m.streak),
    bestStreak: num(m.bestStreak),
    attendanceStreak: num(m.attendanceStreak),
    metWeeks: num(m.metWeeks),
    totalCheckins: num(m.totalCheckins),
    totalMinutes: num(m.totalMinutes),
    totalCalories: num(m.totalCalories),
    bestCalories: num(m.bestCalories),
    totalRedPacket: num(m.totalRedPacket),
    lastStatus: typeof m.lastStatus === 'string' ? m.lastStatus : 'absent',
    sports: { ...(m.sports || {}) },
    recentWeeks: Array.isArray(m.recentWeeks) ? m.recentWeeks.map((w) => ({ ...w })) : [],
  };
}

const lastIssueOf = (m) =>
  (m.recentWeeks || []).reduce((max, w) => Math.max(max, Number(w?.issue) || 0), 0);

/**
 * 同一人在归档里同时存在新旧两个 key 时合并。
 * 累计量相加；当前连击/出勤/状态取 recentWeeks 更晚的一段。
 */
function mergeMemberCumulative(a, b) {
  const latest = lastIssueOf(b) > lastIssueOf(a) ? b : a;
  const sports = { ...a.sports };
  for (const [sport, count] of Object.entries(b.sports || {})) {
    sports[sport] = (sports[sport] || 0) + count;
  }
  const weeks = new Map();
  for (const w of [...a.recentWeeks, ...b.recentWeeks]) {
    if (!w || !Number.isFinite(w.issue) || weeks.has(w.issue)) continue;
    weeks.set(w.issue, w);
  }
  return {
    streak: latest.streak,
    bestStreak: Math.max(a.bestStreak, b.bestStreak),
    attendanceStreak: latest.attendanceStreak,
    metWeeks: a.metWeeks + b.metWeeks,
    totalCheckins: a.totalCheckins + b.totalCheckins,
    totalMinutes: a.totalMinutes + b.totalMinutes,
    totalCalories: a.totalCalories + b.totalCalories,
    bestCalories: Math.max(a.bestCalories, b.bestCalories),
    totalRedPacket: a.totalRedPacket + b.totalRedPacket,
    sports,
    lastStatus: latest.lastStatus,
    recentWeeks: [...weeks.values()].sort((x, y) => x.issue - y.issue).slice(-4),
  };
}

/**
 * 把归档累计中的历史昵称归一到当前规范名。
 * 链式累计只读上一期归档；成员改名后旧 key 若不归一，会被当成新人从零累计。
 * 输出只保留规范名 key，旧 key 不向下传递，保证幂等。
 *
 * @param {object|null} cumulative 归档中的 cumulative
 * @param {Map<string, string>} nicknameIndex buildNicknameIndex 结果
 * @returns {object|null} 归一后的新对象（不修改入参）
 */
export function canonicalizeCumulative(cumulative, nicknameIndex) {
  if (!cumulative?.members) return cumulative;

  const grouped = new Map();
  for (const [nickname, value] of Object.entries(cumulative.members)) {
    const canonical = nicknameIndex?.get(normalizeName(nickname)) || nickname;
    if (!grouped.has(canonical)) grouped.set(canonical, []);
    grouped.get(canonical).push({ nickname, value });
  }

  const members = {};
  for (const [canonical, entries] of grouped) {
    // 规范名自身的记录优先，recentWeeks 同期冲突时以规范名为准
    entries.sort((a, b) => (a.nickname === canonical ? -1 : b.nickname === canonical ? 1 : 0));
    let merged = cloneMemberCumulative(entries[0].value);
    for (let i = 1; i < entries.length; i++) {
      merged = mergeMemberCumulative(merged, cloneMemberCumulative(entries[i].value));
    }
    members[canonical] = merged;
  }

  const group = { ...(cumulative.group || defaultGroupCumulative()) };
  for (const field of ['efficiencyStarStreak', 'calorieKingStreak']) {
    const current = group[field];
    if (current?.nickname) {
      group[field] = {
        ...current,
        nickname: nicknameIndex?.get(normalizeName(current.nickname)) || current.nickname,
      };
    }
  }

  return { ...cumulative, group, members };
}

// ---------- 徽章层级 ----------

/**
 * 徽章层级换算（1 起；未达第一档返回 0）
 * 连击在最后一档之后按每 +10 周继续提升等级（如最后一档 30 周 → 40 周 Lv6、50 周 Lv7），
 * 但胶囊样式不再新增档位。
 * @param {number} current 当前值
 * @param {number[]} tiers 层级数组（升序）
 * @param {boolean} [isStreak=false] 是否连击（最后一档后每 +10 延伸一级）
 * @returns {number} 层级 LvN
 */
export function badgeLevel(current, tiers, isStreak = false) {
  if (!Array.isArray(tiers) || tiers.length === 0) return 0;
  if (current < tiers[0]) return 0;
  const finalTier = tiers[tiers.length - 1];
  if (isStreak && current > finalTier) {
    return tiers.length + Math.floor((current - finalTier) / 10);
  }
  let lv = 1;
  for (let i = 0; i < tiers.length; i++) if (current >= tiers[i]) lv = i + 1;
  return lv;
}

/**
 * 下一级阈值（非连击满级返回 null；连击最后一档后每 +10 继续延伸）
 * @param {number} current 当前值
 * @param {number[]} tiers 层级数组
 * @param {boolean} [isStreak=false] 是否连击
 * @returns {number|null}
 */
export function nextTier(current, tiers, isStreak = false) {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const lv = badgeLevel(current, tiers, isStreak);
  if (isStreak) {
    const finalTier = tiers[tiers.length - 1];
    if (current < finalTier) return lv < tiers.length ? tiers[lv] : null;
    // 最后一档之后每 +10 周继续一级（30 周档 → 40、50、60…，不存在满级断档）
    return finalTier + (Math.floor((current - finalTier) / 10) + 1) * 10;
  }
  return lv < tiers.length ? tiers[lv] : null;
}

// ---------- 链式累计 ----------

/** 燃效之星参与门槛（分钟）：低于该时长不参与评比，防止「几分钟高强度」靠比率刷榜 */
export const EFFICIENCY_STAR_MIN_MINUTES = 30;

/**
 * 本周之星统一判定（消耗之星 / 燃效之星 / 进步之星 —— 单一真源）
 *
 * buildCumulative（蝉联统计）、computeSpotlights（spotlight 徽章）、calc.mjs 主流程（模块 06 三星卡）
 * 共用本函数。各星 tie-break 口径（务必逐条区分，勿笼统表述）：
 *   - 消耗之星：取 totalCalories 最大；完全并列时按 memberStats 顺序取首个（不再比较强度）
 *   - 燃效之星：取平均训练强度 avgMET = Σ(MET×分钟)/Σ分钟 最大（本周时长 ≥ EFFICIENCY_STAR_MIN_MINUTES 分钟）；
 *     完全并列时按 memberStats 顺序取首个
 *   - 进步之星：取提升率最大；提升率完全相等时取本周平均强度更高者（curMet tie-break）
 * 三者均只依赖 memberStats 顺序，同一输入结果可复现。
 *
 * @param {object} p
 * @param {Array} p.memberStats buildStats 的 per-member 状态
 * @param {object|null} p.prevCumulative 上期 cumulative（进步之星取 recentWeeks 历史）
 * @returns {{
 *   calorieKing: {nickname:string, kcal:number}|null,
 *   efficiencyStar: {nickname:string, avgMet:number}|null,
 *   progressStar: {nickname:string, prevAvgMet:number, curMet:number, improvement:number}|null,
 * }}
 */
export function computeStars({ memberStats, prevCumulative }) {
  const prevMembers = prevCumulative?.members || {};

  // 消耗之星：本周卡路里总量第一
  let calKing = null;
  let calMax = -1;
  for (const m of memberStats) {
    if (m.totalCalories > calMax) {
      calMax = m.totalCalories;
      calKing = m.nickname;
    }
  }

  // 燃效之星：本周平均训练强度（avgMET）第一
  // ⚠️ 口径说明：旧算法 kcal/min = MET×体重/60，体重是乘数，跨人比较会退化成「谁体重最大」；
  //     现改为 avgMET = Σ(MET×分钟)/Σ分钟，体重无关，语义是「谁练得最硬核」。
  // 参与门槛：本周总时长 ≥ EFFICIENCY_STAR_MIN_MINUTES，避免「几分钟高强度」靠比率刷榜。
  let effStar = null;
  let effMax = -1;
  for (const m of memberStats) {
    if (m.totalMinutes < EFFICIENCY_STAR_MIN_MINUTES) continue;
    const avgMet = m.loadScore / m.totalMinutes;
    if (avgMet > effMax) {
      effMax = avgMet;
      effStar = m.nickname;
    }
  }

  // 进步之星：需 ≥4 期历史，本周 kcal/min 相对前 3 周 kcal/min 均值正提升最大；并列取本周 avgMET 更高者
  let progStar = null;
  let progMax = -Infinity;
  let progCurMet = -1;
  let progPrevAvg = 0;
  let progCurEff = 0;
  let progWeight = 0;
  for (const m of memberStats) {
    if (m.totalMinutes === 0) continue;
    const recent = prevMembers[m.nickname]?.recentWeeks || [];
    if (recent.length < 4) continue; // 新人（历史不足 4 期）不参与
    const last3 = recent.slice(-3);
    const prevAvg =
      last3.reduce((s, w) => s + (w.minutes > 0 ? w.calories / w.minutes : 0), 0) / last3.length;
    if (prevAvg <= 0) continue;
    const curEff = m.totalCalories / m.totalMinutes;
    const improvement = (curEff - prevAvg) / prevAvg;
    if (improvement <= 0) continue; // 仅正提升参与
    // 并列 tie-break：改比本周平均强度（avgMET），与燃效之星同一口径
    const curMet = m.loadScore / m.totalMinutes;
    if (improvement > progMax || (improvement === progMax && curMet > progCurMet)) {
      progMax = improvement;
      progCurMet = curMet;
      progPrevAvg = prevAvg;
      progCurEff = curEff;
      progWeight = m.weightKg;
      progStar = m.nickname;
    }
  }

  return {
    calorieKing: calKing ? { nickname: calKing, kcal: calMax } : null,
    efficiencyStar: effStar ? { nickname: effStar, avgMet: effMax } : null,
    // 进步之星：提升率基于 kcal/min（分子分母同一体重，体重约掉）；展示值换算为 MET，与燃效之星同单位
    progressStar: progStar
      ? {
          nickname: progStar,
          prevAvgMet: (progPrevAvg * 60) / progWeight,
          curMet: (progCurEff * 60) / progWeight,
          improvement: progMax,
        }
      : null,
  };
}

/**
 * 构建本期 cumulative（链式：上期 + 本期增量）
 * @param {object} p
 * @param {object|null} p.prevCumulative 上期归档的 cumulative（null = 首期）
 * @param {Array} p.memberStats buildStats 暴露的 per-member 状态数组
 *   每项含：nickname, lastStatus(met/partial/leave/absent), checkinCount,
 *           totalMinutes, totalCalories, redPacketAmount, sports{sport:count}
 * @param {object} p.config members.json（取 sportNickname 做项目昵称聚合）
 * @param {number} p.issueNo 本期期号
 * @returns {object} cumulative = { group, members }
 */
export function buildCumulative({ prevCumulative, memberStats, config, issueNo }) {
  const prev = prevCumulative || { group: defaultGroupCumulative(), members: {} };
  const prevGroup = prev.group || defaultGroupCumulative();
  const prevMembers = prev.members || {};

  let groupCheckins = 0;
  let groupMinutes = 0;
  let groupCalories = 0;
  let groupRedPacket = 0;
  let groupMetWeeks = 0;

  // 本周之星（消耗/效率）统一走 computeStars，蝉联统计只取昵称
  const stars = computeStars({ memberStats, prevCumulative });
  const effNick = stars.efficiencyStar?.nickname || null;
  const calKingNick = stars.calorieKing?.nickname || null;

  const members = {};
  for (const m of memberStats) {
    const prevM = prevMembers[m.nickname] || defaultMemberCumulative();

    // streak：仅 met +1；其余（整周请假 leave / 部分未达标 partial / 完全缺席 absent）一律归 0
    const streak = m.lastStatus === 'met' ? prevM.streak + 1 : 0;
    // attendanceStreak：有打卡 +1，否则归 0
    const attendanceStreak = m.checkinCount >= 1 ? prevM.attendanceStreak + 1 : 0;
    const metWeeks = m.lastStatus === 'met' ? prevM.metWeeks + 1 : prevM.metWeeks;

    // sports：保留真实项目名（专精在 computePersona 内聚合，项目分布用真实名）
    const sports = { ...prevM.sports };
    for (const [sport, count] of Object.entries(m.sports || {})) {
      sports[sport] = (sports[sport] || 0) + count;
    }

    // recentWeeks 滚动窗口（最多 4 期）
    const recentWeeks = [
      ...prevM.recentWeeks,
      {
        issue: issueNo,
        minutes: m.totalMinutes,
        calories: m.totalCalories,
        checkins: m.checkinCount,
        status: m.lastStatus,
        redPacket: m.redPacketAmount,
      },
    ];
    if (recentWeeks.length > 4) recentWeeks.shift();

    members[m.nickname] = {
      streak,
      bestStreak: Math.max(prevM.bestStreak, streak),
      attendanceStreak,
      metWeeks,
      totalCheckins: prevM.totalCheckins + m.checkinCount,
      totalMinutes: prevM.totalMinutes + m.totalMinutes,
      totalCalories: prevM.totalCalories + m.totalCalories,
      bestCalories: Math.max(prevM.bestCalories, m.totalCalories),
      totalRedPacket: prevM.totalRedPacket + m.redPacketAmount,
      sports,
      lastStatus: m.lastStatus,
      recentWeeks,
    };

    groupCheckins += m.checkinCount;
    groupMinutes += m.totalMinutes;
    groupCalories += m.totalCalories;
    groupRedPacket += m.redPacketAmount;
    if (m.lastStatus === 'met') groupMetWeeks += 1;
  }

  // efficiencyStarStreak：同一人连续 → weeks+1，否则重置为 1
  const prevEff = prevGroup.efficiencyStarStreak || { nickname: null, weeks: 0 };
  const efficiencyStarStreak =
    effNick && effNick === prevEff.nickname
      ? { nickname: effNick, weeks: prevEff.weeks + 1 }
      : effNick
        ? { nickname: effNick, weeks: 1 }
        : { nickname: null, weeks: 0 };

  // calorieKingStreak：消耗之星蝉联（与燃效之星对称）
  const prevCalKing = prevGroup.calorieKingStreak || { nickname: null, weeks: 0 };
  const calorieKingStreak =
    calKingNick && calKingNick === prevCalKing.nickname
      ? { nickname: calKingNick, weeks: prevCalKing.weeks + 1 }
      : calKingNick
        ? { nickname: calKingNick, weeks: 1 }
        : { nickname: null, weeks: 0 };

  const group = {
    issueCount: (prevGroup.issueCount || 0) + 1,
    totalCheckins: (prevGroup.totalCheckins || 0) + groupCheckins,
    totalMinutes: (prevGroup.totalMinutes || 0) + groupMinutes,
    totalCalories: (prevGroup.totalCalories || 0) + groupCalories,
    totalRedPacket: (prevGroup.totalRedPacket || 0) + groupRedPacket,
    totalMetWeeks: (prevGroup.totalMetWeeks || 0) + groupMetWeeks,
    efficiencyStarStreak,
    calorieKingStreak,
  };

  return { group, members };
}

// ---------- 人格标签 ----------

/**
 * 构建「项目昵称 → 强度档」映射（高 ≥7 / 中 4–6.9 / 低 <4）
 * members.json 可用 intensityOverride 按项目名手工覆盖档位
 * （MET 只是客观代理：实际感受更费力的项目可上调、实际感知偏轻的可下调）
 * @param {object} config members.json
 * @returns {Record<string, 'high'|'mid'|'low'>}
 */
export function getSportIntensityMap(config) {
  const map = {};
  const sportNick = config.sportNickname || {};
  const override = config.intensityOverride || {};
  for (const [sport, met] of Object.entries(config.met || {})) {
    const nick = sportNick[sport] || sport;
    map[nick] = override[sport] || (met >= 7 ? 'high' : met >= 4 ? 'mid' : 'low');
  }
  return map;
}

/** 各强度档的专精次数门槛（单一真源，personal.mjs 动态生成专精门槛文案） */
export const SPECIALIZE_THRESHOLD = { high: 10, mid: 15, low: 25 };
/**
 * 计算人格标签（专精 + 强度分型）
 * @param {object} p
 * @param {Record<string, number>} p.sports 累计项目人次（昵称化 key）
 * @param {object} p.config members.json
 * @returns {{specializations: Array<{nickname:string,count:int,intensity:string}>, intensityType: string|null}}
 */
export function computePersona({ sports, config }) {
  const sportNick = config.sportNickname || {};
  const intensityMap = getSportIntensityMap(config);

  // 先按 sportNickname 把真实项目名映射到昵称化项目名并聚合（自由活动/自由训练 → 多面手 合并）
  const nickCounts = {};
  for (const [sport, count] of Object.entries(sports || {})) {
    const nick = sportNick[sport] || sport;
    nickCounts[nick] = (nickCounts[nick] || 0) + count;
  }

  const specializations = [];
  let highCount = 0;
  let lowCount = 0;
  let totalCount = 0;

  for (const [nick, count] of Object.entries(nickCounts)) {
    const intensity = intensityMap[nick] || 'mid';
    totalCount += count;
    if (intensity === 'high') highCount += count;
    if (intensity === 'low') lowCount += count;
    if (count >= SPECIALIZE_THRESHOLD[intensity]) {
      specializations.push({ nickname: nick, count, intensity });
    }
  }
  specializations.sort((a, b) => b.count - a.count);

  // 强度分型：某档占比 > 60% 即亮标签（无次数门槛）；三档互斥、先命中先得（先判燃烧系、再判松弛系），其余一律均衡系
  let intensityType = null;
  if (totalCount > 0) {
    if (highCount / totalCount > 0.6) intensityType = '燃烧系';
    else if (lowCount / totalCount > 0.6) intensityType = '松弛系';
    else intensityType = '均衡系';
  }

  return { specializations, intensityType };
}

/**
 * 周报主标签（1 颗）：有专精取次数最多的，无专精取强度分型
 * @param {object} persona computePersona 返回值
 * @returns {string|null} 标签名
 */
export function primaryPersonaTag(persona) {
  if (persona.specializations.length > 0) return persona.specializations[0].nickname;
  return persona.intensityType;
}

// ---------- spotlight（每周动态徽章） ----------

/** Spotlight 类型 → 中文名（单一真源，personal.mjs 数据详情弹窗复用） */
export const SPOTLIGHT_LABELS = {
  recordBreaker: '破纪录',
  return: '回归战士',
  efficiencyStar: '燃效之星',
  progressStar: '进步之星',
  calorieKing: '消耗之星',
};

// 优先级：破纪录 > 回归战士 > 燃效之星 > 进步之星 > 消耗之星
const SPOTLIGHT_PRIORITY = [
  'recordBreaker',
  'return',
  'efficiencyStar',
  'progressStar',
  'calorieKing',
];

/**
 * 计算本周 spotlight（每人最多 1 颗，按优先级取最高）
 * @param {object} p
 * @param {Array} p.memberStats buildStats 的 per-member 状态
 * @param {object|null} p.prevCumulative 上期 cumulative（取 lastStatus / bestCalories / recentWeeks）
 * @returns {Record<string, {type:string,label:string}>} nickname → spotlight
 */
export function computeSpotlights({ memberStats, prevCumulative }) {
  const prevMembers = prevCumulative?.members || {};

  // 三星判定统一走 computeStars 单一真源（tie-break 口径一致）
  const stars = computeStars({ memberStats, prevCumulative });
  const calKing = stars.calorieKing?.nickname || null;
  const effStar = stars.efficiencyStar?.nickname || null;
  const progStar = stars.progressStar?.nickname || null;

  const spotlights = {};
  for (const m of memberStats) {
    const prevM = prevMembers[m.nickname];
    const qualified = [];

    // 破纪录：本周消耗 > 个人历史最高（上期 bestCalories）
    if (m.totalCalories > 0 && m.totalCalories > (prevM?.bestCalories || 0)) {
      qualified.push('recordBreaker');
    }
    // 回归战士：上期整周请假 → 本期达标
    if (prevM?.lastStatus === 'leave' && m.lastStatus === 'met') {
      qualified.push('return');
    }
    if (m.nickname === effStar) qualified.push('efficiencyStar');
    if (m.nickname === progStar) qualified.push('progressStar');
    if (m.nickname === calKing) qualified.push('calorieKing');

    if (qualified.length > 0) {
      const best = qualified.sort(
        (a, b) => SPOTLIGHT_PRIORITY.indexOf(a) - SPOTLIGHT_PRIORITY.indexOf(b)
      )[0];
      spotlights[m.nickname] = { type: best, label: SPOTLIGHT_LABELS[best] };
    }
  }

  return spotlights;
}

// ---------- 里程碑庆祝卡 ----------

const BADGE_FIELDS = {
  streak: {
    field: 'streak', isStreak: true, label: '连击', unit: '周', color: '#e8b84b',
    desc: '连续达标周数；整周请假、未达标或缺席均归零重新累计；30 周起进入真金火炼档，胶囊样式固定，成就等级每 10 周继续 +1 Lv',
  },
  fatBurner: {
    field: 'totalCalories', isStreak: false, label: '燃脂狂魔', unit: 'kcal', color: '#d97757',
    desc: '累计总消耗，所有打卡消耗逐年累加、不清零，是耐力与输出的总账',
  },
  ironMan: {
    field: 'totalCheckins', isStreak: false, label: '铁人', unit: '次', color: '#5b8db8',
    desc: '累计出勤打卡次数，一周多次打卡逐次累计，只看出勤不看强度',
  },
  allRound: {
    field: '__sportKinds', isStreak: false, label: '全能王', unit: '种', color: '#9b7ec8',
    desc: '累计解锁的不同运动项目种类数，鼓励多项目探索、拒绝单一重复',
  },
  resident: {
    field: 'attendanceStreak', isStreak: false, label: '常驻居民', unit: '周', color: '#8ca06f',
    desc: '累计出勤周数，本周有打卡即计入（不要求达标），考验长期在场的稳定',
  },
  selfDiscipline: {
    field: 'metWeeks', isStreak: false, label: '自律标兵', unit: '周', color: '#5fa8a0',
    desc: '累计达标周数，达到当周达标线才计入，是真正意义上的目标完成度',
  },
};

/** 取徽章当前值（allRound = 不同运动种类数，其余直取 cumulative 字段） */
function getBadgeValue(meta, cum) {
  return meta.field === '__sportKinds'
    ? Object.keys(cum.sports || {}).length
    : cum[meta.field];
}

/**
 * 成就墙 6 格数据（个人战报与周报共用，消除字段映射硬编码）
 * @param {object} p.cum 单成员 cumulative
 * @param {object} p.config members.json（badges 层级）
 * @returns {Array<{key,name,level,unlocked,current,nextText}>} 按 BADGE_FIELDS 固定顺序
 */
export function buildBadgeCells({ cum, config }) {
  const badges = config.badges || {};
  return Object.entries(BADGE_FIELDS).map(([key, meta]) => {
    const tiers = badges[key] || [];
    const current = getBadgeValue(meta, cum);
    const level = badgeLevel(current, tiers, meta.isStreak);
    const next = nextTier(current, tiers, meta.isStreak);
    return {
      key,
      name: meta.label,
      level,
      unlocked: level > 0,
      current,
      nextText: next === null ? '已满级' : String(next),
      color: meta.color,
    };
  });
}

/**
 * 计算本周新解锁的里程碑（badgeLevel(本期) > badgeLevel(上期)）
 * 连击特殊：断更归零后重新爬升，若只达到历史已解锁过的等级则不重复庆祝；
 * 以「上期 bestStreak（历史最高连击，永不清零）」的等级为基准，仅突破历史最高等级时庆祝。
 * @param {object} p
 * @param {object} p.cumulative 本期 cumulative
 * @param {object|null} p.prevCumulative 上期 cumulative
 * @param {object} p.config members.json（badges 层级）
 * @returns {Array<{nickname:string,badge:string,label:string,level:number}>}
 */
export function computeMilestoneCelebrations({ cumulative, prevCumulative, config }) {
  const badges = config.badges || {};
  const prevMembers = prevCumulative?.members || {};
  const celebrations = [];

  for (const [nick, cur] of Object.entries(cumulative.members)) {
    const prev = prevMembers[nick] || defaultMemberCumulative();
    for (const [badgeKey, meta] of Object.entries(BADGE_FIELDS)) {
      const tiers = badges[badgeKey];
      if (!tiers) continue;
      const curVal = getBadgeValue(meta, cur);
      const curLv = badgeLevel(curVal, tiers, meta.isStreak);
      // 连击对比历史最高（bestStreak），其余对比上期值（累计只涨不跌，二者等价）
      const prevLv = meta.isStreak
        ? badgeLevel(prev.bestStreak || 0, tiers, true)
        : badgeLevel(getBadgeValue(meta, prev), tiers, false);
      if (curLv > prevLv && curLv > 0) {
        celebrations.push({
          nickname: nick,
          badge: badgeKey,
          label: meta.label,
          level: curLv,
          value: curVal,
          unit: meta.unit,
        });
      }
    }
  }
  return celebrations;
}

/**
 * 断更提示（反馈而非预警：统计已结束，只做结果提示，供 AI insights 取材）
 * 上期达标（lastStatus=met 且 streak>0）、本期非 met（partial/absent/leave）→ 连击中断。
 * @param {object} p
 * @param {Array} p.memberStats buildStats 的 per-member 状态
 * @param {object|null} p.prevCumulative 上期 cumulative
 * @returns {Array<{nickname:string, brokenStreak:number}>} 本期连击中断名单（按 memberStats 顺序）
 */
export function computeStreakBreaks({ memberStats, prevCumulative, currentCumulative }) {
  const prevMembers = prevCumulative?.members || {};
  const breaks = [];
  for (const m of memberStats) {
    const prevM = prevMembers[m.nickname];
    if (
      prevM?.lastStatus === 'met' &&
      (prevM.streak || 0) > 0 &&
      m.lastStatus !== 'met'  // 本期非 met（partial/absent/leave）→ 连击归零
    ) {
      // 宝座判定：brokenStreak ≥ 上期其他所有成员的连击 → 该成员此前持有（或并列持有）全群最长连击
      let maxOther = 0;
      for (const [nick, pm] of Object.entries(prevMembers)) {
        if (nick !== m.nickname) maxOther = Math.max(maxOther, pm.streak || 0);
      }
      const wasTopStreak = (prevM.streak || 0) >= maxOther;
      // 本期结算后的全群最长连击持有者（断更者已归零，天然出局）
      let newTop = null;
      for (const [nick, cm] of Object.entries(currentCumulative?.members || {})) {
        const s = cm.streak || 0;
        if (s > 0 && (!newTop || s > newTop.streak)) newTop = { nickname: nick, streak: s };
      }
      breaks.push({ nickname: m.nickname, brokenStreak: prevM.streak, wasTopStreak, newTop });
    }
  }
  return breaks;
}

// ---------- 连击胶囊样式 ----------

/**
 * 连击胶囊档位表（连击周数上限 → 样式名，按序匹配第一个满足项）
 * 样式名对应模板 CSS 类：周报 cap-streak-<style> / 个人战报 sp-<style>，两处色值需保持同步
 * 档位设计：20–29 = 皇冠档（传奇金·光晕 👑），30+ = 最终真金火炼档（火焰金·光晕 🔥）。
 * 30 周后胶囊样式固定为 flameGold，不再新增视觉档位；成就等级由 badgeLevel 每 +10 周继续 +1 Lv。
 */
const STREAK_STYLES = [
  [4, 'lightGold'],
  [9, 'darkGold'],
  [19, 'darkGoldGlow'],
  [29, 'legendaryGlow'],
  [Infinity, 'flameGold'],
];

/** 档位角标：皇冠档 20–29 = 👑，真金火炼档 30+ = 🔥 */
const STREAK_EMOJI = {
  legendaryGlow: '👑',
  flameGold: '🔥',
};

/**
 * 连击胶囊样式（streak < 2 返回 null 不显示）
 * @param {number} streak 当前达标连击
 * @returns {{streak:number,style:string,isLegendary:boolean,emoji:string|null}|null}
 */
export function streakCapsule(streak) {
  if (streak < 2) return null;
  const style = STREAK_STYLES.find(([max]) => streak <= max)[1];
  return { streak, style, isLegendary: streak >= 30, emoji: STREAK_EMOJI[style] || null };
}

/** 连击胶囊档位中文名（数据详情弹窗展示用，与 STREAK_STYLES 一一对应，皇冠/真金火炼档带角标） */
const STREAK_STYLE_LABELS = {
  lightGold: '浅金',
  darkGold: '深金',
  darkGoldGlow: '深金·光晕',
  legendaryGlow: '👑 传奇金·光晕',
  flameGold: '🔥 火焰金·光晕',
};

/**
 * 连击胶囊档位表（数据详情弹窗「每周层级介绍」用）
 * @returns {Array<{style:string,label:string,range:string,isLegendary:boolean}>} 起始周数 2（<2 不显示胶囊）
 */
export function streakCapsuleTiers() {
  const out = [];
  let min = 2;
  for (const [max, style] of STREAK_STYLES) {
    out.push({
      style,
      label: STREAK_STYLE_LABELS[style],
      range: max === Infinity ? `${min}+` : `${min}–${max}`,
      isLegendary: max === Infinity,
    });
    min = max + 1;
  }
  return out;
}

/**
 * 成就徽章介绍表（数据详情弹窗「成就列表与分层介绍」用）
 * steps = 阶梯可视化数据：每级一根升序色柱（h 递增、透明度递增），柱下标解锁阈值
 * @param {object} config members.json（badges 层级）
 * @returns {Array<{key,name,unit,color,isStreak,tiers,tiersText,steps:Array<{lv,value,h,op}>}>} 按 BADGE_FIELDS 固定顺序
 */
export function buildBadgeIntro(config) {
  const badges = config.badges || {};
  return Object.entries(BADGE_FIELDS).map(([key, meta]) => {
    const tiers = badges[key] || [];
    return {
      key,
      name: meta.label,
      unit: meta.unit,
      color: meta.color,
      isStreak: meta.isStreak,
      desc: meta.desc,
      tiers,
      tiersText: tiers.map((t, i) => `Lv${i + 1} ${t}${meta.unit}`).join(' · '),
      steps: tiers.map((t, i) => ({
        lv: i + 1,
        value: t,
        h: 8 + i * 2,
        op: Math.round(30 + (70 * (i + 1)) / tiers.length) / 100,
      })),
    };
  });
}

// ---------- metSnapshot ----------

/** 构建当期 MET 快照（口径留存，供审计/复现） */
export function buildMetSnapshot(config) {
  return { met: { ...(config.met || {}) }, convert: { ...(config.convert || {}) } };
}
