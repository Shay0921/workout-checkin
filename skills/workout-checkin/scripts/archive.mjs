#!/usr/bin/env node
/**
 * 运动打卡周报 · 归档扫描共享层（纯函数 + 只读文件）
 *
 * 两个消费者，同一套口径，不许各写一份：
 *   - calc.mjs     ：上期 cumulative 没有 presentWeeks 时扫一次，补在册基线
 *   - personal.mjs ：--digest 逐期序列；渲染路径仅在缺 presentWeeks 时兜底
 *
 * 职责：按逐期归档名单反推「个人在册期数」，供达标率分母使用。
 * 触发条件：cumulative 缺 presentWeeks 时扫一次；字段齐备时直接读链式累加值。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeName } from './nickname.mjs';

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
export function loadHistory(reportsDir) {
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

/**
 * 每人「在册期数」：该成员截至最后一期、**连续**被点名叫到的期数（打卡名单含 0 次未打卡者 / 请假名单）。
 *
 * 唯一用途 = 达标率分母。新成员入群那期起才出现在归档里，入群前的期数根本没有他——
 * 拿全群期数当分母会把「入群 2 期、2 期全达标」算成 2/4 = 50%，把满勤新人误判成半途摆烂。
 * 缺席（在册但没打卡）必须计入：那是他自己的缺口，不是「还没入群」。
 *
 * **断档要清零**：退群期间的期数不进分母，再回来从 1 重新计——这与 calc 的链式累加
 * （上期 cumulative 里没有他就从 1 起）必须完全一致，否则两条路径会算出不同的分母。
 *
 * 正常路径下这个值由 calc 写进 cumulative.presentWeeks 链式累加，本函数只在字段缺失时兜底。
 *
 * **兜底与链式等价的不变量**（改 calc 的名单时必须一起改这里）：
 * 「归档里点名叫到」= 「当期 members.json 的 active 名单」。calc 每期把**全部** active 成员
 * 写进归档——打卡、未达标、0 打卡缺席都进 checkinList，整周请假进 leaveList（事由缺省「请假」，
 * 永不为空），所以没露面的人依然带着名字被数到一次。若哪天 checkinList 改成只留有打卡的人，
 * 本函数会把缺席当成退群、把在册期数腰斩，达标率虚高且不会报错。
 *
 * @param {Array} issues loadHistory 结果（升序）
 * @param {Map<string,string>} nicknameIndex buildNicknameIndex(config.members) 结果（旧昵称归一到当前名）
 * @returns {Map<string, number>} 规范昵称 → 连续在册期数
 */
export function buildPresenceIndex(issues, nicknameIndex) {
  const counts = new Map();
  for (const it of issues) {
    const present = new Set(); // 同一期同一个人只算一次（改名后新旧名可能同现）
    for (const k of it.members.keys()) {
      const canon = nicknameIndex.get(normalizeName(k));
      if (canon) present.add(canon);
    }
    // 断档清零：上期在册、本期不在 → 之后回来从 1 重新计（对齐 calc 的链式语义）
    for (const canon of [...counts.keys()]) {
      if (!present.has(canon)) counts.delete(canon);
    }
    for (const canon of present) {
      counts.set(canon, (counts.get(canon) || 0) + 1);
    }
  }
  return counts;
}

/**
 * 解析某人的达标率分母（在册期数），并做两道兜底：
 *   1. 归档可见期数 < 累计快照期数（归档被删/损坏）→ 扫描值偏小，会把达标率抬高，回退全群期数；
 *   2. 扫描 0 期但累计里有 metWeeks → 归档缺档，同样回退全群期数；
 *   3. 任何情况下分母不小于分子 metWeeks，保证比率 ≤ 100%。
 * @returns {number} 在册期数
 */
export function resolvePresentWeeks({ nickname, presenceIndex, visibleIssueCount, expectedIssueCount, metWeeks = 0 }) {
  const scanned = visibleIssueCount < expectedIssueCount ? 0 : presenceIndex.get(nickname) || 0;
  const base = scanned > 0 ? scanned : expectedIssueCount;
  return Math.max(base, metWeeks);
}
