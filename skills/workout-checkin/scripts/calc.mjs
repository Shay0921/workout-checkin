#!/usr/bin/env node
/**
 * 运动打卡周报 · 计算脚本（确定性数据层）
 *
 * 用法：
 *   node calc.mjs <records.json> [--members members.json] [--week YYYY-MM-DD] [--min-checkins N] [-o data.json] [--allow-missing-prev]
 *
 *   members.json 默认读取 records.json 同目录（即工作区根目录）；--members 可覆盖。
 *   --min-checkins N：特殊周期（节假日等）临时覆盖 weekRule.minCheckins 达标线，
 *                     达标判定/达标率/状态文案/红包档位全部自动跟随，data.json 的
 *                     minCheckins 字段记录当期生效值（归档可追溯）
 *   --allow-missing-prev：账本已有归档却缺上期时，明示「放弃历史、从本期重新起链」。
 *                     仅在用户确认归档迁移/换新账本时使用——cumulative 期数、连击、
 *                     里程碑全部归零重算，且这份新基线会写进本期归档往下传。
 *                     上期归档存在但损坏时本 flag 无效（那是修文件，不是断链）。
 *
 * 职责（按顺序执行）：
 *   1. 从磁盘重读 members.json（默认 records.json 同目录，唯一配置真源，杜绝会话缓存漂移）
 *   2. 周期与期号计算（本地时区，全程禁止 toISOString —— 其返回 UTC 日期，东八区会倒退一天）
 *   3. 定位并读取上期归档（本年 issue<NN-1> → 跨年回退扫描上一年最大期号）
 *   4. 昵称/运动归一化、量纲换算、卡路里计算、36 个基础统计字段
 *   5. 输出 data.json（36 个基础字段 + insights 空数组占位 + 8 个扩展字段：
 *      cumulative / metSnapshot / spotlights / milestoneCelebrations / calorieKing /
 *      efficiencyStar / progressStar / streakBreaks；insights 由 AI 补写后再渲染）
 *
 * 设计原则：本脚本是唯一计算真源——同一份 records.json 无论何时、何模型触发，
 * 计算结果完全一致。AI 只负责把接龙文本翻译成 records.json，不参与任何计算。
 *
 * 退出码：0 成功；1 失败（错误信息打印到 stderr）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCumulative,
  canonicalizeCumulative,
  computeStars,
  computeSpotlights,
  computeStreakBreaks,
  computePersona,
  primaryPersonaTag,
  computeMilestoneCelebrations,
  buildMetSnapshot,
  streakCapsule,
} from './cumulative.mjs';
import { buildNicknameIndex, canonicalName, normalizeName } from './nickname.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LEGACY_MEMBERS_PATH = resolve(SCRIPT_DIR, '../members.json');

// ---------- 日期与期号 ----------

/** 本地时区 YYYY-MM-DD 格式化（禁 toISOString：UTC 日期会使东八区零点倒退一天） */
export function fmtDate(d) {
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时区 YYYY-MM-DD HH:mm 格式化 */
export function fmtDateTime(d) {
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${fmtDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 本地时区解析日期；月日允许不补零（2026-3-5 = 2026-03-05），不是真实日历日期时返回 null。
 * new Date(2026, 1, 30) 会静默滚成 3 月 2 日、new Date(2026, 12, 1) 滚成 2027 年 1 月：
 * 期号与统计周跟着整体偏移，报表标题和归档文件名全错却一路 exit 0，故必须回读比对。
 * @param {string} str 待解析日期
 * @returns {Date|null} 本地时区当日零点，非法则 null
 */
export function parseLocalDate(str) {
  if (typeof str !== 'string') return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(str);
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? dt : null;
}

/**
 * 取任意日期所在自然周（周一~周日）
 * @param {Date} date 任意时刻
 * @returns {{weekStart: string, weekEnd: string}} 周一/周日日期字符串
 */
export function getWeekWindow(date) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // (getDay()+6)%7：周一=0 … 周日=6，回退到本周周一
  const monday = new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { weekStart: fmtDate(monday), weekEnd: fmtDate(sunday) };
}

/**
 * 期号 = anchorIssue + (本周周一 − 锚点所在自然周周一) ÷ 7 天
 * 锚点本身可以落在周内（如首期从周三 10-14 开始），因此先归一到周一再算周差，
 * 否则周五/周六/周日开统时次周会被 round() 误算成同一期。
 * @param {string} weekStart 本周周一 YYYY-MM-DD
 * @param {{anchorIssue: number, anchorWeekStart: string}} periodConfig members.json 的期数锚点
 * @returns {number} 期号
 */
export function calcIssueNo(weekStart, periodConfig) {
  const [y, m, d] = weekStart.split('-').map(Number);
  const targetMonday = new Date(y, m - 1, d);
  const [ay, am, ad] = periodConfig.anchorWeekStart.split('-').map(Number);
  const anchor = new Date(ay, am - 1, ad);
  const anchorMonday = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - ((anchor.getDay() + 6) % 7));
  const diffDays = (targetMonday - anchorMonday) / 86400000;
  return periodConfig.anchorIssue + Math.round(diffDays / 7);
}

/**
 * 解析统计期：常规周取周一~周日；锚点期（首期）取锚点实际起止，
 * 以支持节后开统的短周（如 2026-10-08 ~ 2026-10-11）。
 * @param {Date} date 任意时刻
 * @param {{anchorIssue: number, anchorWeekStart: string, anchorWeekEnd: string}} periodConfig
 * @returns {{weekStart: string, weekEnd: string, issueNo: number}}
 */
export function getIssueWindow(date, periodConfig) {
  const natural = getWeekWindow(date);
  const issueNo = calcIssueNo(natural.weekStart, periodConfig);
  if (issueNo === periodConfig.anchorIssue) {
    return { weekStart: periodConfig.anchorWeekStart, weekEnd: periodConfig.anchorWeekEnd, issueNo };
  }
  return { ...natural, issueNo };
}

// ---------- 解析与归一化 ----------

/**
 * 昵称模糊匹配成员表（两层匹配，禁止猜测）
 *   第一层：精确匹配 —— nickname + aliases 归一化后全等（双向）
 *   第二层：前缀兜底 —— 接龙昵称以成员昵称/别名开头（如「阿明年底目标60KG」→ 阿明）；
 *           仅当唯一成员命中时采纳，命中多个抛 AMBIGUOUS_NICKNAME 异常交人工确认；
 *           归一化后长度 < 2 的候选不参与前缀匹配，防止单字昵称误伤
 * @param {string} raw 接龙原文昵称（可能含脏字符或后缀备注）
 * @param {Array} members 成员数组（元素含 nickname/aliases）
 * @returns {object|null} 命中的成员对象，未命中返回 null
 * @throws {Error} 前缀匹配命中多个成员时抛出（code = AMBIGUOUS_NICKNAME）
 */
export function normalizeNickname(raw, members) {
  const key = normalizeName(raw);
  if (!key) return null;
  // 第一层：精确匹配（nickname + aliases 全量归一化后全等）
  const exact = members.find(
    (m) =>
      normalizeName(m.nickname) === key ||
      (m.aliases || []).some((a) => normalizeName(a) === key)
  );
  if (exact) return exact;
  // 第二层：前缀兜底（唯一命中才采纳，多命中报错，禁止猜测）
  const hits = members.filter((m) => {
    const cands = [m.nickname, ...(m.aliases || [])]
      .map(normalizeName)
      .filter((c) => c.length >= 2);
    return cands.some((c) => key.startsWith(c));
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const err = new Error(
      `昵称「${raw}」前缀匹配到多个成员（${hits.map((h) => h.nickname).join('、')}），请人工确认归属或补充别名`
    );
    err.code = 'AMBIGUOUS_NICKNAME';
    throw err;
  }
  return null;
}

/**
 * 运动项目归一化：先直查 MET 表（力训/自由训练是独立条目，MET 不同，禁止盲目归一），
 * 未命中再走 sportAlias 双向映射兜底（别名值支持 string 或 string[]，如「散步」↔「步行/户外散步」），
 * 仍未命中返回 null（由调用方报错，禁止猜测）
 * @param {string} raw 接龙原文项目名
 * @param {object} met MET 表（标准名 → MET 值）
 * @param {object} sportAlias 别名映射（标准名 → 别名或别名数组）
 * @returns {{name: string, met: number}|null}
 */
export function resolveSport(raw, met, sportAlias) {
  if (Object.hasOwn(met, raw)) return { name: raw, met: met[raw] };
  for (const [std, alias] of Object.entries(sportAlias || {})) {
    const cands = Array.isArray(alias) ? alias : [alias];
    for (const a of cands) {
      if (raw === a && Object.hasOwn(met, std)) return { name: std, met: met[std] };
      if (raw === std && Object.hasOwn(met, a)) return { name: a, met: met[a] };
    }
  }
  return null;
}

/** 支持的量纲单位（records[].unit 枚举；新增量纲要同步 toMinutes 与 convert 配置） */
export const SUPPORTED_UNITS = ['h', 'min', 'floor', 'km', 'count'];

/**
 * 量纲换算为分钟（四舍五入取整）
 * h×60 / min 原值 / floor×climbPerFloorMin / km×convert.kmPerMin[项目] / count×convert.minPerCount[项目]
 * 折算单位一律按**项目标准名**查表：查不到返回 null 交上层报错，禁止借用其他项目的系数
 * @returns {number|null} 分钟数；未知单位或缺少该项目的换算系数返回 null
 */
export function toMinutes(quantity, unit, convert, sportName = null) {
  const c = convert || {};
  const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  switch (unit) {
    case 'h': return Math.round(quantity * 60);
    case 'min': return Math.round(quantity);
    case 'floor': return positive(c.climbPerFloorMin) ? Math.round(quantity * c.climbPerFloorMin) : null;
    case 'km': {
      const pace = c.kmPerMin?.[sportName];
      return positive(pace) ? Math.round(quantity * pace) : null;
    }
    case 'count': {
      const perCount = c.minPerCount?.[sportName];
      return positive(perCount) ? Math.round(quantity * perCount) : null;
    }
    default: return null;
  }
}

/** 卡路里 = MET × 体重kg × 时长h，四舍五入取整（逐条计算，最后累加） */
export function calcCalories(met, weightKg, minutes) {
  return Math.round(met * weightKg * (minutes / 60));
}

// ---------- 较上期增减角标 ----------

/** 显示阈值：绝对差（分钟）与相对差（%）需同时满足 */
export const DELTA_MIN_MINUTES = 20;
export const DELTA_MIN_PCT = 30;

/**
 * 为打卡名单派生「较上期增减」角标。
 * 阈值取「绝对 ≥20 分钟 且 相对 ≥30%」：42 期真实归档回测显示，宽松阈值（5min/10%）命中率 81%，
 * 等于人人有奖、失去信息量；20min/30% 约为每周 0.7 人，具备稀缺性。
 * 静默规则（全部不显示）：无上期记录（新人）/ 上期整周请假 / 上期 <10 分钟（基线过小）/ 本期 0 分钟。
 * 只输出方向与数量（▲55 / ▼42），单位由模板列头交代。
 * @param {Array<object>} checkinList 打卡名单（就地补充 deltaMinutes / deltaText / deltaClass）
 * @param {object|null} prevCumulative 上期 cumulative 快照
 * @returns {Array<object>} 传入的 checkinList（便于链式调用）
 */
export function attachDeltaBadges(checkinList, prevCumulative) {
  for (const row of checkinList || []) {
    const prevWeek = prevCumulative?.members?.[row.nickname]?.recentWeeks?.slice(-1)[0];
    if (!prevWeek || prevWeek.status === 'leave') continue;
    if (prevWeek.minutes < 10 || row.totalMinutes <= 0) continue;
    const delta = row.totalMinutes - prevWeek.minutes;
    if (Math.abs(delta) < DELTA_MIN_MINUTES) continue;
    if ((Math.abs(delta) / prevWeek.minutes) * 100 < DELTA_MIN_PCT) continue;
    row.deltaMinutes = delta;
    row.deltaText = `${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}`;
    row.deltaClass = delta > 0 ? 'up' : 'down';
  }
  return checkinList;
}

// ---------- 上期归档定位 ----------

/**
 * 定位上期归档：先查本年 <年>-issue<NN-1>.json；
 * 不存在（或 NN-1 < 1）则跨年回退——但只接受「上一年最大期号恰为 NN-1」，
 * 因为期号全局连续递增（如 2027-issue14 的上期是 2026-issue13）。
 * 读到的文件还必须是「内容期号 = 期望期号」：文件名像 N-1 但内容不是，同样按无上期处理，
 * 且不再转头去跨年拿另一份顶替。回退结果期号对不上（中间缺环）时返回 null，
 * 交给调用方按断链报错，不继续向上找 NN-2、也不拿上一年更早的一期冒充。
 * @param {string} reportsDir 归档目录（records.json 同级的 reports/）
 * @param {number} issueNo 本期期号
 * @param {string} year 本期年份（weekStart 前 4 位）
 * @returns {object|null} 上期归档对象；无归档/目录不存在/文件损坏/内容期号不符/期号不连续均返回 null
 */
export function findPrevReport(reportsDir, issueNo, year) {
  const readJson = (p, expectedNo) => {
    try {
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      if (Number(d.issueNo) !== expectedNo) {
        console.warn(`⚠ 归档内容期号不符，已按「无上期」返回：${p}（文件内 ${d.issueNo}，期望 ${expectedNo}）`);
        return null;
      }
      return d;
    } catch {
      console.warn(`⚠ 上期归档解析失败，已按「无上期」返回：${p}`);
      return null;
    }
  };
  const prevNo = issueNo - 1;
  if (prevNo >= 1) {
    const p = resolve(reportsDir, `${year}-issue${String(prevNo).padStart(2, '0')}.json`);
    if (existsSync(p)) return readJson(p, prevNo);
  }
  // 跨年回退：如 2027-issue14 的上期是 2026-issue13（上一年最后一期）。
  // 只有「上一年最大期号 === NN-1」才算接上链；NN-1 落在更早的年份或中间缺环时
  // 一律返回 null，由 4.5 断链拦截报错，绝不拿 NN-2、NN-3 顶替。
  let files = [];
  try {
    files = readdirSync(reportsDir);
  } catch {
    return null; // 归档目录不存在 → 首期
  }
  const prevYear = String(Number(year) - 1);
  const re = new RegExp(`^${prevYear}-issue(\\d{2,})\\.json$`);
  let maxNo = -1;
  for (const f of files) {
    const m = f.match(re);
    if (m) maxNo = Math.max(maxNo, Number(m[1]));
  }
  if (maxNo >= 1 && (prevNo < 1 || maxNo === prevNo)) {
    return readJson(resolve(reportsDir, `${prevYear}-issue${String(maxNo).padStart(2, '0')}.json`), maxNo);
  }
  return null;
}

// ---------- 核心统计 ----------

/**
 * 计算全部统计字段（36 个基础字段 + insights 空数组占位 + 8 个扩展字段）
 *
 * 口径钉死：
 *   - 成员打卡次数 = distinct(昵称, ordinal)；同一次打卡的多个项目各计 1 人次（sportStats）
 *   - (昵称, 次数, 项目) 三元组重复：分钟相同 → 重复贴去重；不同 → 补充贴合并累加
 *   - ordinal 为 null → 按出现顺序补入该成员尚未占用的最小正整数
 *   - 请假成员同时有打卡记录 → 以打卡为准（请假标记仅限整周未打卡者）
 *
 * @param {object} p
 * @param {Array} p.records 打卡流水（AI 翻译产物）
 * @param {Array} [p.leaves] 请假名单
 * @param {object} p.config members.json 完整配置
 * @param {{weekStart: string, weekEnd: string}} p.weekWindow 周期
 * @param {number} p.issueNo 期号
 * @param {object|null} p.prevReport 上期归档（null = 首期）
 * @param {string} p.generatedAt 生成时间
 * @returns {object} data.json 数据对象
 * @throws {Error} 聚合全部解析错误（未知昵称/运动/单位）后一次性抛出
 */
export function buildStats({ records, leaves = [], config, weekWindow, issueNo, prevReport, generatedAt }) {
  const { group, weekRule, redPacket, met, sportAlias, defaultWeightKg } = config;
  const convert = config.convert || {};
  const minCheckins = weekRule.minCheckins;
  const activeMembers = config.members.filter((m) => m.status === 'active');
  const nickOf = (idx) => activeMembers[idx].nickname;

  // --- 请假名单归一（times 缺省 = 整周豁免；times 为正整数 = 部分请假 N 次抵 N 次打卡义务） ---
  const errors = [];
  const leaveInfo = new Map(); // memberIdx -> { reason, reasons, times }（times: null 整周豁免 / 正整数 部分请假；同人多条合并见下）
  const fmtTimes = (t) => (t === null ? '整周豁免' : `${t}次`);
  for (const lv of leaves) {
    let m = null;
    try {
      m = normalizeNickname(lv.nickname, activeMembers);
    } catch (e) {
      if (e.code === 'AMBIGUOUS_NICKNAME') {
        errors.push(e.message);
        continue;
      }
      throw e;
    }
    if (!m) {
      errors.push(`未知昵称「${lv.nickname}」（请假名单，不在成员表）`);
      continue;
    }
    let times = null;
    if (lv.times !== undefined && lv.times !== null) {
      times = Number(lv.times);
      if (!Number.isInteger(times) || times < 1) {
        errors.push(`请假次数无效：「${lv.nickname}」times=${lv.times}（应为正整数；未注明次数则省略 times = 整周豁免）`);
        continue;
      }
    }
    // 同一成员多条 leaves（「周三出差」+「周六感冒」）合并，不能后者覆盖前者：
    // 覆盖会把 1 次 + 2 次算成 2 次，成员白丢一次打卡义务；更糟的是覆盖掉整周豁免
    // （times=null）后，该成员从 leaveList 掉进未达标名单并触发红包。
    const idx = activeMembers.indexOf(m);
    const reason = lv.reason || '请假';
    const prev = leaveInfo.get(idx);
    if (!prev) {
      leaveInfo.set(idx, { reason, reasons: [reason], times });
      continue;
    }
    const mergedTimes = prev.times === null || times === null ? null : prev.times + times;
    const reasons = prev.reasons.includes(reason) ? prev.reasons : [...prev.reasons, reason];
    const merged = { reason: reasons.join('、'), reasons, times: mergedTimes };
    console.warn(
      `⚠ ${m.nickname} 有多条请假记录，已合并：${fmtTimes(prev.times)} + ${fmtTimes(times)} → ${fmtTimes(mergedTimes)}（事由：${merged.reason}）`
    );
    leaveInfo.set(idx, merged);
  }

  // --- 打卡流水归一（昵称/项目/单位逐一校验，错误聚合后统一抛出） ---
  const flows = []; // {memberIdx, ordinal, sportName, met, minutes, weightKg}
  for (const r of records) {
    let m = null;
    try {
      m = normalizeNickname(r.nickname, activeMembers);
    } catch (e) {
      if (e.code === 'AMBIGUOUS_NICKNAME') {
        errors.push(e.message);
        continue;
      }
      throw e;
    }
    if (!m) {
      errors.push(`未知昵称「${r.nickname}」（不在成员表，请确认是否新成员）`);
      continue;
    }
    const s = resolveSport(r.sport, met, sportAlias);
    if (!s) {
      errors.push(`未知运动「${r.sport}」（成员 ${m.nickname}，MET 表与别名均未命中）`);
      continue;
    }
    // 次数标注契约：整条省略 / null = 由下面按出现顺序补号；写了就必须是正整数 number。
    // 打卡次数 = st.ordinals.size，而 ordinals 是 Set（严格相等）——同一次打卡的两个项目
    // 若一个写 1、一个写 "1"，会各占一个元素被数成 2 次，次数虚高连带红包档位下移。
    // 因此和 quantity 同一口径：字符串不猜、不兜底转换，直接点名报错让 records.json 改回数字。
    const ordinal = r.ordinal ?? null;
    if (ordinal !== null && (!Number.isInteger(ordinal) || ordinal < 1)) {
      errors.push(
        `次数标注非法「${m.nickname} · ${r.sport}」ordinal=${JSON.stringify(r.ordinal)}（${typeof r.ordinal === 'string' ? '写成了字符串，去掉引号' : '应为正整数 number'}；0 / 负数 / 小数 / 中文序数会让同一次打卡被数成多次，整条省略则由脚本补号）`
      );
      continue;
    }
    // 数量契约：必须是正数数字。
    // AI 翻译产物里出现 NaN（undefined / "abc" / "1,5"）、负数或 0 时，toMinutes 会静默产出
    // NaN / 负分钟并污染全群合计，而 render.mjs 的残留占位符检查拦不住 NaN（会直接印进报表）。
    // 这类「结构上不可能合法」的值一律硬报错，不猜、不兜底换算；数值量级是否合理属于语义判断，
    // 交给下面的软告警让 AI 回读原文——代码不做语义猜测。
    if (typeof r.quantity !== 'number' || !Number.isFinite(r.quantity) || r.quantity <= 0) {
      errors.push(
        `数量非法「${m.nickname} · ${r.sport}」quantity=${String(r.quantity)}（${typeof r.quantity === 'string' ? '写成了字符串，去掉引号' : '必须是正数 number'}；null / NaN / 负数 / 0 / 带单位或逗号的文本都会污染全群合计）`
      );
      continue;
    }
    const minutes = toMinutes(r.quantity, r.unit, convert, s.name);
    if (minutes === null) {
      if (!SUPPORTED_UNITS.includes(r.unit)) {
        errors.push(`未知单位「${r.unit}」（成员 ${m.nickname} · ${s.name}，合法值 ${SUPPORTED_UNITS.join('/')}）`);
      } else if (r.unit === 'floor') {
        errors.push(`楼层换算未配置：成员 ${m.nickname} · ${s.name} 使用了 floor，但 members.json 的 convert.climbPerFloorMin 缺失或非法；先询问用户每层折算几分钟，再写入配置`);
      } else if (r.unit === 'km') {
        errors.push(`公里换算未配置：成员 ${m.nickname} · ${s.name} 使用了 km，但 members.json 的 convert.kmPerMin["${s.name}"] 缺失或非法；先询问用户这个项目的配速（多少分钟/km），写进 convert.kmPerMin 后重跑（游泳固定 30）`);
      } else if (r.unit === 'count') {
        errors.push(`数量换算未配置：成员 ${m.nickname} · ${s.name} 使用了 count，但 members.json 的 convert.minPerCount["${s.name}"] 缺失或非法；先询问用户每个动作折算几分钟，再写入配置`);
      }
      continue;
    }
    // 软告警（不阻塞）：阈值 600 分钟（10 小时）。徒步/越野等长线 5–8 小时是真实可能的，
    // 门槛低于此会误报；600 以上基本只剩「30min 被写成 30h」这类单位误读。
    if (minutes > 600) {
      console.warn(
        `⚠ ${m.nickname} · ${r.sport} 单条 ${minutes} 分钟（原值 ${r.quantity}${r.unit}）超出常规，请回读接龙原文核对单位`
      );
    }
    const weightKg = m.weightKg ?? defaultWeightKg;
    if (typeof weightKg !== 'number' || !Number.isFinite(weightKg) || weightKg <= 0) {
      errors.push(
        `体重无效：成员「${m.nickname}」weightKg=${String(m.weightKg ?? '未填')}，defaultWeightKg=${String(defaultWeightKg ?? '未配置')}——两者都需要正数（给该成员补真实体重，或在 members.json 配 defaultWeightKg）`
      );
      continue;
    }
    flows.push({
      memberIdx: activeMembers.indexOf(m),
      ordinal,
      sportName: s.name,
      met: s.met,
      minutes,
      weightKg,
    });
  }
  if (errors.length > 0) {
    throw new Error(`records 解析失败 ${errors.length} 项：\n  - ${errors.join('\n  - ')}`);
  }

  // --- ordinal 补号：null 依次填入该成员尚未占用的最小正整数 ---
  const byMember = new Map();
  for (const f of flows) {
    if (!byMember.has(f.memberIdx)) byMember.set(f.memberIdx, []);
    byMember.get(f.memberIdx).push(f);
  }
  for (const [idx, list] of byMember) {
    const used = new Set(list.filter((f) => f.ordinal !== null).map((f) => f.ordinal));
    let next = 1;
    let patched = 0;
    for (const f of list) {
      if (f.ordinal === null) {
        while (used.has(next)) next++;
        f.ordinal = next;
        used.add(next);
        patched++;
      }
    }
    if (patched > 0) console.warn(`⚠ ${nickOf(idx)} 有 ${patched} 条记录缺次数标注，已按出现顺序补号`);
  }

  // --- 三元组去重/合并：(成员, 次数, 项目) 相同 → 同量去重（重复贴）/ 异量合并（补充贴） ---
  const merged = new Map();
  for (const f of flows) {
    const key = `${f.memberIdx}|${f.ordinal}|${f.sportName}`;
    const ex = merged.get(key);
    if (!ex) {
      merged.set(key, { ...f });
    } else if (ex.minutes !== f.minutes) {
      ex.minutes += f.minutes;
      console.warn(`⚠ ${nickOf(f.memberIdx)} 第 ${f.ordinal} 次 ${f.sportName} 存在多条不同时长的记录，已合并为 ${ex.minutes} 分钟`);
    } else {
      console.warn(`⚠ ${nickOf(f.memberIdx)} 第 ${f.ordinal} 次 ${f.sportName} 疑似重复贴，已去重`);
    }
  }
  const finalFlows = [...merged.values()];

  // 单人单周合计异常（>1200 分钟 = 20 小时）→ 软告警。正常单人单周远低于此量级，
  // 设 20 小时只用于兜住单位误读。
  const weekMinutes = new Map();
  for (const f of finalFlows) weekMinutes.set(f.memberIdx, (weekMinutes.get(f.memberIdx) || 0) + f.minutes);
  for (const [idx, sum] of weekMinutes) {
    if (sum > 1200) console.warn(`⚠ ${nickOf(idx)} 本周合计 ${sum} 分钟（>20 小时），疑似单位误读，请回读原文核对`);
  }

  // --- 每成员统计 ---
  const memberStats = activeMembers.map((m, idx) => {
    const lv = leaveInfo.get(idx) ?? null;
    return {
      idx,
      nickname: m.nickname,
      isLeave: lv !== null && lv.times === null, // 整周豁免（请假未注明次数）
      leaveTimes: lv !== null && lv.times !== null ? lv.times : 0, // 部分请假次数（抵扣打卡义务）
      leaveReason: lv?.reason ?? null,
      ordinals: new Set(),
      totalMinutes: 0,
      totalCalories: 0,
      loadScore: 0, // Σ(MET × 分钟)：体重无关的训练负荷分，燃效之星/平均强度专用
      weightKg: null, // 取自打卡流水（含 defaultWeightKg 兜底），供 kcal/min → MET 换算
      sports: {}, // 项目分布·人次（原始项目名 → 次数），cumulative 按 sportNickname 聚合
    };
  });
  for (const f of finalFlows) {
    const st = memberStats[f.memberIdx];
    st.ordinals.add(f.ordinal);
    st.totalMinutes += f.minutes;
    st.totalCalories += calcCalories(f.met, f.weightKg, f.minutes);
    st.loadScore += f.met * f.minutes;
    st.weightKg = f.weightKg;
    st.sports[f.sportName] = (st.sports[f.sportName] || 0) + 1;
  }
  // 边界规则 1：整周豁免成员同时有打卡记录 → 以打卡为准（请假标记仅限整周未打卡者）
  // 边界规则 2：部分请假但 0 打卡、且请假次数 ≥ 达标线 → 等同整周豁免（进请假名单，¥0）
  for (const st of memberStats) {
    if (st.isLeave && st.ordinals.size > 0) {
      st.isLeave = false;
      leaveInfo.delete(st.idx);
      console.warn(`⚠ ${st.nickname} 请假但本周有打卡记录，按打卡统计（请假标记仅限整周未打卡者）`);
    }
    if (!st.isLeave && st.leaveTimes > 0 && st.ordinals.size === 0 && st.leaveTimes >= minCheckins) {
      st.isLeave = true;
      console.warn(`⚠ ${st.nickname} 本周无打卡、请假 ${st.leaveTimes} 次 ≥ 达标线 ${minCheckins}，按整周豁免处理`);
    }
  }

  // --- 每成员状态与红包（口径：有效次数 = 打卡次数 + 部分请假次数，请假 N 次抵 N 次义务） ---
  // 请假 → ¥0；打卡已达标 → 「达标」（不注请假）；打卡不足但有效次数达标 → 「达标+N请假」；
  // minCheckins ≥ 2 且有效次数差 1 → two 档「差 1 次」；其余 → zeroOrOne 档「差 N 次或未打卡」
  // redPacketTierText 与档位归集共用同一次判定，避免文案与状态两处各算一遍走样
  for (const st of memberStats) {
    st.checkinCount = st.ordinals.size;
    st.effectiveCount = st.checkinCount + st.leaveTimes;
    st.redPacketTierText = null;
    if (st.isLeave) {
      st.statusClass = null;
      st.gapText = null;
      st.redPacketAmount = 0;
    } else if (st.checkinCount >= minCheckins) {
      st.statusClass = 'success';
      st.gapText = '达标'; // 打卡已够线：即使有部分请假也只显示「达标」
      st.redPacketAmount = 0;
    } else if (st.effectiveCount >= minCheckins) {
      st.statusClass = 'success';
      st.gapText = `达标+${st.leaveTimes}请假`;
      st.redPacketAmount = 0;
    } else if (minCheckins >= 2 && st.effectiveCount === minCheckins - 1) {
      st.statusClass = 'warning';
      st.gapText = '差 1 次';
      st.redPacketAmount = redPacket.two;
      st.redPacketTierText = `¥${redPacket.two} · 差 1 次`;
    } else {
      st.statusClass = st.effectiveCount === 0 ? 'danger' : 'warning';
      st.gapText = st.effectiveCount === 0 ? '未打卡' : `差 ${minCheckins - st.effectiveCount} 次`;
      st.redPacketAmount = redPacket.zeroOrOne;
      st.redPacketTierText =
        minCheckins === 1
          ? `¥${redPacket.zeroOrOne} · 未打卡`
          : `¥${redPacket.zeroOrOne} · 差 ${minCheckins - 1} 次或未打卡`;
    }
  }

  // --- lastStatus 枚举（cumulative 连击/回归/逆袭判定基础）---
  for (const st of memberStats) {
    if (st.isLeave) st.lastStatus = 'leave';
    else if (st.statusClass === 'success') st.lastStatus = 'met';
    else if (st.statusClass === 'warning') st.lastStatus = 'partial';
    else st.lastStatus = 'absent';
  }
  // --- 群体指标（百分比取整；角度 = percent × 3.6 保留 1 位小数；absentAngle 相减保证闭环） ---
  const totalMembers = memberStats.length;
  const pct = (n) => (totalMembers === 0 ? 0 : Math.round((n / totalMembers) * 100));
  const angle = (p) => Math.round(p * 3.6 * 10) / 10;

  const checkinMemberCount = memberStats.filter((s) => !s.isLeave && s.checkinCount >= 1).length;
  const leaveMemberCount = memberStats.filter((s) => s.isLeave).length;
  const absentMemberCount = memberStats.filter((s) => !s.isLeave && s.checkinCount === 0).length;
  const metCount = memberStats.filter((s) => !s.isLeave && s.effectiveCount >= minCheckins).length;

  const checkinPercent = pct(checkinMemberCount);
  const leavePercent = pct(leaveMemberCount);
  const absentPercent = pct(absentMemberCount);
  const checkinAngle = angle(checkinPercent);
  const leaveAngle = angle(leavePercent);
  const absentAngle = Math.round((360 - checkinAngle - leaveAngle) * 10) / 10;

  // --- 运动类型（人次 = 流水条数；6+1 规则：≤7 种全列，≥8 种取前 6 + 「其他」行） ---
  const sportCount = new Map();
  const sportMinutes = new Map();
  const sportCalories = new Map();
  for (const f of finalFlows) {
    sportCount.set(f.sportName, (sportCount.get(f.sportName) ?? 0) + 1);
    sportMinutes.set(f.sportName, (sportMinutes.get(f.sportName) ?? 0) + f.minutes);
    sportCalories.set(
      f.sportName,
      (sportCalories.get(f.sportName) ?? 0) + calcCalories(f.met, f.weightKg, f.minutes)
    );
  }
  // 人次降序，同人次按名称码点升序（保证跨运行确定性）
  const sportEntries = [...sportCount.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  );
  const maxCount = sportEntries[0]?.[1] ?? 0;
  const totalKinds = sportEntries.length;
  const listed = totalKinds <= 7 ? sportEntries : sportEntries.slice(0, 6);
  const sportStats = listed.map(([name, count], i) => {
    const minutes = sportMinutes.get(name) ?? 0;
    const calories = sportCalories.get(name) ?? 0;
    return {
      name,
      count,
      minutes,
      calories,
      kcalPerMin: minutes > 0 ? Math.round((calories / minutes) * 10) / 10 : 0,
      barWidthPercent: maxCount ? Math.round((count / maxCount) * 100) : 0,
      barOpacity: Math.max(0.5, Math.round((1 - i * 0.08) * 100) / 100),
    };
  });
  let hasOtherSports = false;
  let otherSportCount = 0;
  let otherSportTotal = 0;
  let otherBarWidthPercent = 0;
  if (totalKinds >= 8) {
    hasOtherSports = true;
    otherSportCount = totalKinds - 6;
    otherSportTotal = sportEntries.slice(6).reduce((s, [, c]) => s + c, 0);
    otherBarWidthPercent = maxCount ? Math.round((otherSportTotal / maxCount) * 100) : 0;
  }

  // --- 打卡名单（打卡者 + 未打卡者；请假者不进名单。次数降序 → 卡路里降序，0 次自然沉底） ---
  const checkinList = memberStats
    .filter((s) => !s.isLeave)
    .map((s) => ({
      nickname: s.nickname,
      totalMinutes: s.totalMinutes,
      totalCalories: s.totalCalories,
      loadScore: s.loadScore, // 供审计：avgMET = loadScore / totalMinutes
      checkinCount: s.checkinCount,
      statusClass: s.statusClass,
      gapText: s.gapText,
    }))
    .sort((a, b) => b.checkinCount - a.checkinCount || b.totalCalories - a.totalCalories);
  const totalMinutesSum = memberStats.reduce((s, m) => s + m.totalMinutes, 0);
  const totalCaloriesSum = memberStats.reduce((s, m) => s + m.totalCalories, 0);
  // 人均单次时长：分子取全群总分钟，分母取总人次（同一次打卡的多个项目各计 1 人次）
  const totalSessions = finalFlows.length;
  const avgMinutesPerSession = totalSessions > 0 ? Math.round(totalMinutesSum / totalSessions) : 0;

  // --- 请假名单（仅整周豁免，含「0 打卡 + 全请假」转换者；部分请假成员在打卡名单胶囊中注明「+N请假」） ---
  const leaveList = memberStats
    .filter((s) => s.isLeave && s.leaveReason)
    .map((s) => ({ nickname: s.nickname, reason: s.leaveReason }));

  // --- 红包汇总（只列实际有人罚红包的档位，金额降序；名单按成员表顺序） ---
  // 档位文案直接取自状态判定阶段写入的 redPacketTierText，同一次判定既出状态也出档位
  const fined = memberStats.filter((s) => !s.isLeave && s.redPacketAmount > 0);
  const tierMap = new Map(); // tierText -> {unit, members: []}
  for (const s of fined) {
    if (!tierMap.has(s.redPacketTierText)) tierMap.set(s.redPacketTierText, { unit: s.redPacketAmount, members: [] });
    tierMap.get(s.redPacketTierText).members.push(s.nickname);
  }
  const redPacketTiers = [...tierMap.entries()]
    .sort((a, b) => b[1].unit - a[1].unit)
    .map(([tier, t]) => ({
      tier,
      peopleCount: t.members.length,
      amount: t.unit * t.members.length,
      nameList: t.members.join('、'),
    }));
  const redPacketTotal = fined.reduce((s, m) => s + m.redPacketAmount, 0);
  const totalPeople = fined.length;

  // --- 趋势（上期归档对比；首期自动兜底） ---
  const prevTotal = prevReport?.redPacketTotal ?? null;
  const redPacketTrendText =
    prevTotal === null
      ? '首期 · 暂无对比'
      : redPacketTotal > prevTotal
        ? `较上期 +¥${redPacketTotal - prevTotal}`
        : redPacketTotal < prevTotal
          ? `较上期 −¥${prevTotal - redPacketTotal}`
          : '与上期持平';

  // 回归欢迎：上期请假、本周打卡 ≥1 次；多人取打卡分钟最多的一位
  let returnWelcome = null;
  const prevLeaveNicks = new Set((prevReport?.leaveList ?? []).map((l) => l.nickname));
  if (prevLeaveNicks.size > 0) {
    const back = memberStats
      .filter((s) => prevLeaveNicks.has(s.nickname) && s.checkinCount >= 1)
      .sort((a, b) => b.totalMinutes - a.totalMinutes);
    if (back[0]) {
      const first = [...back[0].nickname][0];
      const initial = /^[a-z]$/i.test(first) ? first.toUpperCase() : first;
      returnWelcome = {
        initial,
        nickname: back[0].nickname,
        message: `上周请假，本周回归打卡 ${back[0].totalMinutes} 分钟，欢迎回来！`,
      };
    }
  }

  // --- 可序列化 memberStats（供 cumulative 链式累计消费；ordinals Set 转数组）---
  const memberStatsOut = memberStats.map((s) => ({
    nickname: s.nickname,
    isLeave: s.isLeave,
    lastStatus: s.lastStatus,
    statusClass: s.statusClass,
    checkinCount: s.checkinCount,
    effectiveCount: s.effectiveCount,
    totalMinutes: s.totalMinutes,
    totalCalories: s.totalCalories,
    loadScore: s.loadScore,
    weightKg: s.weightKg,
    redPacketAmount: s.redPacketAmount,
    sports: s.sports,
  }));

  // --- 组装输出（字段顺序对齐模板契约，便于人工阅读） ---
  return {
    groupName: group,
    issueNo,
    weekStart: weekWindow.weekStart,
    weekEnd: weekWindow.weekEnd,
    generatedAt,
    minCheckins,

    totalMembers,
    metCount,
    notMetCount: totalMembers - metCount,
    targetRate: pct(metCount),
    targetRateAngle: angle(pct(metCount)),

    checkinCount: checkinMemberCount,
    checkinPercent,
    checkinAngle,
    leaveCount: leaveMemberCount,
    leavePercent,
    leaveAngle,
    absentCount: absentMemberCount,
    absentPercent,
    absentAngle,

    redPacketTotal,
    redPacketTrendText,

    sportStats,
    hasOtherSports,
    otherSportCount,
    otherSportTotal,
    otherBarWidthPercent,

    checkinList,
    totalMinutesSum,
    totalCaloriesSum,
    totalSessions,
    avgMinutesPerSession,

    leaveList,

    redPacketTiers,
    totalPeople,

    insights: [], // AI 补写（固定 6 栏 + 条件栏 + 最多 2 条自由栏，共 6-9 条）后再渲染（render.mjs 契约校验）

    returnWelcome,

    memberStats: memberStatsOut,
  };
}

// ---------- CLI ----------

/** 解析命令行参数：records.json 路径 + 可选 --members/--week/--min-checkins/-o/--allow-missing-prev */
function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0].startsWith('-')) {
    console.error('用法: node calc.mjs <records.json> [--members members.json] [--week YYYY-MM-DD] [--min-checkins N] [-o data.json] [--allow-missing-prev]');
    process.exit(1);
  }
  const getOpt = (name) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : null;
  };
  return {
    recordsPath: resolve(args[0]),
    membersPathOpt: getOpt('--members'),
    week: getOpt('--week'),
    minCheckinsOpt: getOpt('--min-checkins'),
    outPath: getOpt('-o'),
    allowMissingPrev: args.includes('--allow-missing-prev'),
  };
}

/** 主流程 */
function main() {
  const { recordsPath, membersPathOpt, week, minCheckinsOpt, outPath, allowMissingPrev } = parseArgs(process.argv);

  // 1. 从磁盘重读 members.json（每期必读，禁止任何形式的缓存）
  //    默认与 records.json 同目录（工作区根目录），配置随工作区走；--members 可覆盖
  const workspaceDir = dirname(recordsPath);
  const defaultMembersPath = resolve(workspaceDir, 'members.json');
  const membersPath = membersPathOpt ? resolve(membersPathOpt) : defaultMembersPath;
  if (!existsSync(membersPath)) {
    console.error(`✗ 未找到 members.json：${membersPath}`);
    console.error(`  默认读取 records.json 同目录的 members.json（${defaultMembersPath}），也可用 --members 指定。`);
    if (existsSync(LEGACY_MEMBERS_PATH) && LEGACY_MEMBERS_PATH !== membersPath) {
      console.error(`  检测到旧版配置：${LEGACY_MEMBERS_PATH}`);
      console.error(`  请迁移到 ${defaultMembersPath}（新版本不再默认读取 skill 目录内配置）。`);
    } else {
      console.error('  首次使用请先按 SKILL.md 的「首次初始化 members.json」流程生成配置。');
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
    console.error('  常见原因：手工改配置时漏逗号/引号、括号不匹配、文件被写盘截断，或保存成了带 UTF-8 BOM 的编码。');
    console.error('  字段口径见 assets/members.sample.md；用编辑器以「UTF-8 无 BOM」重存或修好语法后重跑本命令。');
    process.exit(1);
  }

  // 1.5 特殊周期达标线覆盖（节假日等：--min-checkins N 临时覆盖 weekRule.minCheckins，
  //     buildStats 全部下游字段自动跟随；data.json 的 minCheckins 记录当期生效值）
  let minCheckinsOverride = null;
  if (minCheckinsOpt !== null) {
    minCheckinsOverride = Number(minCheckinsOpt);
    if (!Number.isInteger(minCheckinsOverride) || minCheckinsOverride < 1) {
      console.error(`✗ --min-checkins 格式错误：${minCheckinsOpt}（应为正整数）`);
      process.exit(1);
    }
    config.weekRule.minCheckins = minCheckinsOverride;
  }

  // 2. 周期与期号（--week 传任意日期；常规周归一到所在周一，锚点期取实际起止。默认今天，本地时区）
  let baseDate = new Date();
  if (week) {
    baseDate = parseLocalDate(week);
    if (!baseDate) {
      console.error(`✗ --week 不是有效日期：${week}（应为真实存在的日期，月日可不补零，如 2026-03-05 / 2026-3-5；写成 2026-02-30 这类会被 JS 静默滚成 03-02，期号与统计周随之整体偏移）`);
      process.exit(1);
    }
  }
  const [ay, am, ad] = config.periodConfig.anchorWeekStart.split('-').map(Number);
  const anchorStart = new Date(ay, am - 1, ad);
  if (baseDate < anchorStart) {
    console.error(`✗ 统计日期 ${fmtDate(baseDate)} 早于首期开始日 ${config.periodConfig.anchorWeekStart}，该周期尚未开始。`);
    console.error('  若首期从周内开始（如周三），anchorWeekStart 必须填实际开始日，不能填该周周一。');
    process.exit(1);
  }
  const { issueNo, ...weekWindow } = getIssueWindow(baseDate, config.periodConfig);
  if (issueNo < 1) {
    console.error(`✗ 期号 ${issueNo} < 1：统计周早于锚点（${config.periodConfig.anchorWeekStart} 起），请核对 --week 参数。`);
    process.exit(1);
  }

  // 3. 读取 records.json（AI 翻译产物）
  let raw;
  try {
    // 剥离 UTF-8 BOM（同上：Windows 编辑器默认可能写入 BOM）
    raw = JSON.parse(readFileSync(recordsPath, 'utf-8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error(`✗ records.json 解析失败：${recordsPath}`);
    console.error(`  原因：${e.message}`);
    console.error('  常见原因：JSON 结构不完整（漏逗号/括号）、写盘截断，或保存成了带 UTF-8 BOM 的编码。');
    console.error('  请按结构 { "weekStart": "YYYY-MM-DD", "records": [...], "leaves": [...] } 修正后重跑。');
    process.exit(1);
  }
  if (!Array.isArray(raw.records)) {
    console.error('✗ records.json 缺少 records 数组（结构：{ "weekStart": "YYYY-MM-DD", "records": [...], "leaves": [...] }）');
    process.exit(1);
  }
  if (typeof raw.weekStart === 'string') {
    const parsedWeekStart = parseLocalDate(raw.weekStart);
    if (!parsedWeekStart) {
      console.error(`✗ records.json 的 weekStart「${raw.weekStart}」不是有效日期（应为真实存在的日期，月日可不补零，且等于本期统计周 ${weekWindow.weekStart}）。`);
      process.exit(1);
    }
    if (fmtDate(parsedWeekStart) !== weekWindow.weekStart) {
      console.error(`✗ records.json 标注的统计周是 ${fmtDate(parsedWeekStart)}，本期应为 ${weekWindow.weekStart} ~ ${weekWindow.weekEnd}。`);
      console.error('  这通常说明用户只说「生成周报」但没有粘贴本周新接龙，脚本拒绝了上一期 records.json。');
      console.error('  请先重新翻译本周接龙，并把本期 weekStart 写进 records.json 后再跑 calc。');
      process.exit(1);
    }
  } else {
    console.warn(`⚠ records.json 缺少顶层 weekStart，无法确认它是否属于本期接龙；本期应为 ${weekWindow.weekStart}，请补写后重跑`);
  }
  const leaves = Array.isArray(raw.leaves) ? raw.leaves : [];
  if (raw.records.length === 0 && leaves.length === 0) {
    console.warn('⚠ records 与 leaves 均为空（全员缺席期），继续计算');
  }

  // 4. 上期归档（records.json 同级的 reports/ 目录）
  //    改名成员：归档里的旧昵称先按 aliases 归一到当前规范名，再参与趋势/累计/连击判定
  const reportsDir = resolve(dirname(recordsPath), 'reports');
  const nicknameIndex = buildNicknameIndex(config.members);
  const foundPrevReport = findPrevReport(reportsDir, issueNo, weekWindow.weekStart.slice(0, 4));
  const prevReport = foundPrevReport
    ? {
        ...foundPrevReport,
        leaveList: (foundPrevReport.leaveList || []).map((l) => ({
          ...l,
          nickname: canonicalName(l.nickname, nicknameIndex),
        })),
        cumulative: canonicalizeCumulative(foundPrevReport.cumulative, nicknameIndex),
      }
    : null;

  // 4.5 断链拦截：账本已存在却缺一环 → 交回用户决定，不静默按首期重算。
  //     链式累计（cumulative / 连击 / 里程碑 / 红包趋势）全靠上期归档续接；
  //     缺了会被当成首期：期数归 1、连击归 1、累计只剩本期，且这份错基线会写进本期归档继续往下传。
  //     reports/ 里一份归档都没有 = 本工作区首跑（锚点期号可能 > 1），只提示不拦。
  if (!prevReport && issueNo > 1) {
    const expectName = `${weekWindow.weekStart.slice(0, 4)}-issue${String(issueNo - 1).padStart(2, '0')}.json`;
    const expectPath = resolve(reportsDir, expectName);
    // 4.5.1 文件在却读不出来（findPrevReport 已 warn 过解析失败）→ 这是归档损坏，不是断链。
    //       不给 --allow-missing-prev 出口：那个 flag 的语义是「明示放弃历史」，
    //       拿它绕过坏文件等于把真实存在的账本当成不存在，累计/连击/里程碑照样清零。
    if (existsSync(expectPath)) {
      console.error(`✗ 上期归档不可用：${expectPath}`);
      console.error('  文件存在但读不出可用的上期：JSON 解析失败（写盘中途断掉 / 手工改坏 / 被截断），或文件内 issueNo 不是第 N-1 期。');
      console.error('  请修复该文件或从备份还原后重跑；不要用 --allow-missing-prev 绕过（那会把真实历史当成不存在，累计/连击/里程碑从本期全部重置）。');
      process.exit(1);
    }
    // 归档名口径：脚本只认 <年>-issue<NN>.json（期号至少两位）。单位号归档（2026-issue7.json）
    // 三个脚本都读不到，若这里当成「一份归档都没有」按首期起链，等于静默把真实账本清零——
    // preflight 会 ✗ 出来，但 calc 自己也得拦，不能只靠体检。
    const archiveLike = existsSync(reportsDir)
      ? readdirSync(reportsDir).filter((f) => /^\d{4}-issue\d+\.json$/.test(f))
      : [];
    const misnamed = archiveLike.filter((f) => !/^\d{4}-issue\d{2,}\.json$/.test(f));
    const hasLedger = archiveLike.length !== misnamed.length;
    if (!hasLedger && misnamed.length > 0) {
      const rename = misnamed
        .map((f) => `${f} → ${f.replace(/issue\d+\.json$/, (s) => `issue${String(Number(s.slice(5, -5))).padStart(2, '0')}.json`)}`)
        .join('、');
      console.error(`✗ reports/ 里的归档期号未补零，脚本认不出来：${misnamed.join('、')}`);
      console.error(`  归档名必须是 <年>-issue<NN>.json（期号至少两位），请改名后重跑：${rename}`);
      console.error(`  否则第 ${issueNo} 期会被当成首跑按首期起链，累计期数/连击/里程碑全部归零。`);
      process.exit(1);
    }
    if (!hasLedger) {
      console.warn(
        `⚠ reports/ 内还没有任何归档，第 ${issueNo} 期按首期起链（cumulative 从本期开始）——首跑属正常；若这里本该有历史归档，先确认目录没搬家。`
      );
    } else if (!allowMissingPrev) {
      console.error(`✗ 第 ${issueNo} 期找不到上期归档：${expectPath}`);
      console.error('  账本已有归档却缺这一环，按顺序确认（任一成立都要先修好再重跑，别让累计从本期断掉）：');
      console.error(`  ① ${expectName} 是否被写到了 reports/ 之外（render 显式 -o 指到别的目录时，归档跟着 HTML 走）→ 挪回 ${reportsDir}`);
      console.error('  ② 上一期周报是否根本没出 → 先补算上一期（--week 落在上期），再重跑本期');
      console.error('  ③ 确实要断链重来（归档迁移 / 换新账本）→ 加 --allow-missing-prev 明示，脚本不再拦');
      process.exit(1);
    }
  }

  // 5. 计算
  let data;
  try {
    data = buildStats({
      records: raw.records,
      leaves,
      config,
      weekWindow,
      issueNo,
      prevReport,
      generatedAt: fmtDateTime(new Date()),
    });
  } catch (e) {
    console.error(`✗ ${e.message}`);
    console.error('  未知昵称 → 与用户确认是否新成员（改 members.json 后重跑）；未知运动/单位 → 修正 records.json 后重跑；');
    console.error('  数量非法 → quantity 改成纯正数（不带单位、不用逗号小数点、不为 0/负数），回读接龙原文核对；');
    console.error('  次数标注非法 → ordinal 改成正整数 number（去掉引号）；接龙没写次数就整条省略，由脚本补号。');
    process.exit(1);
  }

  // 5.5 链式累计 cumulative + spotlight + metSnapshot（不动 buildStats 函数体）
  const memberStats = data.memberStats;
  const prevCumulative = prevReport?.cumulative || null;
  const cumulative = buildCumulative({ prevCumulative, memberStats, config, issueNo });
  const spotlights = computeSpotlights({ memberStats, prevCumulative });
  const metSnapshot = buildMetSnapshot(config);
  const milestoneCelebrations = computeMilestoneCelebrations({ cumulative, prevCumulative, config });

  // 给打卡名单每行附上 streak / spotlight / persona 主标签（模板直接消费）
  for (const item of data.checkinList) {
    const cum = cumulative.members[item.nickname];
    item.streak = cum.streak;
    item.streakCapsule = streakCapsule(cum.streak); // null 或 {streak,style,isLegendary}
    item.spotlight = spotlights[item.nickname] || null;
    const persona = computePersona({ sports: cum.sports, config });
    item.personaTag = primaryPersonaTag(persona);
    // personaClass：模板据此配色——专精与其强度档同色（high→burn / mid→balance / low→relax），
    // 无专精时取强度分型（燃烧系=burn / 均衡系=balance / 松弛系=relax），都无则 null
    const SPEC_CLASS = { high: 'burn', mid: 'balance', low: 'relax' };
    item.personaClass = persona.specializations.length > 0
      ? SPEC_CLASS[persona.specializations[0].intensity] || 'balance'
      : persona.intensityType === '燃烧系' ? 'burn'
      : persona.intensityType === '均衡系' ? 'balance'
      : persona.intensityType === '松弛系' ? 'relax'
      : null;
  }

  // 模块 06 激励卡片数据：消耗之星 / 燃效之星 / 进步之星（统一走 computeStars 单一真源，
  // tie-break 口径与 spotlight/蝉联一致；独立于 spotlight 优先级，永远报真实第一）
  const stars = computeStars({ memberStats, prevCumulative });

  // 消耗之星：本周卡路里总量第一
  data.calorieKing = stars.calorieKing ? { ...stars.calorieKing } : null;
  // 蝉联周数（≥3 周显示「蝉联 N 周」角标，与燃效之星对称）
  const calStreak = cumulative.group.calorieKingStreak;
  if (data.calorieKing && calStreak.nickname === data.calorieKing.nickname && calStreak.weeks >= 3) {
    data.calorieKing.streakWeeks = calStreak.weeks;
  }

  // 燃效之星：本周平均训练强度（avgMET，体重归一）第一；口径见 cumulative.computeStars
  data.efficiencyStar = stars.efficiencyStar
    ? {
        nickname: stars.efficiencyStar.nickname,
        avgMet: Math.round(stars.efficiencyStar.avgMet * 10) / 10,
      }
    : null;
  // 蝉联周数（≥3 周显示「蝉联 N 周」角标）
  const effStreak = cumulative.group.efficiencyStarStreak;
  if (data.efficiencyStar && effStreak.nickname === data.efficiencyStar.nickname && effStreak.weeks >= 3) {
    data.efficiencyStar.streakWeeks = effStreak.weeks;
  }

  // 进步之星：需 ≥4 期历史，相对个人前 3 周 kcal/min 均值正提升最大（并列取本周平均强度更高者）
  // 提升率基于 kcal/min（同一人体重约掉）；展示值统一换算成 MET，与燃效之星同单位
  data.progressStar = stars.progressStar
    ? {
        nickname: stars.progressStar.nickname,
        prevAvgMet: Math.round(stars.progressStar.prevAvgMet * 10) / 10,
        curMet: Math.round(stars.progressStar.curMet * 10) / 10,
        improvementPct: Math.round(stars.progressStar.improvement * 100),
      }
    : null;

  // 断更提示：上期达标 → 本期未达标（反馈结果，供 AI insights 取材，非预警）
  // wasTopStreak=断更者此前是否持有全群最长连击；newTop=本期结算后的最长连击持有者（竞技激将文案的事实依据）
  data.streakBreaks = computeStreakBreaks({ memberStats, prevCumulative, currentCumulative: cumulative });

  // 较上期增减：挂在本期「总分钟」数字后，只保留方向 + 数量（单位由列头交代）
  attachDeltaBadges(data.checkinList, prevCumulative);

  // 合并进 data（memberStats 是中间产物，不写入 data.json，避免 render 多余字段告警）
  data.cumulative = cumulative;
  data.metSnapshot = metSnapshot;
  data.spotlights = spotlights;
  data.milestoneCelebrations = milestoneCelebrations;
  delete data.memberStats;

  // 6. 写出 data.json（默认与 records.json 同目录）
  const finalOut = outPath ? resolve(outPath) : resolve(dirname(recordsPath), 'data.json');
  mkdirSync(dirname(finalOut), { recursive: true });
  writeFileSync(finalOut, JSON.stringify(data, null, 2) + '\n', 'utf-8');

  console.log(`✓ 计算完成：${finalOut}`);
  console.log(`  第 ${issueNo} 期 · ${weekWindow.weekStart} ~ ${weekWindow.weekEnd}`);
  console.log(`  成员 ${data.totalMembers} 人 · 打卡 ${data.checkinCount} · 请假 ${data.leaveCount} · 未打卡 ${data.absentCount}`);
  console.log(`  达标 ${data.metCount} 人（${data.targetRate}%）· 红包 ¥${data.redPacketTotal}`
    + (minCheckinsOverride !== null ? `（特殊达标线 ${minCheckinsOverride} 次/周，--min-checkins 覆盖）` : ''));
  if (prevReport) console.log(`  上期归档：第 ${prevReport.issueNo} 期（趋势对比已启用）`);
  else console.log('  无上期归档：按首期处理（趋势字段兜底）');
  console.log('  ⚠ insights 为空数组：需按 references/insight-writing.md §1 契约补写 6-9 条后再执行 render.mjs');
}

// 直接执行时运行 main；被测试 import 时不执行（纯函数导出供测试）
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
