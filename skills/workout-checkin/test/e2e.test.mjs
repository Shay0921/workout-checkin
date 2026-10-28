/**
 * 端到端测试：模拟接龙全流程
 * mock-records.json → calc.mjs → data.json → 补 insights → render.mjs → HTML + 归档
 * 全部输出走系统临时目录（mkdtemp），不污染工作区
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, mkdtempSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { INSIGHT_TITLES, COND_TITLE } from '../scripts/render.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(testDir, 'fixtures');
const skillDir = resolve(testDir, '..');
const calcPath = resolve(skillDir, 'scripts/calc.mjs');
const renderPath = resolve(skillDir, 'scripts/render.mjs');
const node = process.execPath;

/** 在临时目录搭建工作区：records.json + reports/2026-issue01.json（上期归档） */
function setupWorkspace() {
  const ws = mkdtempSync(resolve(tmpdir(), 'wk-e2e-'));
  copyFileSync(resolve(fixturesDir, 'mock-records.json'), resolve(ws, 'records.json'));
  mkdirSync(resolve(ws, 'reports'), { recursive: true });
  copyFileSync(resolve(fixturesDir, 'prev-report.json'), resolve(ws, 'reports/2026-issue01.json'));
  return ws;
}

/** 改写临时工作区 records.json 的顶层 weekStart（模拟本周新接龙的标注周期） */
function writeRecordsWeek(ws, weekStart) {
  const p = resolve(ws, 'records.json');
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf-8')), weekStart }, null, 2), 'utf-8');
}

/** 执行 CLI（同步），返回 {status, stdout, stderr} */
const exec = (script, args) => spawnSync(node, [script, ...args], { encoding: 'utf-8' });

test('e2e：接龙 → calc → 补 insights → render → HTML + 归档 全流程', () => {
  const ws = setupWorkspace();
  try {
    // --- ① calc：--week 2026-10-15（周四）应归一到 10-12 所在周 ---
    const dataPath = resolve(ws, 'data.json');
    const calc = exec(calcPath, [
      resolve(ws, 'records.json'),
      '--members', resolve(fixturesDir, 'members.test.json'),
      '--week', '2026-10-15',
      '-o', dataPath,
    ]);
    assert.equal(calc.status, 0, `calc 失败：${calc.stderr}`);
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'));

    // --- ② 周期与期号 ---
    assert.equal(data.issueNo, 2);
    assert.equal(data.weekStart, '2026-10-12');
    assert.equal(data.weekEnd, '2026-10-18');
    assert.equal(data.groupName, '测试运动群');
    assert.equal(data.minCheckins, 3);

    // --- ③ 群体指标（7 人：打卡 5 / 请假 1 / 未打卡 1）---
    assert.equal(data.totalMembers, 7);
    assert.equal(data.checkinCount, 5);
    assert.equal(data.leaveCount, 1);
    assert.equal(data.absentCount, 1);
    assert.equal(data.metCount, 3); // 阿明/小芳/老王 各 3 次
    assert.equal(data.notMetCount, 4);
    assert.equal(data.targetRate, 43); // 3/7 = 42.86 → 43
    assert.equal(data.targetRateAngle, 154.8);
    assert.equal(data.checkinPercent, 71); // 5/7 = 71.43 → 71
    assert.equal(data.checkinAngle, 255.6);
    assert.equal(data.leavePercent, 14);
    assert.equal(data.leaveAngle, 50.4);
    assert.equal(data.absentPercent, 14);
    assert.equal(data.absentAngle, 54); // 闭环：360 − 255.6 − 50.4

    // --- ④ 打卡名单（次数降序 → 卡路里降序；未打卡沉底）---
    const nicks = data.checkinList.map((c) => c.nickname);
    assert.deepEqual(nicks, ['阿明', '小芳', '老王', 'Huahua', '小周', '小张']);
    const aming = data.checkinList[0];
    assert.equal(aming.checkinCount, 3); // distinct ordinals {1,2,3}（同次多项目只计 1 次）
    assert.equal(aming.totalMinutes, 169); // 90+30+25+24(0.8km×30)
    assert.equal(aming.totalCalories, 1339); // 735+175+233+196（逐条取整累加）
    const zhang = data.checkinList[5];
    assert.equal(zhang.checkinCount, 0);
    assert.equal(zhang.statusClass, 'danger');
    assert.equal(zhang.gapText, '未打卡');
    const yia = data.checkinList[3];
    assert.equal(yia.gapText, '差 2 次'); // 1 次，minCheckins=3
    assert.equal(yia.statusClass, 'warning');
    assert.equal(data.totalMinutesSum, 508);
    assert.equal(data.totalCaloriesSum, 3135);

    // --- ⑤ 运动类型（9 种 → 6+1；同人次按码点排序保证确定性）---
    assert.equal(data.hasOtherSports, true);
    assert.deepEqual(
      data.sportStats.map((s) => s.name),
      ['羽毛球', '跑步', '力训', '散步', '游泳', '爬楼']
    );
    assert.equal(data.sportStats[0].count, 3);
    assert.equal(data.sportStats[0].barWidthPercent, 100);
    assert.equal(data.otherSportCount, 3); // 瑜伽/自由活动/跳绳
    assert.equal(data.otherSportTotal, 3);
    assert.equal(data.otherBarWidthPercent, 100);

    // --- ⑥ 请假与红包 ---
    assert.deepEqual(data.leaveList, [{ nickname: '小刘', reason: '病假' }]);
    assert.equal(data.redPacketTiers.length, 1);
    assert.equal(data.redPacketTiers[0].tier, '¥10 · 差 2 次或未打卡');
    assert.equal(data.redPacketTiers[0].peopleCount, 3);
    assert.equal(data.redPacketTiers[0].amount, 30);
    assert.equal(data.redPacketTiers[0].nameList, 'Huahua、小周、小张');
    assert.equal(data.redPacketTotal, 30);
    assert.equal(data.totalPeople, 3);

    // --- ⑦ 趋势（上期归档：红包 ¥15、小芳请假）---
    assert.equal(data.redPacketTrendText, '较上期 +¥15');
    assert.equal(data.returnWelcome.nickname, '小芳'); // 上期请假本周回归 120 分钟
    assert.equal(data.returnWelcome.initial, '小');
    assert.equal(data.returnWelcome.message, '上周请假，本周回归打卡 120 分钟，欢迎回来！');

    // --- ⑧ render 拒绝空 insights（强制 AI 先补写）---
    const renderEmpty = exec(renderPath, [dataPath, '-o', resolve(ws, 'reports/2026-issue02.html')]);
    assert.notEqual(renderEmpty.status, 0);
    assert.ok(renderEmpty.stderr.includes('insights'), '空 insights 应报错');

    // --- ⑧b render 拒绝违反 insights 契约（条数越界 / 固定栏目缺失 / 结构非法）---
    // 栏目名取自 render 的契约常量，不写字面量
    const fixedSix = INSIGHT_TITLES.map((title, i) => ({
      title,
      content: [
        '门槛没咬住人，7 人里 5 人过线，剩下两个各差一次。',
        '散步少了一人次，热闹正往室内项目迁。',
        '高强度占了四成，人均燃效比上期抬了一点。',
        '版图只铺到四种，宽度没变、厚度在往散步集中。',
        '二十碗米饭的能量，够这群人吃一顿还得剩。',
        '红包池翻了一倍，罚款面却没收窄。',
      ][i],
    }));
    // 条数 5 → 报错
    writeFileSync(dataPath, JSON.stringify({ ...data, insights: fixedSix.slice(0, 5) }, null, 2), 'utf-8');
    const renderFive = exec(renderPath, [dataPath, '-o', resolve(ws, 'reports/2026-issue02.html')]);
    assert.notEqual(renderFive.status, 0);
    assert.ok(renderFive.stderr.includes('最少 6'), '条数 5 应报错');
    // 固定栏目缺失 → 报错（用 4 字非固定标题，确保命中的是「缺固定栏目」而不是 title 字数校验）
    const noFixed = fixedSix.map((i, idx) => (idx === 0 ? { title: '临时四字', content: i.content } : i));
    writeFileSync(dataPath, JSON.stringify({ ...data, insights: noFixed }, null, 2), 'utf-8');
    const renderNoFixed = exec(renderPath, [dataPath, '-o', resolve(ws, 'reports/2026-issue02.html')]);
    assert.notEqual(renderNoFixed.status, 0);
    assert.ok(renderNoFixed.stderr.includes(INSIGHT_TITLES[0]), '缺固定栏目应报错');
    // 纯字符串数组 → 报错
    writeFileSync(dataPath, JSON.stringify({ ...data, insights: fixedSix.map((i) => i.content) }, null, 2), 'utf-8');
    const renderStrings = exec(renderPath, [dataPath, '-o', resolve(ws, 'reports/2026-issue02.html')]);
    assert.notEqual(renderStrings.status, 0);
    assert.ok(renderStrings.stderr.includes('结构非法'), '纯字符串数组应报错');
    // 8 条（6 固定 + 2 自由）→ 合法
    const withFree = [
      ...fixedSix,
      { title: '能量换算', content: '群总消耗 ≈ 20 碗米饭。' },
      { title: '效率对比', content: '跳绳每分钟消耗最高。' },
    ];
    writeFileSync(dataPath, JSON.stringify({ ...data, insights: withFree }, null, 2), 'utf-8');
    const renderEight = exec(renderPath, [dataPath, '-o', resolve(ws, 'reports/2026-issue02.html')]);
    assert.equal(renderEight.status, 0, `render 失败：${renderEight.stderr}`);

    // 无断更（streakBreaks 空）时出现条件栏 → 报错（双向校验）
    const withCondNoBreak = [
      ...fixedSix.slice(0, 3),
      { title: COND_TITLE, content: '小张此前 1 连击，本周中断。' },
      ...fixedSix.slice(3),
    ];
    writeFileSync(dataPath, JSON.stringify({ ...data, insights: withCondNoBreak }, null, 2), 'utf-8');
    const renderCond = exec(renderPath, [dataPath, '-o', resolve(ws, 'reports/2026-issue02.html')]);
    assert.notEqual(renderCond.status, 0);
    assert.ok(renderCond.stderr.includes(COND_TITLE), '无断更出现条件栏应报错');

    // --- ⑨ 补写 insights（固定 6 栏）后渲染成功 ---
    data.insights = fixedSix;
    writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    const htmlPath = resolve(ws, 'reports/2026-issue02.html');
    const render = exec(renderPath, [dataPath, '-o', htmlPath]);
    assert.equal(render.status, 0, `render 失败：${render.stderr}`);
    assert.ok(existsSync(htmlPath));
    const html = readFileSync(htmlPath, 'utf-8');
    assert.ok(html.includes('测试运动群'));
    assert.ok(!/\{\{[^}]*\}\}/.test(html), '渲染结果不应残留占位符');
    assert.ok(
      html.includes("link.download = '2026-issue02-10.12.png';"),
      '保存图片文件名应按「year-issueNN-MM.DD.png」命名'
    );

    // --- ⑩ render 自动归档（含最终 insights + records 流水内嵌）---
    const archivePath = resolve(ws, 'reports/2026-issue02.json');
    assert.ok(existsSync(archivePath), '渲染成功后应自动生成同名归档');
    const archive = JSON.parse(readFileSync(archivePath, 'utf-8'));
    assert.equal(archive.issueNo, 2);
    assert.equal(archive.insights.length, 6);
    assert.ok(archive.archivedAt, '归档应含 archivedAt 时间戳');
    // 内嵌的是 records.json 完整结构（records 流水 + leaves 请假名单）
    assert.ok(archive.records && archive.records.records.length === 13, '归档应内嵌 records 流水（去重前 13 条）');
    assert.equal(archive.records.leaves.length, 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：calc 对未知昵称报错并列出成员表提示', () => {
  const ws = mkdtempSync(resolve(tmpdir(), 'wk-e2e-'));
  try {
    writeFileSync(
      resolve(ws, 'records.json'),
      JSON.stringify({ records: [{ nickname: '神秘人', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' }], leaves: [] })
    );
    const calc = exec(calcPath, [resolve(ws, 'records.json'), '--members', resolve(fixturesDir, 'members.test.json')]);
    assert.notEqual(calc.status, 0);
    assert.ok(calc.stderr.includes('神秘人'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：calc 默认读取 records.json 同目录的 members.json', () => {
  const ws = setupWorkspace();
  try {
    copyFileSync(resolve(fixturesDir, 'members.test.json'), resolve(ws, 'members.json'));
    const dataPath = resolve(ws, 'data.json');
    const calc = exec(calcPath, [
      resolve(ws, 'records.json'),
      '--week', '2026-10-15',
      '-o', dataPath,
    ]);
    assert.equal(calc.status, 0, `calc 应默认读取工作区配置：${calc.stderr}`);
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
    assert.equal(data.issueNo, 2);
    assert.equal(data.groupName, '测试运动群');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：首期短周按锚点实际起止输出（10-08 ~ 10-11）', () => {
  const ws = setupWorkspace();
  try {
    const cfg = JSON.parse(readFileSync(resolve(fixturesDir, 'members.test.json'), 'utf-8'));
    cfg.periodConfig = { anchorIssue: 1, anchorWeekStart: '2026-10-08', anchorWeekEnd: '2026-10-11' };
    writeFileSync(resolve(ws, 'members.json'), JSON.stringify(cfg, null, 2), 'utf-8');
    writeRecordsWeek(ws, '2026-10-08');

    const dataPath = resolve(ws, 'data.json');
    const calc = exec(calcPath, [
      resolve(ws, 'records.json'),
      '--week', '2026-10-08',
      '--min-checkins', '2',
      '-o', dataPath,
    ]);
    assert.equal(calc.status, 0, `calc 失败：${calc.stderr}`);
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
    assert.equal(data.issueNo, 1);
    assert.equal(data.weekStart, '2026-10-08');
    assert.equal(data.weekEnd, '2026-10-11');
    assert.equal(data.minCheckins, 2);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：改名成员按 aliases 接续历史累计（不清零、不重复）', () => {
  const ws = mkdtempSync(resolve(tmpdir(), 'wk-rename-'));
  try {
    const cfg = JSON.parse(readFileSync(resolve(fixturesDir, 'members.test.json'), 'utf-8'));
    cfg.weekRule.minCheckins = 1;
    cfg.sportAlias = {};
    cfg.intensityOverride = {};
    cfg.members = [
      { nickname: '甲乙', aliases: ['甲旧名'], status: 'active', weightKg: 60 },
      { nickname: '乙', aliases: ['小乙'], status: 'active', weightKg: 60 },
    ];
    writeFileSync(resolve(ws, 'members.json'), JSON.stringify(cfg, null, 2), 'utf-8');
    writeFileSync(
      resolve(ws, 'records.json'),
      JSON.stringify({
        weekStart: '2026-10-12',
        records: [
          { nickname: '甲乙', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
          { nickname: '乙', ordinal: 1, sport: '跑步', quantity: 30, unit: 'min' },
        ],
        leaves: [],
      })
    );

    const zero = {
      streak: 0, bestStreak: 0, attendanceStreak: 0, metWeeks: 0,
      totalCheckins: 0, totalMinutes: 0, totalCalories: 0, bestCalories: 0,
      totalRedPacket: 0, sports: {}, lastStatus: 'absent', recentWeeks: [],
    };
    const prevCumulative = {
      group: {
        issueCount: 1, totalCheckins: 30, totalMinutes: 300, totalCalories: 3000,
        totalRedPacket: 0, totalMetWeeks: 5,
        efficiencyStarStreak: { nickname: '甲旧名', weeks: 2 },
        calorieKingStreak: { nickname: '甲旧名', weeks: 2 },
      },
      members: {
        甲旧名: {
          ...zero, streak: 4, bestStreak: 6, attendanceStreak: 5, metWeeks: 5,
          totalCheckins: 30, totalMinutes: 300, totalCalories: 3000, bestCalories: 800,
          sports: { 跑步: 30 }, lastStatus: 'met',
          recentWeeks: [{ issue: 1, minutes: 300, calories: 3000, checkins: 30, status: 'met', redPacket: 0 }],
        },
        小乙: {
          ...zero, lastStatus: 'leave', bestCalories: 500, // 本周消耗不破纪录，才能验证回归战士
          recentWeeks: [{ issue: 1, minutes: 0, calories: 0, checkins: 0, status: 'leave', redPacket: 0 }],
        },
      },
    };
    mkdirSync(resolve(ws, 'reports'), { recursive: true });
    writeFileSync(
      resolve(ws, 'reports/2026-issue01.json'),
      JSON.stringify({
        issueNo: 1,
        weekStart: '2026-10-05',
        weekEnd: '2026-10-11',
        redPacketTotal: 0,
        sportStats: [],
        leaveList: [{ nickname: '小乙', reason: '病假' }],
        cumulative: prevCumulative,
      })
    );

    const dataPath = resolve(ws, 'data.json');
    const calc = exec(calcPath, [
      resolve(ws, 'records.json'),
      '--week', '2026-10-15',
      '-o', dataPath,
    ]);
    assert.equal(calc.status, 0, `calc 失败：${calc.stderr}`);
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'));

    const jiayi = data.cumulative.members['甲乙'];
    assert.ok(jiayi, '规范名应有累计记录');
    assert.equal(jiayi.streak, 5);              // 上期 streak 4 + 本期 met
    assert.equal(jiayi.bestStreak, 6);
    assert.equal(jiayi.totalCheckins, 31);
    assert.equal(jiayi.totalMinutes, 330);
    assert.equal(jiayi.totalCalories, 3240);
    assert.equal(jiayi.sports['跑步'], 31);
    assert.equal(jiayi.metWeeks, 6);
    assert.equal(data.cumulative.members['甲旧名'], undefined, '旧 key 不得再向下传递');
    assert.equal(data.cumulative.members['小乙'], undefined, '旧 key 不得再向下传递');

    // 上期请假名单里的旧名也要归一，回归欢迎才能命中规范名
    assert.equal(data.returnWelcome.nickname, '乙');
    assert.equal(data.returnWelcome.message, '上周请假，本周回归打卡 30 分钟，欢迎回来！');
    assert.equal(data.spotlights['乙'].label, '回归战士');
    // 蝉联昵称同样归一：上期燃效/消耗之星是旧名，本期仍是同一人 → 继续累计
    assert.equal(data.cumulative.group.efficiencyStarStreak.nickname, '甲乙');
    assert.equal(data.cumulative.group.efficiencyStarStreak.weeks, 3);
    assert.equal(data.cumulative.group.calorieKingStreak.nickname, '甲乙');
    assert.equal(data.cumulative.group.calorieKingStreak.weeks, 3);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：render 拒绝把样例数据写入 reports/（防假归档污染累计）', () => {
  const ws = mkdtempSync(resolve(tmpdir(), 'wk-e2e-'));
  try {
    mkdirSync(resolve(ws, 'reports'), { recursive: true });
    const blocked = exec(renderPath, [
      resolve(skillDir, 'assets/data.sample.json'),
      '-o', resolve(ws, 'reports/2026-issue02.html'),
    ]);
    assert.notEqual(blocked.status, 0, '样例数据写入 reports/ 应被拒绝');
    assert.ok(blocked.stderr.includes('reports/'), '应提示 reports/ 被禁止');
    assert.equal(existsSync(resolve(ws, 'reports/2026-issue02.json')), false, '不得留下假归档');
    assert.equal(existsSync(resolve(ws, 'reports/2026-issue02.html')), false, '不得留下 HTML');

    // 同一份样例写到非 reports/ 目录应放行（试渲染合法路径）
    const allowed = exec(renderPath, [
      resolve(skillDir, 'assets/data.sample.json'),
      '-o', resolve(ws, 'preview.html'),
    ]);
    assert.equal(allowed.status, 0, `预览目录应放行：${allowed.stderr}`);
    assert.ok(existsSync(resolve(ws, 'preview.html')));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// --- P1-5：归档与上期骨架比对都跟着「输出 HTML 同目录」走，目录写错 = 本期从下期账本里消失 ---

/** calc + 补写 insights，产出可直接渲染的 data.json 路径（下面两条 P1-5 用例共用） */
function renderableData(ws) {
  const dataPath = resolve(ws, 'data.json');
  const calc = exec(calcPath, [
    resolve(ws, 'records.json'),
    '--members', resolve(fixturesDir, 'members.test.json'),
    '--week', '2026-10-15',
    '-o', dataPath,
  ]);
  assert.equal(calc.status, 0, `calc 失败：${calc.stderr}`);
  const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
  data.insights = INSIGHT_TITLES.map((title, i) => ({
    title,
    content: [
      '门槛没咬住人，7 人里 5 人过线，剩下两个各差一次。',
      '散步少了一人次，热闹正往室内项目迁。',
      '高强度占了四成，人均燃效比上期抬了一点。',
      '版图只铺到四种，宽度没变、厚度在往散步集中。',
      '二十碗米饭的能量，够这群人吃一顿还得剩。',
      '红包池翻了一倍，罚款面却没收窄。',
    ][i],
  }));
  writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  return dataPath;
}

test('e2e：不带 -o → 默认写 data.json 同级的 reports/，HTML 与归档同名成对', () => {
  const ws = setupWorkspace();
  try {
    const render = exec(renderPath, [renderableData(ws)]);
    assert.equal(render.status, 0, `默认路径应成功：${render.stderr}`);
    assert.ok(!/不是 reports/.test(render.stderr), `默认路径不该报警告：${render.stderr}`);
    assert.equal(existsSync(resolve(ws, 'reports/2026-issue02.html')), true, '默认 HTML 应落 reports/');
    assert.equal(existsSync(resolve(ws, 'reports/2026-issue02.json')), true, '默认归档应与 HTML 同名成对');
    assert.equal(existsSync(resolve(ws, '2026-issue02.json')), false, '归档不得落在工作区根目录');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：显式 -o 指向非 reports/ → 警告「下期读不到」但仍放行（试渲染合法）', () => {
  const ws = setupWorkspace();
  try {
    const render = exec(renderPath, [renderableData(ws), '-o', resolve(ws, 'preview.html')]);
    assert.equal(render.status, 0, `非 reports/ 目录仍应放行：${render.stderr}`);
    assert.match(render.stderr, /不是 reports/);
    assert.match(render.stderr, /下期 calc 读不到/);
    assert.equal(existsSync(resolve(ws, '2026-issue02.json')), true, '归档按输出同目录写入');
    assert.equal(existsSync(resolve(ws, 'reports/2026-issue02.json')), false, 'reports/ 内不应出现本期归档');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：输出目录决定跨期骨架比对——默认 reports/ 才拦得住照抄上期', () => {
  const ws = setupWorkspace();
  try {
    const dataPath = renderableData(ws);
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
    // 把上期归档的 insights 写成本期同款 = 最典型的「只改数字没换骨架」
    const prevPath = resolve(ws, 'reports/2026-issue01.json');
    const prev = JSON.parse(readFileSync(prevPath, 'utf-8'));
    prev.insights = data.insights;
    writeFileSync(prevPath, JSON.stringify(prev, null, 2) + '\n', 'utf-8');

    const blocked = exec(renderPath, [dataPath]);
    assert.notEqual(blocked.status, 0, '照抄上期同栏必须被拦（默认输出目录读得到上期归档）');
    assert.match(blocked.stderr, /与上期同栏/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// --- P1-5 续：断链必须交回用户决定，不能静默按首期重算 ---

/** 第 3 期场景：reports/ 只有 issue01（缺 issue02），records 标注 2026-10-19 那周 */
function setupBrokenChain() {
  const ws = setupWorkspace();
  writeRecordsWeek(ws, '2026-10-19');
  return ws;
}

const brokenChainArgs = (ws) => [
  resolve(ws, 'records.json'),
  '--members', resolve(fixturesDir, 'members.test.json'),
  '--week', '2026-10-22',
  '-o', resolve(ws, 'data.json'),
];

test('e2e：期号 > 1 却缺上期归档 → calc 退出 1 并指名缺失文件（不按首期静默重算）', () => {
  const ws = setupBrokenChain();
  try {
    const calc = exec(calcPath, brokenChainArgs(ws));
    assert.notEqual(calc.status, 0, '断链必须拦下');
    assert.match(calc.stderr, /第 3 期找不到上期归档/);
    assert.match(calc.stderr, /2026-issue02\.json/);
    assert.match(calc.stderr, /--allow-missing-prev/);
    assert.equal(existsSync(resolve(ws, 'data.json')), false, '拦下后不应产出 data.json');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：上期归档存在但 JSON 损坏 → 报「不可用」，且 --allow-missing-prev 不得绕过', () => {
  const ws = setupBrokenChain();
  try {
    writeFileSync(resolve(ws, 'reports/2026-issue02.json'), '{broken json');
    const calc = exec(calcPath, brokenChainArgs(ws));
    assert.notEqual(calc.status, 0, '归档损坏必须拦下');
    assert.match(calc.stderr, /上期归档不可用/);
    assert.match(calc.stderr, /2026-issue02\.json/);
    assert.doesNotMatch(calc.stderr, /找不到上期归档/, '文件明明在，不能报找不到');
    const forced = exec(calcPath, [...brokenChainArgs(ws), '--allow-missing-prev']);
    assert.notEqual(forced.status, 0, '损坏归档不是断链，不能用 --allow-missing-prev 绕过');
    assert.match(forced.stderr, /上期归档不可用/);
    assert.equal(existsSync(resolve(ws, 'data.json')), false, '拦下后不应产出 data.json');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：上期归档内容期号不符 → 报「不可用」，不得静默续链', () => {
  const ws = setupBrokenChain();
  try {
    const d = JSON.parse(readFileSync(resolve(ws, 'reports/2026-issue01.json'), 'utf-8'));
    writeFileSync(resolve(ws, 'reports/2026-issue02.json'), JSON.stringify(d)); // 文件名 02，内容仍是 01
    const calc = exec(calcPath, brokenChainArgs(ws));
    assert.notEqual(calc.status, 0, '内容期号不符必须拦下');
    assert.match(calc.stderr, /上期归档不可用/);
    assert.doesNotMatch(calc.stderr, /找不到上期归档/, '文件明明在，不能报找不到');
    assert.equal(existsSync(resolve(ws, 'data.json')), false, '拦下后不应产出 data.json');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：--allow-missing-prev 明示断链 → 放行并按首期兜底', () => {
  const ws = setupBrokenChain();
  try {
    const calc = exec(calcPath, [...brokenChainArgs(ws), '--allow-missing-prev']);
    assert.equal(calc.status, 0, `明示断链应放行：${calc.stderr}`);
    assert.match(calc.stdout, /无上期归档/);
    const data = JSON.parse(readFileSync(resolve(ws, 'data.json'), 'utf-8'));
    assert.equal(data.issueNo, 3);
    assert.equal(data.cumulative.group.issueCount, 1, '断链后累计从本期重新开始');
    assert.equal(data.redPacketTrendText, '首期 · 暂无对比');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：reports/ 一份归档都没有 → 首跑只提示不拦（锚点期号可以 > 1）', () => {
  const ws = mkdtempSync(resolve(tmpdir(), 'wk-e2e-'));
  try {
    copyFileSync(resolve(fixturesDir, 'members.test.json'), resolve(ws, 'members.json'));
    copyFileSync(resolve(fixturesDir, 'mock-records.json'), resolve(ws, 'records.json'));
    writeRecordsWeek(ws, '2026-10-19');
    const calc = exec(calcPath, [resolve(ws, 'records.json'), '--week', '2026-10-22', '-o', resolve(ws, 'data.json')]);
    assert.equal(calc.status, 0, `首跑不该被断链拦截挡住：${calc.stderr}`);
    assert.match(calc.stderr, /还没有任何归档/);
    const data = JSON.parse(readFileSync(resolve(ws, 'data.json'), 'utf-8'));
    assert.equal(data.issueNo, 3);
    assert.equal(data.cumulative.group.issueCount, 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：reports/ 只有未补零归档（issue2）→ calc 拦下并给出正确文件名，不当成首跑静默起链', () => {
  const ws = mkdtempSync(resolve(tmpdir(), 'wk-e2e-'));
  try {
    copyFileSync(resolve(fixturesDir, 'members.test.json'), resolve(ws, 'members.json'));
    copyFileSync(resolve(fixturesDir, 'mock-records.json'), resolve(ws, 'records.json'));
    writeRecordsWeek(ws, '2026-10-19');
    mkdirSync(resolve(ws, 'reports'));
    copyFileSync(resolve(fixturesDir, 'prev-report.json'), resolve(ws, 'reports/2026-issue2.json'));
    const calc = exec(calcPath, [resolve(ws, 'records.json'), '--week', '2026-10-22', '-o', resolve(ws, 'data.json')]);
    assert.notEqual(calc.status, 0, '未补零归档不能被当成「没有归档」放行');
    assert.match(calc.stderr, /期号未补零/);
    assert.match(calc.stderr, /2026-issue2\.json → 2026-issue02\.json/);
    assert.doesNotMatch(calc.stderr, /还没有任何归档/, '账本其实在，只是名字不对');
    assert.equal(existsSync(resolve(ws, 'data.json')), false, '拦下后不该产出 data.json');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：上期归档齐备 → 不触发断链拦截', () => {
  const ws = setupWorkspace();
  try {
    const calc = exec(calcPath, [
      resolve(ws, 'records.json'),
      '--members', resolve(fixturesDir, 'members.test.json'),
      '--week', '2026-10-15',
      '-o', resolve(ws, 'data.json'),
    ]);
    assert.equal(calc.status, 0, `正常链路应通过：${calc.stderr}`);
    assert.match(calc.stdout, /上期归档：第 1 期/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// --- P1-2：只说「生成周报」却没粘新接龙时，禁止复用上期 records.json ---

test('e2e：records.json 标注上一期周期 → calc 拒绝（防复用旧接龙出周报）', () => {
  const ws = setupWorkspace();
  try {
    writeRecordsWeek(ws, '2026-10-05');
    const calc = exec(calcPath, [
      resolve(ws, 'records.json'),
      '--members', resolve(fixturesDir, 'members.test.json'),
      '--week', '2026-10-15',
      '-o', resolve(ws, 'data.json'),
    ]);
    assert.notEqual(calc.status, 0, '周期不符应拦下');
    assert.ok(calc.stderr.includes('2026-10-05'), `应点出旧周期：\n${calc.stderr}`);
    assert.ok(calc.stderr.includes('2026-10-12'), `应给出本期周期：\n${calc.stderr}`);
    assert.equal(existsSync(resolve(ws, 'data.json')), false, '拒绝后不得产出 data.json');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：records.json 缺顶层 weekStart → 只告警不阻断（兼容旧产物）', () => {
  const ws = setupWorkspace();
  try {
    const p = resolve(ws, 'records.json');
    const { weekStart, ...rest } = JSON.parse(readFileSync(p, 'utf-8'));
    writeFileSync(p, JSON.stringify(rest, null, 2), 'utf-8');
    const dataPath = resolve(ws, 'data.json');
    const calc = exec(calcPath, [
      p,
      '--members', resolve(fixturesDir, 'members.test.json'),
      '--week', '2026-10-15',
      '-o', dataPath,
    ]);
    assert.equal(calc.status, 0, `缺 weekStart 不应阻断：${calc.stderr}`);
    assert.ok(/缺少顶层 weekStart/.test(calc.stderr), '应给出补写提示');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：--week 是不存在的日期（2026-02-30）→ calc 拒绝，不得静默滚成 03-02', () => {
  const ws = setupWorkspace();
  try {
    const calc = exec(calcPath, [
      resolve(ws, 'records.json'),
      '--members', resolve(fixturesDir, 'members.test.json'),
      '--week', '2026-02-30',
      '-o', resolve(ws, 'data.json'),
    ]);
    assert.notEqual(calc.status, 0, '不存在的日期应拦下');
    assert.ok(/--week 不是有效日期/.test(calc.stderr), `应点名 --week：\n${calc.stderr}`);
    assert.ok(calc.stderr.includes('2026-02-30'), `应回显传入值：\n${calc.stderr}`);
    assert.equal(existsSync(resolve(ws, 'data.json')), false, '拦下后不得产出 data.json');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：月日不补零的真实日期（--week 2026-10-5 + weekStart 2026-10-5）→ 与补零写法等价，不得误判非法', () => {
  const ws = setupWorkspace();
  try {
    writeRecordsWeek(ws, '2026-10-5');
    const dataPath = resolve(ws, 'data.json');
    const calc = exec(calcPath, [
      resolve(ws, 'records.json'),
      '--members', resolve(fixturesDir, 'members.test.json'),
      '--week', '2026-10-5',
      '-o', dataPath,
    ]);
    assert.equal(calc.status, 0, `不补零的真实日期应放行：${calc.stderr}`);
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
    assert.equal(data.issueNo, 1);
    assert.equal(data.weekStart, '2026-10-05', '输出的周期一律补零归一');
    assert.equal(data.weekEnd, '2026-10-11');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：records.json 的 weekStart 是不存在的日期 → calc 拒绝，且不套用「复用旧接龙」的误导诊断', () => {
  const ws = setupWorkspace();
  try {
    writeRecordsWeek(ws, '2026-10-32');
    const calc = exec(calcPath, [
      resolve(ws, 'records.json'),
      '--members', resolve(fixturesDir, 'members.test.json'),
      '--week', '2026-10-15',
      '-o', resolve(ws, 'data.json'),
    ]);
    assert.notEqual(calc.status, 0, '不存在的 weekStart 应拦下');
    assert.ok(/weekStart「2026-10-32」不是有效日期/.test(calc.stderr), `应点名非法日期：\n${calc.stderr}`);
    assert.ok(!/没有粘贴本周新接龙/.test(calc.stderr), `这是日期写错，不是周期不符：\n${calc.stderr}`);
    assert.equal(existsSync(resolve(ws, 'data.json')), false, '拦下后不得产出 data.json');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：统计日期早于首期开始日 → calc 拒绝并说明锚点写法', () => {
  const ws = setupWorkspace();
  try {
    const cfg = JSON.parse(readFileSync(resolve(fixturesDir, 'members.test.json'), 'utf-8'));
    cfg.periodConfig = { anchorIssue: 1, anchorWeekStart: '2026-10-14', anchorWeekEnd: '2026-10-18' };
    writeFileSync(resolve(ws, 'members.json'), JSON.stringify(cfg, null, 2), 'utf-8');
    const calc = exec(calcPath, [
      resolve(ws, 'records.json'),
      '--members', resolve(ws, 'members.json'),
      '--week', '2026-10-05',
      '-o', resolve(ws, 'data.json'),
    ]);
    assert.notEqual(calc.status, 0, '早于首期应拦下');
    assert.ok(/早于首期开始日/.test(calc.stderr), `应提示锚点配置：\n${calc.stderr}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('e2e：km 项目缺少换算配置 → 报错点名项目与配置键，不回退游泳配速', () => {
  const ws = mkdtempSync(resolve(tmpdir(), 'wk-e2e-'));
  try {
    const cfg = JSON.parse(readFileSync(resolve(fixturesDir, 'members.test.json'), 'utf-8'));
    cfg.convert.kmPerMin = { 游泳: 30 };
    writeFileSync(resolve(ws, 'members.json'), JSON.stringify(cfg, null, 2), 'utf-8');
    writeFileSync(
      resolve(ws, 'records.json'),
      JSON.stringify({
        weekStart: '2026-10-12',
        records: [{ nickname: '阿明', ordinal: 1, sport: '骑行', quantity: 12, unit: 'km' }],
        leaves: [],
      })
    );
    const calc = exec(calcPath, [resolve(ws, 'records.json'), '--week', '2026-10-15', '-o', resolve(ws, 'data.json')]);
    assert.notEqual(calc.status, 0, '缺 km 换算应拦下');
    assert.ok(/公里换算未配置/.test(calc.stderr), `应点出换算未配置：\n${calc.stderr}`);
    assert.ok(calc.stderr.includes('骑行'), '应点出缺失的项目名');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
