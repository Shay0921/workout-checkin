/**
 * 个人战报「主论点角度」判定（纯函数、零依赖）
 *
 * 为什么存在：写十个人的 full 时，若让 AI 自己横比数据决定「谁该写变化、谁该写结构」，
 * 本质是让 AI 做排序——既违反「计算归脚本」的铁律，也无法稳定（十人容易写成同一副面孔）。
 * 这里把分档与配额做成确定性算法，AI 只负责照分配的角度组织语言。
 *
 * 三档优先级（信息量递减）：变化 ＞ 结构 ＞ 水平
 *   变化：近 4 期单期均偏离全程周均 ≥10%（正负都算）、峰值近 2 期刷新、近 4 期请假复出、近 4 期断更
 *   结构：项目集中度——集中 / 分散 各占一半名额（否则四条全写「某项目占一半」）
 *   水平：累计排名端点、达标全勤、连击、零请假、周均
 *
 * 「变化」的判据是「近 4 期单期均 偏离 全程周均 ≥10%」：报告永远是「截至本期」的累计
 * （第 8 期看 1–8 期，第 17 期看 1–17 期），所以「变化」只能是「最近」偏离「走到今天的平均」，
 * 两端取自同一累计口径，不引入人为切段。
 *
 * 两个防同脸机制：
 *   ① 配额 = ceil(人数 × 0.4)，10 人 → 变化、结构各最多 4 人，溢出的降级到下一档；
 *      水平是末档兜底档，**不设上限**（否则证据不足时有人会没有角度）
 *   ② 变化档按「证据类型」轮转取人（每种最多轮 1 个），防止 4 人全是「近 4 期走高」
 *
 * 全部为确定性排序（同分依次比 |drift|、昵称），同一批数据必得同一结果。
 */

/** 「变化」的入档门槛：近 4 期与全程周均偏离低于 10% 视为波动 */
export const CHANGE_MIN = 0.1;

/**
 * 近 4 期相对全程周均的偏离度；不满足可比条件时返回 0（不算变化）。
 * 单一真源：变化幅度只有本函数一处公式，changeCandidates 与同分排序都调它。
 * 两个前提：① 近 4 期至少 2 期有打卡（1 个点是噪声）② 窗口外至少还有 2 期打卡
 * （否则近 4 期 ≈ 全程，等于自己跟自己比）。
 */
export function driftOf(p) {
  const { recentBase = 0, activeWeeks = 0, recentAvg = 0, weeklyAvg = 0 } = p;
  if (recentBase < 2 || activeWeeks - recentBase < 2 || weeklyAvg <= 0) return 0;
  return recentAvg / weeklyAvg - 1;
}
/** 配额比例：变化 / 结构两档最多 ceil(人数 × 该值) 人 */
export const QUOTA_RATIO = 0.4;
/** 变化档的证据类型，轮转顺序 */
const CHANGE_TYPES = ['move', 'peak', 'comeback', 'broke'];

const pct = (x) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`;

/**
 * 列出某人所有可用的变化证据（已按分值降序）
 * @returns {Array<{type:string, score:number, evidence:string}>}
 */
export function changeCandidates(p) {
  const list = [];
  const drift = driftOf(p);
  const driftFired = Math.abs(drift) >= CHANGE_MIN;
  if (driftFired) {
    list.push({
      type: 'move',
      score: Math.abs(drift),
      evidence: `近4期${p.recentAvg}(${p.recentBase}期)｜周均${p.weeklyAvg}（${pct(drift)}）`,
    });
  }
  // 峰值刷新与复出/断更是「最近发生的事」，用固定分，保证不被更小的幅度压掉
  // 「刷新」要求峰值前面还有期可比：首期归档、或峰值就是全史第一期时，无上期可刷新
  const peakIdx = p.peakAge === null ? -1 : (p.total ?? 0) - 1 - p.peakAge;
  // 近 4 期已经明显走高时，最近的峰值只是同一个故事的最强一格：再报一次「峰值刷新」
  // 会让两个变化名额讲同一件事，所以此时只留「近 4 期 vs 周均」
  if (!driftFired && p.peakAge !== null && p.peakAge <= 1 && peakIdx >= 1 && p.peakCalories > 0) {
    list.push({ type: 'peak', score: 0.22, evidence: `峰值 ${p.peakText} 刷新` });
  }
  if (p.recentLeave) {
    list.push({ type: 'comeback', score: 0.2, evidence: `第${p.recentLeave}期请假，现已复出` });
  }
  if (p.recentAbsent) {
    list.push({ type: 'broke', score: 0.25, evidence: `第${p.recentAbsent}期断更` });
  }
  return list.sort((a, b) => b.score - a.score);
}

/** 结构档：只对累计打卡 ≥6 次的人有效（次数太少时集中度是噪声） */
function structEvidence(p) {
  if (p.totalCheckins < 6 || !p.topSport) return null;
  const share = Math.round(p.top1 * 100);
  let evidence;
  if (p.top1 >= 0.55) evidence = `${p.topSport}独占${share}%`;
  else if (p.top1 >= 0.4) evidence = `${p.topSport}${share}% + ${p.top2Sport || '其余'}兜底`;
  // 证据写成名词短语（「项目摊开N种」而不是「N种项目」）：它会被 AI 直接嵌进
  // 「；{项目次数}次+…，{判断}」那个位置，以数字起头接不上前面的分号
  else evidence = `项目摊开${p.kinds}种，最大项仅${share}%`;
  return { score: p.top1, evidence };
}

/** 水平档：按「最极端的那个水平事实」写，中间人只能给周均 */
function levelEvidence(p) {
  const parts = [];
  let score = 0;
  const ratio = p.rank / p.size;
  if (p.rank === 1) {
    score = 1;
    parts.push(`累计第1/${p.size}`);
  } else if (p.rank === p.size) {
    score = 0.8;
    parts.push(`累计第${p.rank}/${p.size}垫底`);
  } else if (ratio <= 0.3) {
    score = 0.5;
    parts.push(`累计第${p.rank}/${p.size}`);
  } else if (ratio >= 0.8) {
    score = 0.4;
    parts.push(`累计第${p.rank}/${p.size}`);
  }
  if (p.total > 0 && p.met === p.total) {
    score = Math.max(score, 0.6);
    parts.push(`达标${p.met}/${p.total}全勤`);
  } else if (p.total > 0 && p.met / p.total <= 0.55) {
    score = Math.max(score, 0.35);
    parts.push(`达标${p.met}/${p.total}`);
  }
  if (p.streak >= 10) {
    score = Math.max(score, 0.55);
    parts.push(`连击${p.streak}`);
  }
  // 出勤满分但总量不高（或极高）是很好的切口：缺勤与产出不在同一维度
  // 措辞同上，写成「零请假满N期」而非「N期零请假」，便于直接接在判断句后面
  if (p.total >= 10 && p.leaveWeeks === 0 && p.absentWeeks === 0) {
    score = Math.max(score, 0.45);
    parts.push(`零请假满${p.total}期`);
  }
  if (parts.length === 0) parts.push(`周均${p.avg}`);
  return { score, evidence: parts.slice(0, 2).join('｜') };
}

/**
 * 为每人分配一个主论点角度
 * @param {Array} people 每人事实，见下方字段说明
 * @returns {Map<string, {tier:'变化'|'结构'|'水平', evidence:string}>}
 *
 * people[i] 需要的字段：
 *   nickname, recentAvg / recentBase（近 4 期均与参与平均的期数）, activeWeeks（全程有打卡期数）,
 *   weeklyAvg（全程周均 = 累计 ÷ 有打卡期数），
 *   peakAge（峰值距最后一期几期）, peakCalories, peakText,
 *   recentLeave / recentAbsent（近 4 期请假 / 断更的期号，无则 null）,
 *   topSport, top2Sport, top1（第一项目人次占比）, kinds, totalCheckins,
 *   met, total（达标期数 / 期数）, streak, avg（周均）, rank, size, leaveWeeks, absentWeeks
 */
export function assignAngles(people) {
  const out = new Map();
  if (!Array.isArray(people) || people.length === 0) return out;
  const quota = Math.max(1, Math.ceil(people.length * QUOTA_RATIO));
  let rest = [...people];

  // ① 变化档：每人取自己最强的一条证据，再按证据类型轮转取人
  const pool = rest
    .map((p) => {
      const cands = changeCandidates(p);
      return cands.length ? { p, best: cands[0] } : null;
    })
    .filter(Boolean);
  const byType = new Map();
  for (const x of pool) {
    if (!byType.has(x.best.type)) byType.set(x.best.type, []);
    byType.get(x.best.type).push(x);
  }
  for (const arr of byType.values()) {
    arr.sort(
      (a, b) =>
        b.best.score - a.best.score ||
        Math.abs(driftOf(b.p)) - Math.abs(driftOf(a.p)) ||
        (a.p.nickname < b.p.nickname ? -1 : 1)
    );
  }
  const picked = [];
  for (let round = 0; picked.length < quota; round++) {
    let added = false;
    for (const t of CHANGE_TYPES) {
      const arr = byType.get(t);
      if (!arr || !arr[round]) continue;
      picked.push(arr[round]);
      added = true;
      if (picked.length >= quota) break;
    }
    if (!added) break;
  }
  for (const x of picked) out.set(x.p.nickname, { tier: '变化', evidence: x.best.evidence });
  rest = rest.filter((p) => !out.has(p.nickname));

  // ② 结构档：集中 / 分散 各占一半配额——四条都写「某项目占一半」等于没分档
  const eligible = rest.filter((p) => structEvidence(p));
  const nConc = Math.ceil(quota / 2);
  const nSpread = quota - nConc;
  const concentrated = [...eligible].sort((a, b) => b.top1 - a.top1).slice(0, nConc);
  const pickedConc = new Set(concentrated.map((p) => p.nickname));
  const spread = [...eligible]
    .filter((p) => !pickedConc.has(p.nickname))
    .sort((a, b) => a.top1 - b.top1)
    .slice(0, nSpread);
  for (const p of [...concentrated, ...spread]) {
    out.set(p.nickname, { tier: '结构', evidence: structEvidence(p).evidence });
  }
  rest = rest.filter((p) => !out.has(p.nickname));

  // ③ 水平档：末档兜底（不设上限，否则会有人没有角度）。
  //    多人水平相近时基础证据会重复（「达标5/17」×N），按确定性顺序补一个不同维度的数字区分开。
  const restSorted = [...rest].sort((a, b) => a.rank - b.rank || (a.nickname < b.nickname ? -1 : 1));
  const seen = new Set();
  for (const p of restSorted) {
    const baseEv = levelEvidence(p).evidence;
    let evidence = baseEv;
    if (seen.has(evidence)) {
      for (const x of [`周均${p.avg}`, `连击${p.streak}`, `打卡${p.totalCheckins}次`]) {
        const cand = `${baseEv}｜${x}`;
        if (!seen.has(cand)) {
          evidence = cand;
          break;
        }
      }
    }
    seen.add(evidence);
    out.set(p.nickname, { tier: '水平', evidence });
  }

  return out;
}
