import test from 'node:test';
import assert from 'node:assert/strict';
import { assignAngles, changeCandidates, driftOf, CHANGE_MIN, QUOTA_RATIO } from '../scripts/angle.mjs';

/** 构造一个人事实，默认值刻意设为「无变化证据 + 中等水平」 */
const base = (nickname, over = {}) => ({
  nickname,
  recentAvg: 100,
  recentBase: 4,
  activeWeeks: 10,
  weeklyAvg: 100,
  peakAge: null,
  peakCalories: 0,
  peakText: '—',
  recentLeave: null,
  recentAbsent: null,
  topSport: '跑步',
  top2Sport: '游泳10',
  top1: 0.4,
  kinds: 3,
  totalCheckins: 20,
  met: 5,
  total: 10,
  streak: 2,
  avg: 300,
  rank: 5,
  size: 10,
  leaveWeeks: 1,
  absentWeeks: 0,
  ...over,
});

const countTiers = (map) => {
  const c = { 变化: 0, 结构: 0, 水平: 0 };
  for (const v of map.values()) c[v.tier]++;
  return c;
};

test('变化档按证据类型轮转：峰值刷新不会被四个「近 4 期走高」挤掉', () => {
  const people = [
    base('A', { recentAvg: 150 }),
    base('B', { recentAvg: 140 }),
    base('C', { recentAvg: 130 }),
    base('D', { recentAvg: 125 }),
    base('E', { peakAge: 0, peakCalories: 900, peakText: '#10 900' }),
  ];
  const m = assignAngles(people); // quota = ceil(5×0.4) = 2
  assert.equal(m.get('E').tier, '变化', '峰值刷新应占一个名额');
  assert.equal(m.get('E').evidence, '峰值 #10 900 刷新');
  assert.equal(m.get('A').tier, '变化', '幅度最大的同时入选');
  // 若按纯分数排序，0.22 的峰值会被 0.4/0.3/0.25 全部压掉——轮转就是为了防这个
  assert.notEqual(m.get('B').tier, '变化');
});

test('每人只有一个角度，且覆盖率 100%（不会有人没有主论点）', () => {
  const people = Array.from({ length: 10 }, (_, i) => base(`P${i}`, { rank: i + 1 }));
  const m = assignAngles(people);
  assert.equal(m.size, 10);
  for (const v of m.values()) assert.ok(['变化', '结构', '水平'].includes(v.tier));
  assert.ok([...m.values()].every((v) => v.evidence && v.evidence !== '—'));
});

test('配额 = ceil(人数 × 0.4)：变化与结构各不超过 4 人，水平兜底不设上限', () => {
  const people = Array.from({ length: 10 }, (_, i) => base(`P${i}`, { recentAvg: 200 }));
  const m = assignAngles(people);
  const c = countTiers(m);
  assert.equal(c.变化, Math.ceil(10 * QUOTA_RATIO));
  assert.ok(c.结构 <= Math.ceil(10 * QUOTA_RATIO), '结构档不得超过配额');
  assert.equal(c.变化 + c.结构 + c.水平, 10, '水平是兜底档，必须覆盖剩余全部（不能按配额丢掉人）');
});

test('水平档兜底：多人基础证据相同时用不同维度的数字区分开', () => {
  // 6 人里 3 人进水平档，达标数一致、周均各不相同 → 证据不能重复
  const people = Array.from({ length: 6 }, (_, i) =>
    base(`P${i}`, { rank: 5, size: 6, met: 5, total: 17, avg: 300 + i * 10 })
  );
  const m = assignAngles(people);
  const evidences = [...m.values()].filter((v) => v.tier === '水平').map((v) => v.evidence);
  assert.ok(evidences.length > 1);
  assert.equal(new Set(evidences).size, evidences.length, `证据重复：${evidences.join(' / ')}`);
});

test('结构档集中 / 分散各占一半名额，避免四条都写「某项目独占」', () => {
  const people = [
    base('集中1', { top1: 0.7, totalCheckins: 30 }),
    base('集中2', { top1: 0.65, totalCheckins: 30 }),
    base('集中3', { top1: 0.6, totalCheckins: 30 }),
    base('分散1', { top1: 0.25, kinds: 6, totalCheckins: 30 }),
    base('分散2', { top1: 0.28, kinds: 6, totalCheckins: 30 }),
  ];
  const m = assignAngles(people); // quota = 2 → 集中 1 + 分散 1
  assert.equal(m.get('集中1').tier, '结构');
  assert.match(m.get('集中1').evidence, /独占70%/);
  assert.equal(m.get('分散1').tier, '结构');
  assert.match(m.get('分散1').evidence, /项目摊开6种/);
  assert.equal(m.get('集中2').tier, '水平', '同类第二个溢出去下一档');
});

test('累计打卡不足 6 次时不进结构档（集中度是噪声）', () => {
  const m = assignAngles([base('少', { totalCheckins: 3, top1: 0.9 })]);
  assert.equal(m.get('少').tier, '水平');
});

test('变化证据门槛：偏离不足 10% 不算变化；近 4 期已走高时峰值不再重复占名额', () => {
  assert.equal(changeCandidates(base('x', { recentAvg: 105 })).length, 0);
  // 峰值就落在近 4 期里 → 与「近 4 期走高」是同一个故事的两种说法，只报一次
  const c = changeCandidates(
    base('x', { recentAvg: 130, peakAge: 0, peakCalories: 900, peakText: '#17 900', total: 17 })
  );
  assert.equal(c.length, 1, '同一故事不该占两个变化名额');
  assert.equal(c[0].type, 'move');
  assert.ok(Math.abs(CHANGE_MIN - 0.1) < 1e-9);
});

test('水平档：末位写「垫底」、出勤满分写「零请假」', () => {
  // 结构名额先被「集中型」占掉，末位的人才会落到水平档
  const last = assignAngles([
    base('专', { top1: 0.8, totalCheckins: 30 }),
    base('末', { rank: 10, size: 10, met: 8, total: 10 }),
  ]);
  assert.equal(last.get('末').tier, '水平');
  assert.match(last.get('末').evidence, /垫底/);

  const solid = assignAngles([
    base('专', { top1: 0.8, totalCheckins: 30 }),
    base('稳', { rank: 8, size: 10, met: 15, total: 17, leaveWeeks: 0, absentWeeks: 0 }),
  ]);
  assert.equal(solid.get('稳').tier, '水平');
  assert.match(solid.get('稳').evidence, /累计第8\/10/);
  assert.match(solid.get('稳').evidence, /零请假满17期/);
});

test('确定性：同分时结果可复现，与输入顺序无关', () => {
  const a = base('甲', { recentAvg: 130 });
  const b = base('乙', { recentAvg: 130 });
  const m1 = assignAngles([a, b]); // quota = 1，同分按昵称裁决
  const m2 = assignAngles([b, a]);
  assert.equal([...m1.keys()].join(), [...m2.keys()].join());
  assert.equal(countTiers(m1).变化, 1);
});

test('空输入不崩，返回空 Map', () => {
  assert.equal(assignAngles([]).size, 0);
  assert.equal(assignAngles(null).size, 0);
});

test('近 4 期样本不足 / 历史太短 / 周均为 0 时不算「变化」', () => {
  // 近 4 期只有 1 期有打卡：单点的百分比全是噪声
  assert.equal(changeCandidates(base('x', { recentAvg: 500, recentBase: 1 })).length, 0);
  // 总共只打卡 4 期、全部落在近 4 期窗口内：近 4 期 ≈ 全程，等于自己跟自己比
  assert.equal(changeCandidates(base('x', { recentAvg: 500, activeWeeks: 4 })).length, 0);
  // 周均 0（从未打卡）不做除法
  assert.equal(changeCandidates(base('x', { recentAvg: 500, weeklyAvg: 0 })).length, 0);
});

test('driftOf 是「近 4 期 vs 全程周均」的单一真源', () => {
  // (120 ÷ 100) - 1 = +20%；口径换了这里必须一起变
  assert.ok(Math.abs(driftOf(base('x', { recentAvg: 120, weeklyAvg: 100 })) - 0.2) < 1e-9);
  assert.equal(driftOf(base('x', { recentBase: 1 })), 0);
});

test('首期归档（total=1）不把「峰值」当刷新：没有上期可比', () => {
  const c = changeCandidates(base('x', { peakAge: 0, peakCalories: 500, peakText: '#01 500', total: 1 }));
  assert.equal(c.length, 0);
  const c2 = changeCandidates(base('x', { peakAge: 0, peakCalories: 500, peakText: '#17 500', total: 17 }));
  assert.equal(c2[0].type, 'peak');
  // 峰值就是全史第一期（peakAge=1、total=2）时同样无「刷新」可言
  const c3 = changeCandidates(base('x', { peakAge: 1, peakCalories: 500, peakText: '#01 500', total: 2 }));
  assert.equal(c3.length, 0);
});

test('所有角度的证据文本都不以数字开头（便于嵌进 full 分号后那半句）', () => {
  const people = [
    base('A', { recentAvg: 150 }),
    base('B', { peakAge: 0, peakCalories: 900, peakText: '#10 900' }),
    base('C', { recentLeave: 16 }),
    base('D', { recentAbsent: 15 }),
    base('E', { top1: 0.7, totalCheckins: 30 }),
    base('F', { top1: 0.25, kinds: 6, totalCheckins: 30 }),
    base('G', { rank: 1, size: 10, met: 10, total: 10 }),
    base('H', { avg: 300 }),
  ];
  for (const v of assignAngles(people.slice(0, 4)).values()) {
    assert.ok(!/^[0-9０-９¥]/.test(v.evidence), `变化档证据以数字开头：${v.evidence}`);
  }
  for (const v of assignAngles(people).values()) {
    assert.ok(!/^[0-9０-９¥]/.test(v.evidence), `证据以数字开头：${v.evidence}`);
  }
});

test('水平档只剩「零请假」一条证据时也不以数字开头', () => {
  // 排名居中、达标非全勤、连击短、零请假 → levelEvidence 只产出零请假一项。
  // 证据要以名词短语起头，才能直接嵌进 full 分号后那半句。
  const target = base('目标', {
    top1: 0.5,
    totalCheckins: 20,
    rank: 5,
    size: 10,
    met: 12,
    total: 17,
    streak: 3,
    leaveWeeks: 0,
    absentWeeks: 0,
  });
  const people = [
    base('变化1', { recentAvg: 200 }),
    base('变化2', { recentAvg: 200 }),
    base('变化3', { recentAvg: 200 }),
    base('变化4', { recentAvg: 200 }),
    base('集中1', { top1: 0.9, totalCheckins: 30 }),
    base('集中2', { top1: 0.85, totalCheckins: 30 }),
    base('分散1', { top1: 0.1, kinds: 6, totalCheckins: 30 }),
    base('分散2', { top1: 0.15, kinds: 6, totalCheckins: 30 }),
    target,
    base('陪跑', { avg: 260 }),
  ];
  const m = assignAngles(people);
  const got = m.get('目标');
  assert.equal(got.tier, '水平', `目标人应被挤到水平档，实际 ${got.tier}`);
  assert.match(got.evidence, /零请假满17期/);
  assert.ok(!/^[0-9０-９¥]/.test(got.evidence), `证据以数字开头：${got.evidence}`);
});
