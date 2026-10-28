#!/usr/bin/env node
/**
 * 个人战报生成脚本：读最新一期归档的 cumulative → 渲染个人报告 HTML
 *
 * 用法：
 *   node personal.mjs <reportsDir> [--members members.json] [--name 昵称] [-o 输出.html] [--digest]
 *
 *   members.json 默认读取 reportsDir 的上一级（即工作区根目录）；--members 可覆盖。
 *   --name 昵称：只生成该成员一节；省略则生成全部 active 成员
 *   --digest   ：只打印「历史速览」（逐期时间线 + 每人派生量），不渲染、不写文件。
 *                供 AI 写 personal-insights.json 的 full / recent 两行取材——派生量全由脚本算。
 *
 * 设计：渲染路径只读最新一期归档（内嵌完整 cumulative）；仅 --digest 需要逐期序列，
 * 由脚本扫全部归档（一两秒、零 token，AI 不读任何归档 JSON）。
 * 复用 cumulative.mjs 的 badgeLevel / nextTier / computePersona / streakCapsule 纯函数。
 */
import Handlebars from './vendor/handlebars.cjs';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignAngles } from './angle.mjs';
import { normalizeNickname } from './calc.mjs';
import { findSkeletonDuplicates } from './text-lint.mjs';
import {
  canonicalizeCumulative,
  computePersona,
  streakCapsule,
  buildBadgeCells,
  buildBadgeIntro,
  streakCapsuleTiers,
  getSportIntensityMap,
  SPECIALIZE_THRESHOLD,
  SPOTLIGHT_LABELS,
} from './cumulative.mjs';
import { buildNicknameIndex, canonicalName, normalizeName } from './nickname.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LEGACY_MEMBERS_PATH = resolve(SCRIPT_DIR, '../members.json');
const TEMPLATE_PATH = resolve(SCRIPT_DIR, '../templates/template-personal.html');

// 徽章身份色由 cumulative.mjs 的 BADGE_FIELDS 统一提供（buildBadgeCells 返回 cell.color）

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0].startsWith('-')) {
    console.error('用法: node personal.mjs <reportsDir> [--members members.json] [--name 昵称] [-o 输出.html]');
    process.exit(1);
  }
  const getOpt = (name) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : null;
  };
  const reportsDir = resolve(args[0]);
  const membersOpt = getOpt('--members');
  return {
    reportsDir,
    membersPath: membersOpt ? resolve(membersOpt) : resolve(dirname(reportsDir), 'members.json'),
    name: getOpt('--name'),
    outPath: getOpt('-o'),
    digest: args.includes('--digest'),
  };
}

/** 取归档目录中期号最大的归档 */
function findLatestArchive(reportsDir) {
  const re = /^\d{4}-issue(\d{2,})\.json$/;
  let latest = null;
  let maxNo = -1;
  for (const f of readdirSync(reportsDir)) {
    const m = f.match(re);
    if (m && Number(m[1]) > maxNo) {
      maxNo = Number(m[1]);
      latest = f;
    }
  }
  return latest ? resolve(reportsDir, latest) : null;
}

/** 取归档目录中期号最小的归档（全历史起始周用） */
function findEarliestArchive(reportsDir) {
  const re = /^\d{4}-issue(\d{2,})\.json$/;
  let earliest = null;
  let minNo = Infinity;
  for (const f of readdirSync(reportsDir)) {
    const m = f.match(re);
    if (m && Number(m[1]) < minNo) {
      minNo = Number(m[1]);
      earliest = f;
    }
  }
  return earliest ? resolve(reportsDir, earliest) : null;
}

/** 昵称首字符（中文取首字，英文取首字母大写） */
function firstCharOf(nick) {
  const first = [...nick][0] || '?';
  return /^[a-z]$/i.test(first) ? first.toUpperCase() : first;
}

/** 头像背景色类：男→male / 女→female / 未填→unknown */
function genderClass(gender) {
  if (gender === '男') return 'male';
  if (gender === '女') return 'female';
  return 'unknown';
}

/**
 * 人格标签介绍：强度分档元信息（label + 专精门槛）
 * threshold 文案由 cumulative.mjs SPECIALIZE_THRESHOLD 动态生成，阈值改一处即全局同步。
 */
const SPORT_INTENSITY_META = [
  { key: 'high', label: '高强度 · MET ≥ 7', threshold: `专精 ${SPECIALIZE_THRESHOLD.high} 次` },
  { key: 'mid', label: '中强度 · MET 4–6.9', threshold: `专精 ${SPECIALIZE_THRESHOLD.mid} 次` },
  { key: 'low', label: '低强度 · MET < 4', threshold: `专精 ${SPECIALIZE_THRESHOLD.low} 次` },
];

/**
 * 构建「每周亮点介绍」（数据详情弹窗用）
 * label 从 cumulative.mjs SPOTLIGHT_LABELS 单一真源取值，避免类型名改了此处静默错位；
 * desc 是 personal.mjs 独有的说明文案，本地维护。
 *
 * 配色同源（模板 .spotlight-badge sb-{type} / 周报 .cap-spotlight sp-{type}）：
 * 破纪录=徽章身份金 #faf3e3/#b08a30 · 回归战士=松弛绿 #eaf3de/#5f7d2f ·
 * 燃效之星=燃烧系橙 #fbe9e0/#c2572e · 进步之星=均衡蓝 #e6ebf2/#3f5a7a ·
 * 消耗之星=紫藤（默认兜底色）#ece4f4/#7a5fb0
 */
const SPOTLIGHT_INTRO_META = [
  { type: 'recordBreaker', desc: '本周总消耗超过个人历史最高纪录' },
  { type: 'return', desc: '上期整周请假、本期恢复达标' },
  { type: 'efficiencyStar', desc: '本周平均训练强度（MET，体重归一）全群第一，与「燃烧系」同源配色' },
  { type: 'progressStar', desc: '本周 kcal/min 较前 3 周均值提升最大（历史满 4 期才参与）' },
  { type: 'calorieKing', desc: '本周总消耗全群第一' },
];

/**
 * 组装 spotlight 介绍数据，label 从 SPOTLIGHT_LABELS 动态取，desc 本地维护。
 * @returns {Array<{type:string,label:string,desc:string}>}
 */
function buildSpotlightIntro() {
  return SPOTLIGHT_INTRO_META.map((s) => ({
    ...s,
    label: SPOTLIGHT_LABELS[s.type],
  }));
}

/**
 * 按强度分档列出项目昵称（数据详情弹窗「人格标签介绍」用）
 * 每个昵称带回源项目名（自由活动/自由训练同映射到「多面手」，合并展示）
 * 强度档判定复用 cumulative.mjs getSportIntensityMap（单一真源，MET 阈值改一处即全局生效）
 */
function buildSportGroups(config) {
  const met = config.met || {};
  const sportNick = config.sportNickname || {};
  // 复用 cumulative.mjs 的强度档判定（已含 intensityOverride），消除 met>=7 三元表达式重抄
  const intensityMap = getSportIntensityMap(config);
  const groups = { high: new Map(), mid: new Map(), low: new Map() };
  for (const [sport] of Object.entries(met)) {
    const nick = sportNick[sport] || sport;
    const key = intensityMap[nick] || 'mid';
    if (!groups[key].has(nick)) groups[key].set(nick, new Set());
    groups[key].get(nick).add(sport);
  }
  return SPORT_INTENSITY_META.map((meta) => ({
    ...meta,
    sports: [...groups[meta.key].entries()].map(([nick, set]) => ({
      nick,
      label: [...set].join('/'),
    })),
  }));
}

/** 构建单个成员的视图数据 */
function buildMemberView({ cum, member, config, issueNo, issueCount, spotlights, aiNotes }) {
  const persona = computePersona({ sports: cum.sports, config });

  // 专精标签（最多 4 颗，按各自强度档配色：high→burn / mid→balance / low→relax）
  const INTENSITY_CLASS = { high: 'burn', mid: 'balance', low: 'relax' };
  const specTags = persona.specializations.slice(0, 4).map((s) => ({
    nickname: s.nickname,
    cls: INTENSITY_CLASS[s.intensity] || 'balance',
  }));

  // 强度分型
  let intensityType = persona.intensityType;
  let intensityClass = null;
  if (intensityType === '燃烧系') intensityClass = 'burn';
  else if (intensityType === '均衡系') intensityClass = 'balance';
  else if (intensityType === '松弛系') intensityClass = 'relax';

  // 强度分型 → 胶囊配色类与色值（与模板 tag-burn/tag-balance/tag-relax CSS 同源）
  const INTENSITY_COLORS = { burn: '#c2572e', balance: '#3f5a7a', relax: '#5f7d2f' };

  // 累计排行表个人标签（主标签：首个专精昵称优先，否则强度分型；配色类与专精/分型标签同源）
  let personaTag = null;
  let personaClass = null;
  if (persona.specializations.length > 0) {
    personaTag = persona.specializations[0].nickname;
    personaClass = INTENSITY_CLASS[persona.specializations[0].intensity] || 'balance';
  } else if (intensityType) {
    personaTag = intensityType;
    personaClass = intensityClass;
  }

  // 连击胶囊
  const sc = streakCapsule(cum.streak);

  // 最近 4 周趋势柱
  const maxCal = Math.max(...cum.recentWeeks.map((w) => w.calories), 0);
  const recentWeeks = cum.recentWeeks.map((w) => {
    const isLeave = w.status === 'leave';
    const barClass = w.status === 'met' ? 'met' : w.status === 'leave' ? 'leave' : 'miss';
    const barHeight = isLeave ? 8 : (maxCal > 0 ? Math.max(2, Math.round((w.calories / maxCal) * 78)) : 2);
    return {
      caloriesLabel: isLeave ? '0' : String(w.calories),
      minutesLabel: isLeave ? '请假' : `${w.minutes}min`,
      barClass,
      barHeight,
      isLeave,
    };
  });

  // 成就墙 6 类徽章（字段映射/层级/满级判定/身份色统一走 buildBadgeCells）
  const badgeCells = buildBadgeCells({ cum, config }).map((cell) => ({
    ...cell,
    dotColor: cell.unlocked ? cell.color : '#c9c6bd',
    textColor: cell.color,
  }));

  // 项目分布 Top 5
  const sportEntries = Object.entries(cum.sports || {}).sort((a, b) => b[1] - a[1]);
  const top5 = sportEntries.slice(0, 5);
  const rest = sportEntries.slice(5);
  const restCount = rest.reduce((s, [, c]) => s + c, 0);
  const maxSport = top5[0]?.[1] || 1;
  const sportsTop = top5.map(([name, count], i) => ({
    name,
    count,
    barWidth: Math.round((count / maxSport) * 100),
    barOpacity: Math.max(0.5, Math.round((1 - i * 0.08) * 100) / 100),
    isOther: false,
  }));
  if (rest.length > 0) {
    sportsTop.push({
      name: `其他 ${rest.length} 项`,
      count: restCount,
      barWidth: Math.round((restCount / maxSport) * 100),
      isOther: true,
    });
  }

  // spotlight（本周）：传 {label, type}，type 供模板按类型配色（燃效之星=燃烧系橙，其余珊瑚橙）
  const spotlightInfo = spotlights?.[member.nickname] || null;
  const spotlight = spotlightInfo ? { label: spotlightInfo.label, type: spotlightInfo.type } : null;

  // 数据洞察 = 纯 AI 分析（full 全程 + recent 近 4 周，侧车 personal-insights.json）；硬指标已拆解进里程碑与趋势标题
  const eff = cum.totalMinutes > 0 ? cum.totalCalories / cum.totalMinutes : 0;
  const metRate = issueCount > 0 ? Math.round((cum.metWeeks / issueCount) * 100) : 0;

  return {
    nickname: member.nickname,
    firstChar: firstCharOf(member.nickname),
    genderClass: genderClass(member.gender),
    spotlight,
    specTags,
    intensityType,
    intensityClass,
    hasPersona: specTags.length > 0 || !!intensityType,
    personaTag,
    personaClass,
    streak: cum.streak,
    streakPill: sc,
    recentWeeks,
    effText: eff > 0 ? eff.toFixed(1) : '—',
    effNum: eff,
    trendEffColor: intensityClass ? INTENSITY_COLORS[intensityClass] : '#3a3733',
    totalCalories: cum.totalCalories,
    totalMinutes: cum.totalMinutes,
    bestCalories: cum.bestCalories,
    totalCheckins: cum.totalCheckins,
    metRate,
    badges: badgeCells,
    sportsTop,
    aiFull: aiNotes?.[member.nickname]?.full || null,
    aiRecent: aiNotes?.[member.nickname]?.recent || null,
    totalRedPacket: cum.totalRedPacket,
  };
}

/**
 * 读取归档目录全部期号，构建逐期时间线（按 issueNo 升序）
 *
 * 数据来源：每期归档的 checkinList（打卡者）+ leaveList（请假者，不在 checkinList 中）。
 * 状态口径与 calc.mjs 一致：gapText 以「达标」开头 → met；有打卡但未达标 → partial；无打卡 → absent。
 *
 * @param {string} reportsDir 归档目录
 * @returns {Array<{issueNo:number, weekStart:string, weekEnd:string, calories:number, minutes:number,
 *                  metCount:number, totalMembers:number, leaveCount:number, absentCount:number,
 *                  members: Map<string,{status:string,calories:number,minutes:number,checkins:number}>}>}
 */
function loadHistory(reportsDir) {
  const re = /^\d{4}-issue(\d{2,})\.json$/;
  const entries = readdirSync(reportsDir)
    .map((f) => {
      const m = f.match(re);
      return m ? { file: f, no: Number(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.no - b.no);

  const issues = [];
  for (const e of entries) {
    let d;
    try {
      d = JSON.parse(readFileSync(resolve(reportsDir, e.file), 'utf-8'));
    } catch {
      continue; // 坏归档跳过，不影响其余期号
    }
    const members = new Map();
    for (const m of d.checkinList || []) {
      const met = String(m.gapText || '').startsWith('达标');
      const checkins = m.checkinCount || 0;
      members.set(m.nickname, {
        status: met ? 'met' : checkins > 0 ? 'partial' : 'absent',
        calories: m.totalCalories || 0,
        minutes: m.totalMinutes || 0,
        checkins,
      });
    }
    for (const l of d.leaveList || []) {
      if (!members.has(l.nickname)) {
        members.set(l.nickname, { status: 'leave', calories: 0, minutes: 0, checkins: 0 });
      }
    }
    issues.push({
      issueNo: d.issueNo ?? e.no,
      weekStart: d.weekStart || '',
      weekEnd: d.weekEnd || '',
      calories: d.totalCaloriesSum || 0,
      minutes: d.totalMinutesSum || 0,
      metCount: d.metCount || 0,
      totalMembers: d.totalMembers || 0,
      leaveCount: d.leaveCount || 0,
      absentCount: d.absentCount || 0,
      members,
    });
  }
  return issues;
}

/** 「昵称 → 数据」映射的 key 按别名归一到当前规范名（归档 spotlights / 侧车 notes 都可能带旧名或脏名） */
function canonicalizeByKey(map, index) {
  const out = {};
  for (const [nickname, value] of Object.entries(map)) {
    const canonical = canonicalName(nickname, index);
    if (!out[canonical]) out[canonical] = value;
  }
  return out;
}

/**
 * --name 有则只出该成员，无则全群 active（digest 与渲染两条路径共用）。
 * 匹配规则直接复用 calc 的 normalizeNickname（唯一真源：精确归一 + 唯一前缀兜底，多命中不猜）
 */
function pickTargets(name, actives) {
  if (!name) return actives;
  try {
    const hit = normalizeNickname(name, actives);
    if (!hit) {
      console.error(`✗ 未找到成员「${name}」（active 成员：${actives.map((m) => m.nickname).join('、')}）`);
      process.exit(1);
    }
    return [hit];
  } catch (e) {
    if (e.code === 'AMBIGUOUS_NICKNAME') {
      console.error(`✗ --name ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

/**
 * 生成「历史速览」文本：全部派生量由脚本计算，AI 只负责据此写文案
 *
 * 口径（必须与文本里的说明一致，改动须同步 references/insight-writing.md §2）：
 *   - 周均 = 累计消耗 ÷ 有打卡期数（不拿群期数硬除，避免请假/未入群拉低均值）
 *   - 近 4 期 = 最近 4 期里有打卡那几期的平均单期消耗，只用来和全程周均比高低
 *     （**不做前后半程切分**：每期报告都是「截至本期」的累计，第 8 期看 1–8 期、第 17 期看 1–17 期）
 *   - 缺席 = 归档里点名叫到、但没打卡也没请假；归档里完全没出现的人（未入群/改名/缺档）
 *     单列为「无记录 N 期」，不混算成缺席
 *   - 累计排名 / 连击 / 打卡总数 均由脚本算出，AI 直接引用，不得自行排序比较
 *
 * @param {object} p
 * @param {Array} p.issues loadHistory 结果（升序）
 * @param {object} p.cumulative 最新一期归档的 cumulative
 * @param {Array} p.targets 目标成员（config.members 的子集）
 * @param {Array} p.rankPool 参与累计排名的全部 active 成员（--name 补生成时也按全群排）
 * @param {Map<string, string>} p.nicknameIndex buildNicknameIndex(config.members) 结果，用于把归档旧昵称归到当前名
 * @param {number} p.issueNo 最新期号
 * @returns {string}
 */
function buildDigest({ issues, cumulative, targets, rankPool, nicknameIndex, issueNo }) {
  if (issues.length === 0) return '⚠ 归档目录内没有可解析的期号，无法生成速览';
  const lines = [];
  const last = issues[issues.length - 1];
  const first = issues[0];

  lines.push('══ 历史速览（写 personal-insights.json 的 full / recent 直接引用下列数字，勿自行计算）══');
  lines.push(
    '口径 · 周均A→B = A 为第 1 期到中点期（ceil(总期数/2)）内有打卡期的平均单期消耗、B 为全程周均（累计 ÷ 有打卡期数），两端都是「截至当时」的累计；近4期 = 最近 4 期里有打卡期的平均单期消耗'
  );
  lines.push(
    `群级 · ${issues.length} 期 · ${first.weekStart} ~ ${last.weekEnd} · 累计 ${cumulative.group?.totalCalories ?? 0} kcal / ${cumulative.group?.totalMinutes ?? 0} 分钟`
  );
  // 分子（累计消耗）来自链式快照，与归档是否完整无关；分母（打卡期数/达标期数）来自归档扫描。
  // 归档被删或损坏时分母偏小 → 周均偏高、达标率失真，必须显式提示，不能静默出数。
  const expectedIssues = cumulative.group?.issueCount ?? issues.length;
  const archiveComplete = expectedIssues <= issues.length;
  if (!archiveComplete) {
    lines.push(
      `⚠ 归档可见 ${issues.length} 期，累计快照记录 ${expectedIssues} 期：周均与达标率的分母偏小、数值偏高，本期不出周均，先确认归档是否缺失`
    );
  }
  lines.push('逐期 · 期号 周起 总消耗 达标/人数 请假 缺席');
  for (const it of issues) {
    lines.push(
      `  #${String(it.issueNo).padStart(2, '0')} ${it.weekStart}  ${String(it.calories).padStart(5)} kcal  ${it.metCount}/${it.totalMembers}  请假${it.leaveCount}  缺席${it.absentCount}`
    );
  }

  // 归档里的旧昵称 → 当前标准名：统一走 nickname.mjs 的 buildNicknameIndex（与 calc / cumulative 同一份索引），
  // 不在此处另搓一张表——两张表一旦走样，同一个人的逐期序列会静默变 null，配额被错误占用。
  const seriesOf = (nickname) => {
    const out = [];
    for (const it of issues) {
      let hit = null;
      for (const [k, v] of it.members) {
        if (nicknameIndex.get(normalizeName(k)) === nickname) {
          hit = v;
          break;
        }
      }
      out.push(hit); // null = 该期无任何记录（未入群或归档缺失）
    }
    return out;
  };
  const avgOf = (arr) => {
    const rows = arr.filter((r) => r && r.checkins > 0);
    if (rows.length === 0) return { avg: 0, base: 0 };
    return { avg: Math.round(rows.reduce((s, r) => s + r.calories, 0) / rows.length), base: rows.length };
  };

  // 累计消耗排名（全群 active 成员、含并列同名次）——AI 只引用，不自行排序
  const ranked = rankPool
    .map((m) => ({ nickname: m.nickname, total: cumulative.members?.[m.nickname]?.totalCalories ?? 0 }))
    .sort((a, b) => b.total - a.total || (a.nickname < b.nickname ? -1 : 1));
  const rankMap = new Map();
  let lastTotal = null;
  let lastRank = 0;
  ranked.forEach((r, i) => {
    if (r.total !== lastTotal) lastRank = i + 1;
    lastTotal = r.total;
    rankMap.set(r.nickname, { rank: lastRank, size: ranked.length });
  });

  // 每人事实先对全群 active 成员算一遍：角度与配额按全群统一分配，
  // 保证 --name 单人报告给同一个人的角度与多人报告完全一致。
  const facts = new Map();
  for (const m of rankPool) {
    const cum = cumulative.members?.[m.nickname];
    if (!cum) continue;
    const series = seriesOf(m.nickname);
    const activeWeeks = series.filter((r) => r && r.checkins > 0).length;
    const metWeeks = series.filter((r) => r && r.status === 'met').length;
    const leaveWeeks = series.filter((r) => r && r.status === 'leave').length;
    // 缺席 = 归档里点名叫到了、但没打卡也没请假；null = 该期归档完全没有这个人
    // （未入群 / 改名未归一 / 归档缺失），两者不能混算，否则新人会被算成「缺席 N 期」。
    const absentWeeks = series.filter((r) => r && r.status === 'absent').length;
    const missingWeeks = series.filter((r) => !r).length;
    const weeklyAvg = activeWeeks > 0 ? Math.round(cum.totalCalories / activeWeeks) : 0;
    // 半程检查点的累计周均：第 1 期到中点（ceil(总期数/2)）内有打卡期的平均单期消耗。
    // 「周均 A→B」= 走到一半时的水平 → 现在的水平，两端都是「截至当时」的累计，不做前后半程对比。
    const k0 = Math.ceil(series.length / 2);
    const atHalf = avgOf(series.slice(0, k0));
    const rank = rankMap.get(m.nickname);
    const rankText = rank ? `·第${rank.rank}/${rank.size}` : '';
    const avgText = !archiveComplete
      ? `周均—(归档不全·累计${cum.totalCalories}${rankText})`
      : activeWeeks > 0
        ? atHalf.base >= 2 && atHalf.avg > 0
          ? `周均${atHalf.avg}→${weeklyAvg}(累计${cum.totalCalories}${rankText})`
          : `周均${weeklyAvg}(累计${cum.totalCalories}${rankText})`
        : `周均—(累计${cum.totalCalories}${rankText})`;

    // 「最近」= 最近 4 期内有打卡那几期的平均单期消耗。与全程周均（累计口径）比高低，
    // 两端都取自「截至本期」的累计，不切段。
    const recent = avgOf(series.slice(-4));
    const recentText = recent.base > 0 ? `近4期${recent.avg}(${recent.base}期)` : '近4期—';

    const peak = series.reduce(
      (best, r, i) => (r && r.calories > (best?.calories ?? -1) ? { i, calories: r.calories } : best),
      null
    );
    const peakText = peak && peak.calories > 0 ? `#${String(issues[peak.i].issueNo).padStart(2, '0')} ${peak.calories}` : '—';

    const sports = Object.entries(cum.sports || {}).sort((a, b) => b[1] - a[1]);
    const sportTotal = sports.reduce((s, x) => s + x[1], 0);

    // 近 4 期「请假后复出」「打卡后断更」——变化档的核心证据，只有逐期序列才算得出
    let recentLeave = null;
    let recentAbsent = null;
    for (let i = Math.max(1, series.length - 4); i < series.length; i++) {
      const prev = series[i - 1];
      const cur = series[i];
      // 期号必须记「请假的那一期」（prev），记成 cur 会变成「第 17 期请假后已复出」这种反话
      if (cur && cur.checkins > 0 && prev && prev.status === 'leave') recentLeave = issues[i - 1].issueNo;
      // 只认 status==='absent'（点名叫到却没打卡），null 是「无记录」，可能是改名或未入群，不算断更
      if (cur && cur.status === 'absent' && prev && prev.checkins > 0) recentAbsent = issues[i].issueNo;
    }

    facts.set(m.nickname, {
      nickname: m.nickname,
      cum,
      activeWeeks,
      metWeeks,
      leaveWeeks,
      absentWeeks,
      missingWeeks,
      weeklyAvg,
      rankText,
      avgText,
      recentText,
      peakText,
      top3: sports.slice(0, 3).map(([s, n]) => `${s}${n}`).join(' '),
      streakText: Number.isFinite(cum.streak) ? `连击${cum.streak}` : '连击—',
      // —— 以下仅角度判定用（展示区已给过的字段不重复声明）——
      recentAvg: recent.avg,
      recentBase: recent.base,
      peakAge: peak ? series.length - 1 - peak.i : null,
      peakCalories: peak?.calories ?? 0,
      recentLeave,
      recentAbsent,
      topSport: sports[0]?.[0] || '',
      top2Sport: sports[1] ? `${sports[1][0]}${sports[1][1]}` : '',
      top1: sportTotal > 0 ? sports[0][1] / sportTotal : 0,
      kinds: sports.length,
      totalCheckins: cum.totalCheckins ?? 0,
      leaveWeeks,
      absentWeeks,
      met: metWeeks,
      total: issues.length,
      streak: Number.isFinite(cum.streak) ? cum.streak : 0,
      avg: weeklyAvg,
      rank: rank?.rank ?? 1,
      size: rank?.size ?? 1,
    });
  }
  const angleMap = assignAngles([...facts.values()]);

  lines.push(
    `每人（${targets.length} 人）· 达标/期数 · 打卡(总次数) · 请假 · 缺席 · 周均(累计·排名) · 近4期 · 峰值 · 连击 · 累计项目 Top3 · ▸=full 主论点角度`
  );
  for (const m of targets) {
    const f = facts.get(m.nickname);
    if (!f) {
      lines.push(`  ${m.nickname} · 无累计记录（本期新成员或曾改名），跳过`);
      continue;
    }
    const angle = angleMap.get(m.nickname);
    const angleText = angle ? ` · ▸${angle.tier} ${angle.evidence}` : '';
    lines.push(
      `  ${m.nickname} · 达标${f.metWeeks}/${issues.length} · 打卡${f.activeWeeks}(共${f.cum.totalCheckins ?? 0}次) · 请假${f.leaveWeeks} · 缺席${f.absentWeeks} · ${f.avgText} · ${f.recentText} · 峰值${f.peakText} · ${f.streakText} · ${f.top3 || '无'}${f.missingWeeks > 0 ? ` · 无记录${f.missingWeeks}期` : ''}${angleText}`
    );
  }

  lines.push(`近期 4 期（写 recent 取材；格式 期号 消耗kcal/时长min(状态)）`);
  for (const m of targets) {
    const cum = cumulative.members?.[m.nickname];
    if (!cum) continue;
    const series = seriesOf(m.nickname).slice(-4);
    const from = Math.max(0, issues.length - 4);
    const cells = series.map((r, i) => {
      const it = issues[from + i];
      const tag = r
        ? `#${String(it.issueNo).padStart(2, '0')} ${r.calories}/${Math.round(r.minutes)}(${r.status})`
        : `#${String(it.issueNo).padStart(2, '0')} 无记录`;
      return tag;
    });
    lines.push(`  ${m.nickname} · ${cells.join(' · ')}`);
  }

  lines.push(`（最新期号 ${issueNo}）`);
  return lines.join('\n');
}

function main() {
  const { reportsDir, membersPath, name, outPath, digest } = parseArgs(process.argv);

  if (!existsSync(reportsDir)) {
    console.error(`✗ 归档目录不存在：${reportsDir}`);
    process.exit(1);
  }
  if (!existsSync(membersPath)) {
    console.error(`✗ 未找到 members.json：${membersPath}`);
    console.error('  默认读取 reports 目录上一级（工作区根目录）的 members.json，也可用 --members 指定。');
    if (existsSync(LEGACY_MEMBERS_PATH) && LEGACY_MEMBERS_PATH !== membersPath) {
      console.error(`  检测到旧版配置：${LEGACY_MEMBERS_PATH}`);
      console.error(`  请迁移到 ${resolve(dirname(reportsDir), 'members.json')}（新版本不再默认读取 skill 目录内配置）。`);
    }
    process.exit(1);
  }
  let config;
  try {
    // 剥离 UTF-8 BOM：Windows 记事本 / PowerShell 默认会写入 BOM，JSON.parse 会报 Unexpected token
    config = JSON.parse(readFileSync(membersPath, 'utf-8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error(`✗ members.json 解析失败：${membersPath}`);
    console.error(`  原因：${e.message}`);
    console.error('  常见原因：手工改配置时漏逗号/引号、括号不匹配、写盘截断，或保存成了带 UTF-8 BOM 的编码。');
    console.error('  字段口径见 assets/members.sample.md；用编辑器以「UTF-8 无 BOM」重存或修好语法后重跑。');
    process.exit(1);
  }

  const archivePath = findLatestArchive(reportsDir);
  if (!archivePath) {
    console.error('✗ 未找到任何归档，请先生成至少一期周报。');
    process.exit(1);
  }
  let archive;
  try {
    // 剥离 UTF-8 BOM（同上）
    archive = JSON.parse(readFileSync(archivePath, 'utf-8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error(`✗ 归档解析失败：${archivePath}`);
    console.error(`  原因：${e.message}`);
    console.error('  常见原因：归档被写盘截断、手工改过、或保存成了带 UTF-8 BOM 的编码。');
    console.error('  归档是不可变快照，禁止手工编辑；请用当前版本 calc.mjs + render.mjs 重新生成该期后重跑。');
    process.exit(1);
  }
  if (!archive.cumulative) {
    console.error(`✗ 归档 ${archivePath} 缺少 cumulative（旧版生成的归档），请用当前版本 calc.mjs 重新生成该期归档。`);
    process.exit(1);
  }

  // 归档里的旧昵称先按 aliases 归一到当前规范名，再参与累计/排行/个人卡片
  const nicknameIndex = buildNicknameIndex(config.members);
  const cumulative = canonicalizeCumulative(archive.cumulative, nicknameIndex);

  const issueNo = archive.issueNo;
  const spotlights = canonicalizeByKey(archive.spotlights || {}, nicknameIndex);
  const issueCount = cumulative.group?.issueCount || issueNo;

  // --digest：只打印历史速览（写 personal-insights.json 的取材），不渲染、不校验侧车、不写文件
  if (digest) {
    const actives = config.members.filter((m) => m.status === 'active');
    const targets = pickTargets(name, actives);
    console.log(buildDigest({ issues: loadHistory(reportsDir), cumulative, targets, rankPool: actives, nicknameIndex, issueNo }));
    return;
  }

  // 全历史起止：首期归档 weekStart → 最新归档 weekEnd（标题条日期区间）
  let rangeStart = null;
  const earliestPath = findEarliestArchive(reportsDir);
  if (earliestPath) {
    try {
      rangeStart = JSON.parse(readFileSync(earliestPath, 'utf-8')).weekStart || null;
    } catch {
      rangeStart = null;
    }
  }
  if (rangeStart === archive.weekStart) rangeStart = null; // 仅一期时省略区间

  // 数据详情弹窗静态数据（成就分层 / 连击档位 / 项目强度分组，单一真源在 cumulative.mjs + members.json）
  const badgeIntro = buildBadgeIntro(config);
  const capsuleTiers = streakCapsuleTiers();
  const sportGroups = buildSportGroups(config);
  const spotlightIntro = buildSpotlightIntro();

  // AI 双行分析（侧车文件 reports/personal-insights.json：{ issueNo, notes: { 昵称: { full, recent } } }，必写）
  // 期号匹配才生效；不匹配/不存在 → aiFull/aiRecent 为空，模板隐藏对应行（兜底降级，正常流程不应发生）
  const sidecarPath = resolve(reportsDir, 'personal-insights.json');
  let aiNotes = null;
  if (existsSync(sidecarPath)) {
    try {
      // 侧车是 AI 手写文件，可能带 BOM：剥离后再解析，避免洞察整块静默隐藏
      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8').replace(/^\uFEFF/, ''));
      // notes 的 key 按别名/归一化落到当前规范名——照抄接龙里的脏昵称（emoji、波浪号、改名前旧名）也能命中
      if (sidecar.issueNo === issueNo && sidecar.notes) aiNotes = canonicalizeByKey(sidecar.notes, nicknameIndex);
    } catch (e) {
      console.warn(`⚠ personal-insights.json 解析失败，AI 趋势行将隐藏：${e.message}`);
    }
  }

  // 只取 active 成员
  const activeMembers = config.members.filter((m) => m.status === 'active');
  const targetMembers = pickTargets(name, activeMembers);

  // 数据洞察覆盖检查（必写模块）：侧车缺失/期号不匹配/成员缺条目 → 打印警告，提示补写侧车后重跑
  if (!aiNotes) {
    console.warn(
      `⚠ 数据洞察侧车未生效（personal-insights.json 缺失或期号不匹配，当前期 ${issueNo}）——全部成员的数据洞察区将隐藏。\n` +
        `  数据洞察为必写模块：请先写 reports/personal-insights.json（{"issueNo": ${issueNo}, "notes": { 昵称: { full, recent } }}）再重跑本命令`
    );
  } else {
    const missing = targetMembers
      .filter((m) => cumulative.members[m.nickname])
      .filter((m) => !(aiNotes[m.nickname] && aiNotes[m.nickname].full && aiNotes[m.nickname].recent))
      .map((m) => m.nickname);
    if (missing.length > 0) {
      console.warn(
        `⚠ 数据洞察缺成员：${missing.join('、')}（notes 需含 full + recent 两行）——对应成员的洞察区将隐藏，请补写侧车后重跑本命令`
      );
    }
  }
  // 双行文案的机器可检部分（规则见 references/insight-writing.md §0-3、§2.3）
  // 双行骨架是「数据在前、判断在后」，只拦真正的病灶：跨人骨架复制。
  // 比对用全群而非 targetMembers：--name 补生成单人时，也要发现「这个人撞了别人」。
  if (aiNotes) {
    const rows = activeMembers
      .filter((m) => aiNotes[m.nickname] && cumulative.members[m.nickname])
      .map((m) => ({ nickname: m.nickname, ...aiNotes[m.nickname] }));
    const fulls = [];
    const recents = [];
    for (const r of rows) {
      if (!r.full || !r.recent) continue;
      fulls.push({ key: `${r.nickname}·full`, text: r.full });
      recents.push({ key: `${r.nickname}·recent`, text: r.recent });
    }
    const dupF = findSkeletonDuplicates(fulls);
    const dupR = findSkeletonDuplicates(recents);
    const copied = [...dupF.copied, ...dupR.copied];
    const similar = [...dupF.similar, ...dupR.similar];
    if (copied.length > 0) {
      console.error(`✗ ${copied.length} 对双行骨架几乎相同（跨人同脸）：`);
      copied.slice(0, 6).forEach((c) => console.error(`  - ${c.a} ↔ ${c.b} 重合 ${c.sim.toFixed(2)}`));
      console.error('  按速览的 ▸ 角度重写，换观察轴而不是换数字（references/insight-writing.md §2.3）');
      process.exit(1);
    }
    if (similar.length > 0) {
      console.warn('⚠ 以下双行骨架较近（0.65–0.8），确认不是只换了数字：');
      similar.slice(0, 6).forEach((c) => console.warn(`  - ${c.a} ↔ ${c.b} 重合 ${c.sim.toFixed(2)}`));
    }
  }

  const members = targetMembers
    .filter((m) => cumulative.members[m.nickname])
    .map((m) =>
      buildMemberView({
        cum: cumulative.members[m.nickname],
        member: m,
        config,
        issueNo,
        issueCount,
        spotlights,
        aiNotes,
      })
    );

  if (members.length === 0) {
    console.error('✗ 没有可生成的成员数据（cumulative 中无对应记录）。');
    process.exit(1);
  }

  // 累计排行（加 --name 时不生成）：默认按累计消耗降序（页面初始序，不显示排名序号）；
  // 页面内表头可交互升降序（模板 JS），此处只产出初始序与全部排序字段
  const ranking = name
    ? []
    : members
        .map((v) => ({
          nickname: v.nickname,
          personaTag: v.personaTag,
          personaClass: v.personaClass,
          totalCalories: v.totalCalories,
          bestCalories: v.bestCalories,
          totalMinutes: v.totalMinutes,
          effText: v.effText,
          effNum: v.effNum,
          totalCheckins: v.totalCheckins,
          metRate: v.metRate,
          streak: v.streak,
          streakPill: v.streakPill,
        }))
        .sort((a, b) => b.totalCalories - a.totalCalories);

  const tplRaw = readFileSync(TEMPLATE_PATH, 'utf-8');
  // 小写 helper：数据驱动的 class 后缀必须全小写输出——html2canvas-pro 导出管线
  // 会把克隆 DOM 的 class 名归一为小写，驼峰类名在导出图中静默失效（详见模板内注释）
  Handlebars.registerHelper('lower', (v) => String(v ?? '').toLowerCase());
  const template = Handlebars.compile(tplRaw);
  const html = template({ issueNo, rangeStart, rangeEnd: archive.weekEnd, members, ranking, badgeIntro, capsuleTiers, sportGroups, spotlightIntro });

  const finalOut = outPath || resolve(reportsDir, `${archive.weekStart.slice(0, 4)}-issue${String(issueNo).padStart(2, '0')}-personal.html`);
  mkdirSync(dirname(finalOut), { recursive: true });
  writeFileSync(finalOut, html, 'utf-8');

  console.log(`✓ 个人战报生成完成：${finalOut}`);
  console.log(`  截至第 ${issueNo} 期${rangeStart ? `（${rangeStart} — ${archive.weekEnd}）` : ''}，共 ${members.length} 人`);
}

main();
