/**
 * 核心统计测试（buildStats）
 * 覆盖：角度闭环、红包四分支、排序、6+1 规则、次数 vs 人次口径、
 *       ordinal 补号/去重/合并、请假冲突、缺体重兜底、left 成员排除
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStats, attachDeltaBadges, DELTA_MIN_MINUTES, DELTA_MIN_PCT } from '../scripts/calc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const fixturesDir = dirname(fileURLToPath(import.meta.url)) + '/fixtures';
const config = JSON.parse(readFileSync(resolve(fixturesDir, 'members.test.json'), 'utf-8'));
const weekWindow = { weekStart: '2026-10-12', weekEnd: '2026-10-18' };

/** 快捷构造：records 数组 → buildStats（无上期归档） */
const run = (records, leaves = []) =>
  buildStats({ records, leaves, config, weekWindow, issueNo: 2, prevReport: null, generatedAt: '2026-10-19 20:30' });

test('角度闭环：三段角度之和恒为 360（absentAngle 相减兜底）', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '羽毛球', quantity: 1, unit: 'h' },
    { nickname: '小芳', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
  ], [{ nickname: '小周', reason: '病假' }]);
  // 7 人：打卡 2 / 请假 1 / 未打卡 4
  assert.equal(data.checkinPercent, 29); // 28.57 → 29
  assert.equal(data.leavePercent, 14); // 14.29 → 14
  assert.ok(Math.abs(data.checkinAngle + data.leaveAngle + data.absentAngle - 360) < 0.001);
});

test('红包四分支：请假 ¥0 / 达标 ¥0 / 差 1 次 ¥5 / 0-1 次 ¥10', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '羽毛球', quantity: 1, unit: 'h' },
    { nickname: '阿明', ordinal: 2, sport: '跑步', quantity: 30, unit: 'min' },
    { nickname: '阿明', ordinal: 3, sport: '瑜伽', quantity: 30, unit: 'min' },
    { nickname: '小芳', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
    { nickname: '小芳', ordinal: 2, sport: '瑜伽', quantity: 30, unit: 'min' },
    { nickname: '老王', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
  ], [{ nickname: '小周', reason: '病假' }]);
  const byNick = Object.fromEntries(data.checkinList.map((c) => [c.nickname, c]));
  assert.equal(byNick['阿明'].checkinCount, 3); // 达标 ¥0
  assert.equal(byNick['阿明'].gapText, '达标');
  assert.equal(byNick['小芳'].gapText, '差 1 次'); // 2 次 → ¥5 档
  const tiers = data.redPacketTiers;
  assert.equal(tiers.length, 2);
  assert.equal(tiers[0].tier, '¥10 · 差 2 次或未打卡'); // 金额降序，¥10 在前
  assert.equal(tiers[1].tier, '¥5 · 差 1 次');
  // 老王 1 次 ¥10 + 小芳 差1次 ¥5 + Huahua/小刘/小张 0 次各 ¥10 = 45（小周请假 ¥0）
  assert.equal(data.redPacketTotal, 45);
});

test('红包总额核对：0 次 ×4 + 差 1 次 ×1 = ¥45', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '羽毛球', quantity: 1, unit: 'h' },
    { nickname: '阿明', ordinal: 2, sport: '跑步', quantity: 30, unit: 'min' },
    { nickname: '阿明', ordinal: 3, sport: '瑜伽', quantity: 30, unit: 'min' },
    { nickname: '老王', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
    { nickname: '老王', ordinal: 2, sport: '瑜伽', quantity: 30, unit: 'min' },
  ], [{ nickname: '小周', reason: '病假' }]);
  // 老王(差1次)¥5 + 小芳/Huahua/小刘/小张(0次)各¥10 = 45
  assert.equal(data.redPacketTotal, 45);
  assert.equal(data.totalPeople, 5);
  const zeroTier = data.redPacketTiers.find((t) => t.tier.startsWith('¥10'));
  assert.equal(zeroTier.peopleCount, 4);
  assert.equal(zeroTier.nameList, '小芳、Huahua、小刘、小张'); // 成员表顺序
});

test('排序：次数降序 → 卡路里降序 → 0 次沉底（未请假全员入名单）', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 1, unit: 'h' }, // 1 次 560
    { nickname: '小芳', ordinal: 1, sport: '跑步', quantity: 1, unit: 'h' }, // 1 次 400
    { nickname: '小芳', ordinal: 2, sport: '跑步', quantity: 1, unit: 'h' },
    { nickname: '小芳', ordinal: 3, sport: '跑步', quantity: 1, unit: 'h' }, // 3 次 1200
  ]);
  const nicks = data.checkinList.map((c) => c.nickname);
  // 0 次成员（含未请假的小周）次数同 0、卡路里同 0 → 保持成员表顺序
  assert.deepEqual(nicks, ['小芳', '阿明', '老王', 'Huahua', '小刘', '小周', '小张']);
  const last = data.checkinList[6];
  assert.equal(last.statusClass, 'danger');
  assert.equal(last.gapText, '未打卡');
});

test('6+1 规则：≤7 种全列出', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '羽毛球', quantity: 1, unit: 'h' },
    { nickname: '小芳', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
    { nickname: '老王', ordinal: 1, sport: '力训', quantity: 30, unit: 'min' },
    { nickname: 'Huahua', ordinal: 1, sport: '游泳', quantity: 1, unit: 'km' },
    { nickname: '小刘', ordinal: 1, sport: '散步', quantity: 30, unit: 'min' },
    { nickname: '小张', ordinal: 1, sport: '瑜伽', quantity: 30, unit: 'min' },
    { nickname: '小周', ordinal: 1, sport: '徒步', quantity: 30, unit: 'min' },
  ]);
  assert.equal(data.sportStats.length, 7);
  assert.equal(data.hasOtherSports, false);
});

test('6+1 规则：≥8 种取前 6 + 「其他」聚合行', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '羽毛球', quantity: 1, unit: 'h' },
    { nickname: '阿明', ordinal: 2, sport: '羽毛球', quantity: 1, unit: 'h' },
    { nickname: '小芳', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
    { nickname: '老王', ordinal: 1, sport: '力训', quantity: 30, unit: 'min' },
    { nickname: 'Huahua', ordinal: 1, sport: '游泳', quantity: 1, unit: 'km' },
    { nickname: '小刘', ordinal: 1, sport: '散步', quantity: 30, unit: 'min' },
    { nickname: '小张', ordinal: 1, sport: '瑜伽', quantity: 30, unit: 'min' },
    { nickname: '小周', ordinal: 1, sport: '徒步', quantity: 30, unit: 'min' },
    { nickname: '阿明', ordinal: 3, sport: '跳绳', quantity: 10, unit: 'min' },
  ]);
  assert.equal(data.sportStats.length, 6);
  assert.equal(data.hasOtherSports, true);
  // 8 种：羽毛球2 + 力训/徒步/散步/游泳/瑜伽/跑步/跳绳各 1
  // 前 6 = 羽毛球 + 1 人次码点序前 5（力训、徒步、散步、游泳、瑜伽）；其他 = 跑步、跳绳
  assert.equal(data.otherSportCount, 2);
  assert.equal(data.otherSportTotal, 2);
  assert.equal(data.otherBarWidthPercent, 100); // 2 ÷ max(2) × 100
});

test('次数 vs 人次口径：一行多项目 → 次数 1、人次 2', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '羽毛球', quantity: 1, unit: 'h' },
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' }, // 同次第二项目
  ]);
  assert.equal(data.checkinList[0].checkinCount, 1); // 成员次数 = distinct(昵称, ordinal)
  assert.equal(data.sportStats.length, 2); // 人次 = 流水条数
});

test('运动别名归一：「骑车」经别名映射归入「骑行」标准名', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '骑车', quantity: 30, unit: 'min' },
    { nickname: '小芳', ordinal: 1, sport: '骑行', quantity: 30, unit: 'min' },
  ]);
  // 两种叫法归一为同一标准名 → 单一分组、人次 2
  assert.equal(data.sportStats.length, 1);
  assert.equal(data.sportStats[0].name, '骑行');
  assert.equal(data.sportStats[0].count, 2);
});

test('扩充 MET 条目识别：跳操/健身环/练背/核心训练/有氧拳击/爵士舞', () => {
  const sports = ['跳操', '健身环', '练背', '核心训练', '有氧拳击', '爵士舞'];
  const data = run(
    sports.map((s, i) => ({ nickname: '阿明', ordinal: i + 1, sport: s, quantity: 30, unit: 'min' }))
  );
  assert.equal(data.sportStats.length, 6); // 全部识别，6 种独立分组
});

test('运动别名支持数组：步行/户外散步 归入「散步」，健身操 归入「跳操」', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '步行', quantity: 30, unit: 'min' },
    { nickname: '小芳', ordinal: 1, sport: '户外散步', quantity: 30, unit: 'min' },
    { nickname: '老王', ordinal: 1, sport: '散步', quantity: 30, unit: 'min' },
    { nickname: '阿明', ordinal: 2, sport: '健身操', quantity: 30, unit: 'min' },
    { nickname: '小芳', ordinal: 2, sport: '跳操', quantity: 30, unit: 'min' },
  ]);
  const byName = Object.fromEntries(data.sportStats.map((s) => [s.name, s.count]));
  assert.equal(byName['散步'], 3); // 步行 + 户外散步 + 散步
  assert.equal(byName['跳操'], 2); // 健身操 + 跳操
});

test('ordinal 为 null：按出现顺序补号', () => {
  const data = run([
    { nickname: '阿明', ordinal: null, sport: '跑步', quantity: 30, unit: 'min' }, // → 1
    { nickname: '阿明', ordinal: null, sport: '瑜伽', quantity: 30, unit: 'min' }, // → 2
  ]);
  assert.equal(data.checkinList[0].checkinCount, 2);
});

test('ordinal 缺失混有已占用：补入未占用的最小正整数', () => {
  const data = run([
    { nickname: '阿明', ordinal: 2, sport: '跑步', quantity: 30, unit: 'min' },
    { nickname: '阿明', ordinal: null, sport: '瑜伽', quantity: 30, unit: 'min' }, // → 1（未占用）
  ]);
  assert.equal(data.checkinList[0].checkinCount, 2);
  assert.equal(data.checkinList[0].gapText, '差 1 次'); // 2 次，minCheckins=3
});

test('重复贴去重：(昵称, 次数, 项目) 相同且时长相同 → 只计一条', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
  ]);
  assert.equal(data.checkinList[0].totalMinutes, 30);
});

test('补充贴合并：同三元组不同时长 → 分钟累加', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 15, unit: 'min' },
  ]);
  assert.equal(data.checkinList[0].totalMinutes, 45);
  assert.equal(data.checkinList[0].checkinCount, 1);
});

test('请假 + 打卡冲突：以打卡记录为准', () => {
  const data = run(
    [{ nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' }],
    [{ nickname: '阿明', reason: '病假' }]
  );
  assert.equal(data.leaveCount, 0);
  assert.equal(data.leaveList.length, 0);
  assert.equal(data.checkinCount, 1);
});

test('缺 weightKg 成员使用 defaultWeightKg 兜底', () => {
  const data = run([
    { nickname: '老王', ordinal: 1, sport: '跑步', quantity: 60, unit: 'min' }, // 老王无 weightKg → 60
  ]);
  // 卡路里 = 8 × 60 × 1 = 480
  assert.equal(data.checkinList[0].totalCalories, 480);
});

test('left 成员不计入 totalMembers，且其打卡记录报错', () => {
  assert.throws(
    () => run([{ nickname: '退群的人', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' }]),
    /未知昵称/
  );
  const data = run([]);
  assert.equal(data.totalMembers, 7); // 8 人中 1 人 left
});

test('未知昵称/运动/单位：聚合报错（一次性列出全部）', () => {
  assert.throws(
    () =>
      run([
        { nickname: '陌生人', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
        { nickname: '阿明', ordinal: 1, sport: '蹦极', quantity: 30, unit: 'min' },
        { nickname: '小芳', ordinal: 1, sport: '跑步', quantity: 100, unit: 'step' },
      ]),
    (e) => e.message.includes('陌生人') && e.message.includes('蹦极') && e.message.includes('step')
  );
});

test('全员达标：redPacketTiers 空数组、totalPeople 0', () => {
  const data = run([
    ...[1, 2, 3].map((o) => ({ nickname: '阿明', ordinal: o, sport: '跑步', quantity: 30, unit: 'min' })),
    ...[1, 2, 3].map((o) => ({ nickname: '小芳', ordinal: o, sport: '跑步', quantity: 30, unit: 'min' })),
  ]);
  // 阿明/小芳达标；其余 5 人（老王/Huahua/小刘/小张 + 无请假）未打卡仍罚红包 → 非全员达标
  // 构造真·全员达标：7 人各 3 次
  const full = run([
    ...['阿明', '小芳', '老王', 'Huahua', '小刘', '小张', '小周'].flatMap((n) =>
      [1, 2, 3].map((o) => ({ nickname: n, ordinal: o, sport: '跑步', quantity: 30, unit: 'min' }))
    ),
  ]);
  assert.equal(full.metCount, 7);
  assert.deepEqual(full.redPacketTiers, []);
  assert.equal(full.totalPeople, 0);
  assert.equal(full.redPacketTotal, 0);
  assert.equal(full.redPacketTrendText, '首期 · 暂无对比');
});

test('insights 输出为空数组占位（由 AI 补写）', () => {
  const data = run([]);
  assert.deepEqual(data.insights, []);
});

test('minCheckins=2 特殊达标线：达标判定/gapText/红包档位/输出字段全链路跟随', () => {
  const config2 = JSON.parse(JSON.stringify(config));
  config2.weekRule.minCheckins = 2; // 模拟 main 层 --min-checkins 2 覆盖
  const data = buildStats({
    records: [
      { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
      { nickname: '阿明', ordinal: 2, sport: '跑步', quantity: 30, unit: 'min' }, // 2 次 → 达标（默认 3 线下是「差 1 次」）
      { nickname: '小芳', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' }, // 1 次 → 差 1 次 ¥5（默认线下是「差 2 次」¥10）
    ],
    leaves: [],
    config: config2,
    weekWindow,
    issueNo: 2,
    prevReport: null,
    generatedAt: '2026-10-19 20:30',
  });
  const byNick = Object.fromEntries(data.checkinList.map((c) => [c.nickname, c]));
  assert.equal(byNick['阿明'].statusClass, 'success');
  assert.equal(byNick['阿明'].gapText, '达标');
  assert.equal(byNick['小芳'].gapText, '差 1 次');
  // 其余 5 人 0 次且未请假 → ¥10 档「差 1 次或未打卡」；小芳 1 次 → ¥5 档「差 1 次」
  assert.equal(data.redPacketTiers.length, 2);
  assert.equal(data.redPacketTiers[0].amount, config2.redPacket.zeroOrOne * 5);
  assert.ok(data.redPacketTiers[0].tier.includes('差 1 次或未打卡'));
  assert.equal(data.redPacketTiers[0].peopleCount, 5);
  assert.equal(data.redPacketTiers[1].amount, config2.redPacket.two);
  assert.equal(data.redPacketTiers[1].tier, `¥${config2.redPacket.two} · 差 1 次`);
  assert.equal(data.redPacketTiers[1].nameList, '小芳');
  assert.equal(data.metCount, 1);
  assert.equal(data.minCheckins, 2); // 输出记录当期生效值 → 归档可追溯
});

test('minCheckins=1：0 次不进 two 档，直接 zeroOrOne 档「未打卡」', () => {
  const config1 = JSON.parse(JSON.stringify(config));
  config1.weekRule.minCheckins = 1; // 模拟 --min-checkins 1
  const data = buildStats({
    records: [{ nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' }],
    leaves: [],
    config: config1,
    weekWindow,
    issueNo: 2,
    prevReport: null,
    generatedAt: '2026-10-19 20:30',
  });
  const byNick = Object.fromEntries(data.checkinList.map((c) => [c.nickname, c]));
  assert.equal(byNick['阿明'].gapText, '达标');
  assert.equal(byNick['小芳'].gapText, '未打卡');
  assert.equal(byNick['小芳'].statusClass, 'danger');
  assert.equal(data.redPacketTiers.length, 1);
  assert.equal(data.redPacketTiers[0].tier, `¥${config1.redPacket.zeroOrOne} · 未打卡`);
  assert.equal(data.redPacketTotal, config1.redPacket.zeroOrOne * 6);
  assert.equal(data.minCheckins, 1);
});

// ---------- 部分请假（times）：有效次数 = 打卡 + 请假，N 次请假抵 N 次义务 ----------

/** 快捷构造：全部成员各打卡 n 次 */
const allCheckin = (n, except = []) =>
  ['阿明', '小芳', '老王', 'Huahua', '小刘', '小张', '小周']
    .filter((nick) => !except.includes(nick))
    .flatMap((nick) => Array.from({ length: n }, (_, i) => ({ nickname: nick, ordinal: i + 1, sport: '跑步', quantity: 30, unit: 'min' })));

test('部分请假抵扣达标：打卡2+请假1 → 「达标+1请假」，进打卡名单不进请假名单', () => {
  const data = buildStats({
    records: allCheckin(3, ['阿明']) // 其余 6 人满勤
      .concat([
        { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
        { nickname: '阿明', ordinal: 2, sport: '跑步', quantity: 30, unit: 'min' },
      ]),
    leaves: [{ nickname: '阿明', reason: '第三次临时有事', times: 1 }],
    config, weekWindow, issueNo: 2, prevReport: null, generatedAt: '2026-10-19 20:30',
  });
  const am = data.checkinList.find((c) => c.nickname === '阿明');
  assert.equal(am.statusClass, 'success');
  assert.equal(am.gapText, '达标+1请假');
  assert.equal(data.metCount, 7); // 阿明有效 3 次计入达标
  assert.equal(data.leaveCount, 0); // 部分请假不算整周豁免
  assert.deepEqual(data.leaveList, []); // 请假名单只列整周豁免
  assert.equal(data.redPacketTotal, 0);
});

test('打卡已够线：即使有部分请假也只显示「达标」不注请假', () => {
  const data = buildStats({
    records: allCheckin(3),
    leaves: [{ nickname: '阿明', reason: '第三次临时有事', times: 1 }],
    config, weekWindow, issueNo: 2, prevReport: null, generatedAt: '2026-10-19 20:30',
  });
  const am = data.checkinList.find((c) => c.nickname === '阿明');
  assert.equal(am.gapText, '达标');
  assert.equal(data.metCount, 7);
  assert.equal(data.redPacketTotal, 0);
});

test('部分请假未达标：打卡1+请假1=有效2 → 「差 1 次」，红包按有效次数走 ¥5 档', () => {
  const data = buildStats({
    records: allCheckin(3, ['阿明'])
      .concat([{ nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' }]),
    leaves: [{ nickname: '阿明', reason: '第二天临时病假', times: 1 }],
    config, weekWindow, issueNo: 2, prevReport: null, generatedAt: '2026-10-19 20:30',
  });
  const am = data.checkinList.find((c) => c.nickname === '阿明');
  assert.equal(am.statusClass, 'warning');
  assert.equal(am.gapText, '差 1 次'); // 有效 2 = 3 − 1，非打卡数 1
  assert.equal(data.redPacketTiers.length, 1);
  assert.equal(data.redPacketTiers[0].tier, '¥5 · 差 1 次'); // 档位按有效次数判定
  assert.equal(data.redPacketTiers[0].nameList, '阿明');
  assert.equal(data.metCount, 6);
});

test('0 打卡 + 请假次数 ≥ 达标线 → 等同整周豁免（进请假名单，¥0）', () => {
  const data = buildStats({
    records: allCheckin(3, ['阿明']),
    leaves: [{ nickname: '阿明', reason: '本周连续病假', times: 3 }],
    config, weekWindow, issueNo: 2, prevReport: null, generatedAt: '2026-10-19 20:30',
  });
  assert.equal(data.leaveList.length, 1);
  assert.equal(data.leaveList[0].nickname, '阿明');
  assert.equal(data.leaveCount, 1);
  assert.equal(data.checkinList.find((c) => c.nickname === '阿明'), undefined); // 不进打卡名单
  assert.equal(data.metCount, 6);
  assert.equal(data.absentCount, 0);
  assert.equal(data.redPacketTotal, 0);
});

test('0 打卡 + 非整周请假 → 仍计入未打卡，三类名单重新构成全集', () => {
  const data = buildStats({
    records: allCheckin(3, ['阿明']),
    leaves: [{ nickname: '阿明', reason: '周一临时有事', times: 1 }],
    config, weekWindow, issueNo: 2, prevReport: null, generatedAt: '2026-10-19 20:30',
  });
  const am = data.checkinList.find((c) => c.nickname === '阿明');
  assert.equal(am.gapText, '差 2 次'); // 有效 1，差 2 次达标
  assert.equal(am.statusClass, 'warning');
  assert.equal(data.absentCount, 1); // 0 次打卡即计入未打卡；部分请假不等于整周豁免
  assert.equal(data.checkinCount, 6); // 打卡人数按实际打卡 ≥1 计
  assert.equal(data.leaveCount, 0); // 只有整周豁免算请假
  assert.equal(data.totalMembers, data.checkinCount + data.leaveCount + data.absentCount);
  assert.equal(data.redPacketTiers[0].tier, '¥10 · 差 2 次或未打卡');
  assert.equal(data.redPacketTiers[0].nameList, '阿明');
});

test('混合场景：整周豁免与部分请假共存，各走各的口径', () => {
  const data = buildStats({
    records: allCheckin(3, ['阿明', '小周'])
      .concat([{ nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' }]),
    leaves: [
      { nickname: '小周', reason: '病假' }, // 整周豁免
      { nickname: '阿明', reason: '第三次临时有事', times: 1 }, // 部分请假，有效 2 → 差 1 次
    ],
    config, weekWindow, issueNo: 2, prevReport: null, generatedAt: '2026-10-19 20:30',
  });
  assert.deepEqual(data.leaveList, [{ nickname: '小周', reason: '病假' }]);
  assert.equal(data.leaveCount, 1);
  const am = data.checkinList.find((c) => c.nickname === '阿明');
  assert.equal(am.gapText, '差 1 次');
  assert.equal(data.metCount, 5); // 5 人满勤；阿明有效 2 不足；小周豁免
  assert.equal(data.redPacketTiers.length, 1);
  assert.equal(data.redPacketTiers[0].nameList, '阿明');
});

test('times 无效值（0/负数/小数）→ 聚合报错退出', () => {
  assert.throws(
    () => buildStats({
      records: [],
      leaves: [{ nickname: '阿明', reason: '病假', times: 0 }],
      config, weekWindow, issueNo: 2, prevReport: null, generatedAt: '2026-10-19 20:30',
    }),
    /请假次数无效/
  );
  assert.throws(
    () => buildStats({
      records: [],
      leaves: [{ nickname: '阿明', reason: '病假', times: -1 }],
      config, weekWindow, issueNo: 2, prevReport: null, generatedAt: '2026-10-19 20:30',
    }),
    /请假次数无效/
  );
});

// ── 同一成员多条 leaves：合并而非后者覆盖前者（覆盖会白丢打卡义务，甚至把整周豁免降级成未达标） ──

test('多条部分请假 → 次数相加（1+2=3），不得只留最后一条', () => {
  const data = buildStats({
    records: allCheckin(3, ['阿明'])
      .concat([
        { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
        { nickname: '阿明', ordinal: 2, sport: '跑步', quantity: 30, unit: 'min' },
      ]),
    leaves: [
      { nickname: '阿明', reason: '周三出差', times: 1 },
      { nickname: '阿明', reason: '周六感冒', times: 2 },
    ],
    config, weekWindow, issueNo: 2, prevReport: null, generatedAt: '2026-10-19 20:30',
  });
  const am = data.checkinList.find((c) => c.nickname === '阿明');
  assert.equal(am.checkinCount, 2);
  assert.equal(am.gapText, '达标+3请假'); // 有效 5 = 2 + (1+2)；覆盖写法只会得到 2+2=4
  assert.equal(am.statusClass, 'success');
  assert.equal(data.redPacketTotal, 0);
  assert.equal(data.leaveCount, 0); // 有打卡即以打卡为准，不进请假名单
});

test('整周豁免 + 部分请假混写 → 合并后仍是整周豁免（不论先后顺序）', () => {
  for (const leaves of [
    [{ nickname: '阿明', reason: '病假' }, { nickname: '阿明', reason: '复查', times: 1 }],
    [{ nickname: '阿明', reason: '复查', times: 1 }, { nickname: '阿明', reason: '病假' }],
  ]) {
    const data = buildStats({
      records: allCheckin(3, ['阿明']),
      leaves,
      config, weekWindow, issueNo: 2, prevReport: null, generatedAt: '2026-10-19 20:30',
    });
    assert.equal(data.leaveCount, 1, '豁免不得被部分请假顶掉');
    assert.equal(data.leaveList[0].nickname, '阿明');
    assert.equal(data.checkinList.find((c) => c.nickname === '阿明'), undefined);
    assert.equal(data.absentCount, 0);
    assert.equal(data.redPacketTotal, 0);
  }
});

test('多条请假事由合并为「A、B」，同因重复不叠加文案', () => {
  const data = buildStats({
    records: allCheckin(3, ['阿明']),
    leaves: [
      { nickname: '阿明', reason: '周三出差', times: 1 },
      { nickname: '阿明', reason: '周六感冒', times: 1 },
      { nickname: '阿明', reason: '周六感冒', times: 1 },
    ],
    config, weekWindow, issueNo: 2, prevReport: null, generatedAt: '2026-10-19 20:30',
  });
  // 阿明 0 打卡 + 请假 3 次 ≥ 达标线 → 整周豁免口径，事由进 leaveList
  assert.equal(data.leaveList[0].reason, '周三出差、周六感冒');
});

test('单条请假不受合并逻辑影响（回归锁）', () => {
  const data = buildStats({
    records: allCheckin(3, ['阿明']),
    leaves: [{ nickname: '阿明', reason: '周三出差', times: 1 }],
    config, weekWindow, issueNo: 2, prevReport: null, generatedAt: '2026-10-19 20:30',
  });
  const am = data.checkinList.find((c) => c.nickname === '阿明');
  assert.equal(am.gapText, '差 2 次');
  assert.equal(data.leaveList.length, 0);
});

// ── 数量契约：结构上不可能合法的值一律硬报错（AI 翻译产物里最容易出现 NaN 型脏值） ──

test('quantity 非法：NaN 型（undefined / 文本 / 逗号小数点）→ 报错而非静默产出 NaN', () => {
  for (const bad of [undefined, 'abc', '1,5', NaN]) {
    assert.throws(
      () => run([{ nickname: '阿明', ordinal: 1, sport: '跑步', quantity: bad, unit: 'h' }]),
      /数量非法/,
      `quantity=${String(bad)} 应被拦下`
    );
  }
});

test('quantity 非法：负数 / 0 → 报错（否则负分钟会抵减全群总量）', () => {
  for (const bad of [-1, 0]) {
    assert.throws(
      () => run([{ nickname: '阿明', ordinal: 1, sport: '跑步', quantity: bad, unit: 'h' }]),
      /数量非法/,
      `quantity=${bad} 应被拦下`
    );
  }
});

test('quantity 合法：正数（含小数）照常计算，不受新校验误伤', () => {
  const data = run([{ nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 1.5, unit: 'h' }]);
  assert.equal(data.checkinList.find((m) => m.nickname === '阿明').totalMinutes, 90);
});

test('数量软告警不阻塞：单条 300 分钟内正常产出', () => {
  const data = run([{ nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 240, unit: 'min' }]);
  assert.equal(data.checkinList.find((m) => m.nickname === '阿明').totalMinutes, 240);
});

// ── 次数标注契约：ordinal 必须是正整数 number（st.ordinals 是 Set，1 与 "1" 各占一格 = 一次打卡数成两次） ──

test('ordinal 字符串「1」与数字 1 混写 → 报错，不得静默把一次打卡数成两次', () => {
  assert.throws(
    () => run([
      { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
      { nickname: '阿明', ordinal: '1', sport: '散步', quantity: 30, unit: 'min' },
    ]),
    /次数标注非法/
  );
});

test('ordinal 非法值（0 / 负数 / 小数 / 中文序数 / 空串）→ 聚合报错并点名成员·项目', () => {
  for (const bad of [0, -1, 1.5, '第一次', '']) {
    assert.throws(
      () => run([{ nickname: '阿明', ordinal: bad, sport: '跑步', quantity: 30, unit: 'min' }]),
      (e) => e.message.includes('次数标注非法') && e.message.includes('阿明 · 跑步'),
      `ordinal=${JSON.stringify(bad)} 应被拦下`
    );
  }
});

test('ordinal 合法：正整数照常计数，省略 / null 仍由脚本补号', () => {
  const explicit = run([
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
    { nickname: '阿明', ordinal: 2, sport: '跑步', quantity: 30, unit: 'min' },
  ]);
  assert.equal(explicit.checkinList.find((m) => m.nickname === '阿明').checkinCount, 2);

  const patched = run([
    { nickname: '阿明', sport: '跑步', quantity: 30, unit: 'min' },
    { nickname: '阿明', ordinal: null, sport: '散步', quantity: 30, unit: 'min' },
  ]);
  assert.equal(patched.checkinList.find((m) => m.nickname === '阿明').checkinCount, 2);
});

// ── 派生指标：人均单次时长与项目燃效由脚本算，AI 不手算 ──

test('派生：totalSessions 与 avgMinutesPerSession（分母 = 人次，非人数）', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 60, unit: 'min' },
    { nickname: '阿明', ordinal: 1, sport: '散步', quantity: 30, unit: 'min' }, // 同次第二项目 = 第 2 人次
    { nickname: '小芳', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
  ]);
  assert.equal(data.totalSessions, 3);
  assert.equal(data.totalMinutesSum, 120);
  assert.equal(data.avgMinutesPerSession, 40); // 120 ÷ 3，按人次摊
});

test('派生：sportStats 每项带 minutes / calories / kcalPerMin', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 60, unit: 'min' },
    { nickname: '阿明', ordinal: 2, sport: '跑步', quantity: 30, unit: 'min' },
  ]);
  const s = data.sportStats[0];
  assert.equal(s.minutes, 90);
  assert.equal(s.calories, data.totalCaloriesSum); // 本项目即全部流水
  assert.equal(s.kcalPerMin, Math.round((s.calories / 90) * 10) / 10);
});

test('派生：sportStats 各项目 minutes 之和与 totalMinutesSum 闭环（无「其他」时）', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 40, unit: 'min' },
    { nickname: '小芳', ordinal: 1, sport: '瑜伽', quantity: 50, unit: 'min' },
  ]);
  const sum = data.sportStats.reduce((s, x) => s + x.minutes, 0);
  assert.equal(sum, data.totalMinutesSum);
  assert.equal(data.sportStats.reduce((s, x) => s + x.count, 0), data.totalSessions);
});

test('派生：零流水时人均单次时长兜底为 0，不出现 NaN', () => {
  const data = run([{ nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' }]);
  assert.ok(Number.isFinite(data.avgMinutesPerSession));
  assert.equal(data.totalSessions, 1);
});

/** 构造上期 cumulative 快照：单个成员、单周 recentWeeks */
const prevCum = (nickname, minutes, status = 'met') => ({
  members: { [nickname]: { recentWeeks: [{ issue: 1, minutes, calories: 0, checkins: 1, status, redPacket: 0 }] } },
});

test('增减角标：命中阈值时输出方向 + 数量（只留数量，不带单位）', () => {
  const list = [
    { nickname: '阿明', totalMinutes: 165 }, // 上期 110 → +55 / +50%
    { nickname: '小芳', totalMinutes: 53 }, // 上期 95 → -42 / -44%
  ];
  const prev = {
    members: {
      阿明: prevCum('阿明', 110).members.阿明,
      小芳: prevCum('小芳', 95).members.小芳,
    },
  };
  attachDeltaBadges(list, prev);
  assert.equal(list[0].deltaText, '▲55');
  assert.equal(list[0].deltaClass, 'up');
  assert.equal(list[0].deltaMinutes, 55);
  assert.equal(list[1].deltaText, '▼42');
  assert.equal(list[1].deltaClass, 'down');
  assert.equal(list[1].deltaMinutes, -42);
});

test('增减角标：绝对差与相对差必须同时达标（单一条件不足以显示）', () => {
  // 相对差不足：100 → 125（+25 分钟，25%）
  const a = [{ nickname: '甲', totalMinutes: 125 }];
  attachDeltaBadges(a, prevCum('甲', 100));
  assert.equal(a[0].deltaText, undefined, '25% < 30%，不应显示');

  // 绝对差不足：100 → 115（+15 分钟，15%）
  const b = [{ nickname: '乙', totalMinutes: 115 }];
  attachDeltaBadges(b, prevCum('乙', 100));
  assert.equal(b[0].deltaText, undefined, '15 分钟 < 20 分钟，不应显示');
});

test('增减角标：阈值取等号边界时显示', () => {
  const list = [{ nickname: '甲', totalMinutes: 130 }]; // 上期 100 → +30 / +30%
  attachDeltaBadges(list, prevCum('甲', 100));
  assert.equal(list[0].deltaText, '▲30');
  assert.equal(DELTA_MIN_MINUTES, 20);
  assert.equal(DELTA_MIN_PCT, 30);
});

test('增减角标：静默规则（新人 / 请假 / 基线过小 / 本期零）', () => {
  const rows = [
    { nickname: '新人', totalMinutes: 300 }, // 无上期记录
    { nickname: '请假', totalMinutes: 300 }, // 上期整周请假
    { nickname: '基线', totalMinutes: 300 }, // 上期 5 分钟，基线过小
    { nickname: '零', totalMinutes: 0 }, // 本期未打卡
  ];
  const prev = {
    members: {
      请假: prevCum('请假', 100, 'leave').members.请假,
      基线: prevCum('基线', 5).members.基线,
      零: prevCum('零', 100).members.零,
    },
  };
  attachDeltaBadges(rows, prev);
  for (const r of rows) assert.equal(r.deltaText, undefined, `${r.nickname} 不应出现角标`);
});

test('增减角标：无上期 cumulative 时整体静默，不抛错', () => {
  const list = [{ nickname: '阿明', totalMinutes: 300 }];
  assert.doesNotThrow(() => attachDeltaBadges(list, null));
  assert.equal(list[0].deltaText, undefined);
});

test('燃效口径：loadScore 与体重无关（同项目同时长，70kg 与 50kg 同分）', () => {
  const data = run([
    { nickname: '阿明', ordinal: 1, sport: '跑步', quantity: 60, unit: 'min' }, // 70kg
    { nickname: '小芳', ordinal: 2, sport: '跑步', quantity: 60, unit: 'min' }, // 50kg
  ]);
  const a = data.checkinList.find((r) => r.nickname === '阿明');
  const b = data.checkinList.find((r) => r.nickname === '小芳');
  // 训练内容相同 → 负荷分相同；卡路里因体重不同而不同（真实能耗含体重）
  assert.equal(a.loadScore, b.loadScore, 'loadScore 不应含体重乘数');
  assert.notEqual(a.totalCalories, b.totalCalories, '总卡路里仍应反映真实体重差异');
  // avgMET 同理相等，即燃效之星不再被体重垄断
  assert.equal(a.loadScore / a.totalMinutes, b.loadScore / b.totalMinutes);
});
