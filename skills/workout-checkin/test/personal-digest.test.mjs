// personal.mjs 的回归测试：--digest 锁死「周均分母 / 近4期口径 / 请假与缺席 / 归档不全降级」四个口径，
// 并覆盖 --name 与侧车 notes 的昵称归一（别名/脏昵称/前缀歧义）。
// 这些数字由脚本算，AI 直接抄进 full / recent；口径一旦漂移，文案会整体失真且不会报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/personal.mjs');

/** 造一期归档：memberRows = [{nickname, calories, checkins, met}], leaves = [昵称] */
function issue({ no, start, end, memberRows, leaves }) {
  const checkinList = memberRows.map((r) => ({
    nickname: r.nickname,
    totalMinutes: r.calories / 5,
    totalCalories: r.calories,
    checkinCount: r.checkins,
    gapText: r.met ? '达标' : r.checkins > 0 ? '差 1 次' : '未打卡',
  }));
  return {
    issueNo: no,
    weekStart: start,
    weekEnd: end,
    totalMinutesSum: memberRows.reduce((s, r) => s + r.calories / 5, 0),
    totalCaloriesSum: memberRows.reduce((s, r) => s + r.calories, 0),
    metCount: memberRows.filter((r) => r.met).length,
    totalMembers: 2,
    leaveCount: leaves.length,
    absentCount: memberRows.filter((r) => r.checkins === 0).length,
    checkinList,
    leaveList: leaves.map((n) => ({ nickname: n, reason: '病假' })),
    records: { records: [], leaves: [] },
    insights: [],
  };
}

// 4 期：甲每周都打卡（100/200/300/400），乙第 1、4 期打卡、第 2 期请假、第 3 期缺席
function buildArchives() {
  const w = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'];
  const e = ['2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01'];
  const spec = [
    { jia: [100, true], yi: [50, true] },
    { jia: [200, true], yi: null }, // 乙请假
    { jia: [300, true], yi: [0, false] }, // 乙缺席
    { jia: [400, false], yi: [150, true] }, // 甲未达标
  ];
  const rows = spec.map((s, i) => {
    const memberRows = [
      { nickname: '甲', calories: s.jia[0], checkins: 3, met: s.jia[1] },
      { nickname: '丙', calories: 0, checkins: 0, met: false }, // 全程零打卡
    ];
    const leaves = [];
    if (s.yi === null) leaves.push('乙');
    else memberRows.push({ nickname: '乙', calories: s.yi[0], checkins: s.yi[0] > 0 ? 3 : 0, met: s.yi[1] });
    return issue({ no: i + 1, start: w[i], end: e[i], memberRows, leaves });
  });
  // 链式累计每期都写（calc 的真实行为），所以任意一期删掉后最新期仍带 cumulative
  const cumulative = {
    group: { issueCount: 4, totalCalories: 1200, totalMinutes: 240 },
    members: {
      甲: { totalCalories: 1000, totalMinutes: 200, totalCheckins: 12, metWeeks: 3, streak: 0, sports: { 散步: 2, 跳操: 1 } },
      乙: { totalCalories: 200, totalMinutes: 40, totalCheckins: 6, metWeeks: 2, streak: 1, sports: { 跑步: 2 } },
      丙: { totalCalories: 0, totalMinutes: 0, totalCheckins: 0, metWeeks: 0, streak: 0, sports: {} },
    },
  };
  for (const r of rows) r.cumulative = cumulative;
  return rows;
}

const CONFIG = {
  group: '测试群',
  members: [
    { nickname: '甲', aliases: [], weightKg: 60, gender: '', status: 'active' },
    { nickname: '乙', aliases: [], weightKg: 60, gender: '', status: 'active' },
    { nickname: '丙', aliases: [], weightKg: 60, gender: '', status: 'active' },
  ],
};

function runDigest(archives, { dropIssueNo, name, config = CONFIG } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-digest-'));
  for (const a of archives) {
    if (dropIssueNo && a.issueNo === dropIssueNo) continue;
    writeFileSync(join(dir, `2026-issue${String(a.issueNo).padStart(2, '0')}.json`), JSON.stringify(a));
  }
  const cfgPath = join(dir, 'members.test.json');
  writeFileSync(cfgPath, JSON.stringify(config));
  const args = [SCRIPT, dir, '--digest', '--members', cfgPath];
  if (name) args.push('--name', name);
  const r = spawnSync(process.execPath, args, { encoding: 'utf-8' });
  const out = (r.stdout || '') + (r.stderr || '');
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out };
}

const angleOf = (out, who) => (line(out, who).split('▸')[1] || '').trim();

const line = (out, who) => out.split('\n').find((l) => l.trim().startsWith(`${who} ·`)) || '';

test('personal：默认读取 reports 上一级的 members.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'wc-personal-ws-'));
  const reports = join(root, 'reports');
  mkdirSync(reports);
  try {
    for (const a of buildArchives()) {
      writeFileSync(join(reports, `2026-issue${String(a.issueNo).padStart(2, '0')}.json`), JSON.stringify(a));
    }
    writeFileSync(join(root, 'members.json'), JSON.stringify(CONFIG));
    const r = spawnSync(process.execPath, [SCRIPT, reports, '--digest'], { encoding: 'utf-8' });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, `应默认读取工作区配置：\n${out}`);
    assert.match(out, /甲 ·/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('digest：归档旧昵称按 aliases 归到当前规范名，累计与逐期序列接续', () => {
  const w = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'];
  const e = ['2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01'];
  const names = ['甲旧名', '甲旧名', '甲乙', '甲乙'];
  const archives = names.map((nickname, i) =>
    issue({
      no: i + 1,
      start: w[i],
      end: e[i],
      memberRows: [{ nickname, calories: (i + 1) * 100, checkins: 3, met: true }],
      leaves: [],
    })
  );
  const cumulative = {
    group: { issueCount: 4, totalCalories: 1000, totalMinutes: 200 },
    members: {
      甲旧名: {
        totalCalories: 1000, totalMinutes: 200, totalCheckins: 12, metWeeks: 4,
        streak: 4, sports: { 跑步: 12 },
      },
    },
  };
  for (const a of archives) a.cumulative = cumulative;

  const config = {
    group: '改名群',
    members: [{ nickname: '甲乙', aliases: ['甲旧名'], status: 'active' }],
  };
  const { status, out } = runDigest(archives, { config });
  assert.equal(status, 0, out);
  const jiayi = line(out, '甲乙');
  assert.ok(jiayi, `规范名应出现在速览中：\n${out}`);
  assert.match(jiayi, /打卡4\(共12次\)/);
  assert.match(jiayi, /周均150→250/);
  assert.doesNotMatch(out, /无累计记录/);
  assert.doesNotMatch(jiayi, /无记录/);
});

test('personal 渲染：旧昵称归档 + 别名配置，规范名卡片与 spotlight 均接续', () => {
  const root = mkdtempSync(join(tmpdir(), 'wc-personal-rename-'));
  const reports = join(root, 'reports');
  mkdirSync(reports);
  try {
    const archive = {
      issueNo: 4,
      weekStart: '2026-10-26',
      weekEnd: '2026-11-01',
      cumulative: {
        group: { issueCount: 4, totalCalories: 1000, totalMinutes: 200 },
        members: {
          甲旧名: {
            totalCalories: 1000, totalMinutes: 200, totalCheckins: 12, metWeeks: 4,
            streak: 4, bestStreak: 4, attendanceStreak: 4, bestCalories: 400,
            totalRedPacket: 0, sports: { 跑步: 12 }, lastStatus: 'met',
            recentWeeks: [{ issue: 4, minutes: 50, calories: 250, checkins: 3, status: 'met', redPacket: 0 }],
          },
        },
      },
      spotlights: { 甲旧名: { type: 'efficiencyStar', label: '改名亮点' } },
    };
    writeFileSync(join(reports, '2026-issue04.json'), JSON.stringify(archive));
    writeFileSync(
      join(root, 'members.json'),
      JSON.stringify({
        group: '改名群',
        met: {},
        sportNickname: {},
        badges: {},
        members: [{ nickname: '甲乙', aliases: ['甲旧名'], status: 'active', weightKg: 60, gender: '女' }],
      })
    );

    const outPath = join(reports, 'report.html');
    const r = spawnSync(process.execPath, [SCRIPT, reports, '--name', '甲乙', '-o', outPath], {
      encoding: 'utf-8',
    });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, out);
    const html = readFileSync(outPath, 'utf-8');
    assert.match(html, /甲乙/);
    assert.match(html, /改名亮点/, '旧 spotlight key 应归一到规范名后展示');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('digest：周均 = 累计 ÷ 有打卡期数（请假与缺席都不进分母），并给出半程→现在的箭头', () => {
  const { status, out } = runDigest(buildArchives());
  assert.equal(status, 0, out);
  // 甲：前半（第 1–2 期）(100+200)/2=150 → 全程 1000/4=250
  assert.match(line(out, '甲'), /周均150→250\(累计1000·第1\/3\)/);
  // 乙：检查点只有 1 期打卡，不足 2 期不出箭头；全程 200 ÷ 2
  assert.match(line(out, '乙'), /周均100\(累计200·第2\/3\)/); // 200 ÷ 2（第 2 周请假、第 3 周缺席都不算）
});

test('digest：请假与缺席分开计数，都不算「无记录」', () => {
  const { out } = runDigest(buildArchives());
  const yi = line(out, '乙');
  assert.match(yi, /达标2\/4/);
  assert.match(yi, /打卡2\(共6次\)/);
  assert.match(yi, /请假1/);
  assert.match(yi, /缺席1/);
  assert.doesNotMatch(yi, /无记录/, '两期都有名字，不该出现「无记录」');
});

test('digest：近 4 期 = 最近 4 期里有打卡期的平均单期消耗（不按半程切分）', () => {
  const { out } = runDigest(buildArchives());
  assert.match(line(out, '甲'), /近4期250\(4期\)/); // (100+200+300+400)/4
  assert.match(line(out, '乙'), /近4期100\(2期\)/); // 第 2 周请假、第 3 周缺席都不进分母
  assert.doesNotMatch(out, /前半|后半/, '报告是「截至本期」的累计，历史不对半切');
  // 4 期全部落在近 4 期窗口内 → 近 4 期 ≈ 全程，不能拿它当「变化」（峰值刷新是另一回事）
  assert.doesNotMatch(line(out, '甲'), /▸变化 近4期/);
});

test('digest：峰值为消耗最高的一期，并列取最早', () => {
  const { out } = runDigest(buildArchives());
  assert.match(line(out, '甲'), /峰值#04 400/);
  assert.match(line(out, '乙'), /峰值#04 150/);
});

test('digest：归档少于累计快照期数 → 报警且不出周均（防分母偏小导致周均虚高）', () => {
  const { out } = runDigest(buildArchives(), { dropIssueNo: 4 });
  assert.match(out, /⚠ 归档可见 3 期，累计快照记录 4 期/);
  assert.match(line(out, '甲'), /周均—\(归档不全·累计1000·第1\/3\)/);
  assert.doesNotMatch(line(out, '甲'), /周均250/, '归档不全时禁止输出周均');
});

test('digest：零打卡成员不显示「周均0 / 峰值0」这类假数据', () => {
  const { out } = runDigest(buildArchives());
  const bing = line(out, '丙');
  assert.match(bing, /打卡0\(共0次\)/);
  assert.match(bing, /周均—\(累计0·第3\/3\)/);
  assert.match(bing, /峰值—/);
});

test('digest：累计排名按全群排序，消耗并列取同名次', () => {
  const archives = buildArchives();
  archives[0].cumulative.members['乙'].totalCalories = 1000; // 与甲并列第一
  const { out } = runDigest(archives);
  assert.match(line(out, '甲'), /第1\/3/);
  assert.match(line(out, '乙'), /第1\/3/);
  assert.match(line(out, '丙'), /第3\/3/, '并列后名次顺延（1、1、3），不压缩成 1、1、2');
});

test('digest：连击与打卡总数直接引用 cumulative，不另行估算', () => {
  const { out } = runDigest(buildArchives());
  assert.match(line(out, '甲'), /打卡4\(共12次\)/);
  assert.match(line(out, '甲'), /连击0/);
  assert.match(line(out, '乙'), /打卡2\(共6次\)/);
  assert.match(line(out, '乙'), /连击1/);
});

test('digest：近 4 期给出 消耗/时长/状态 三元组（时长不可缺，否则 AI 只能编）', () => {
  const { out } = runDigest(buildArchives());
  assert.match(out, /#01 100\/20\(met\)/);
  assert.match(out, /#04 400\/80\(partial\)/);
  assert.match(out, /#04 150\/30\(met\)/);
});

test('digest：近 4 期全是请假时不出「归零」变化，也不编平均', () => {
  // 近 4 期全是请假 → recent 无打卡，既不出「变化」角度，也不编平均
  const w = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'];
  const e = ['2026-10-11', '2026-10-18', '2026-10-25', '2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29'];
  const spec = [
    { rows: [{ nickname: '甲', calories: 100, checkins: 3, met: true }], leaves: [] },
    { rows: [{ nickname: '甲', calories: 100, checkins: 3, met: true }], leaves: [] },
    { rows: [{ nickname: '甲', calories: 100, checkins: 3, met: true }], leaves: [] },
    { rows: [{ nickname: '甲', calories: 100, checkins: 3, met: true }], leaves: [] },
    { rows: [], leaves: ['甲'] },
    { rows: [], leaves: ['甲'] },
    { rows: [], leaves: ['甲'] },
    { rows: [], leaves: ['甲'] },
  ];
  const archives = spec.map((s, i) => issue({ no: i + 1, start: w[i], end: e[i], memberRows: s.rows, leaves: s.leaves }));
  const cumulative = {
    group: { issueCount: 8, totalCalories: 400, totalMinutes: 80 },
    members: { 甲: { totalCalories: 400, totalMinutes: 80, totalCheckins: 12, metWeeks: 4, streak: 0, sports: { 跑步: 4 } } },
  };
  for (const a of archives) a.cumulative = cumulative;
  const { status, out } = runDigest(archives);
  assert.equal(status, 0, out);
  const jia = line(out, '甲');
  assert.match(jia, /近4期—/, '近 4 期无打卡应显示破折号，不是 0');
  assert.match(jia, /周均100/, '周均只看有打卡的 4 期');
  assert.doesNotMatch(jia, /（-100%）/, '不能把请假写成消耗归零');
  assert.doesNotMatch(jia, /▸变化/, '近 4 期无数据不能当变化');
});

test('digest：加 --name 补生成时角度与全员跑完全一致（角度按全群分配）', () => {
  // 10 期：前 6 期基准 100，后 4 期按 chg 抬高 → 近 4 期 vs 全程周均的偏离各不相同。
  // 5 人都有变化证据，配额只有 2 → 最弱的 E 在全员跑时被挤到水平档；
  // 若只映射目标成员，别人序列全变 null，E 会被误判成「变化」
  const N = 10;
  const base = Date.UTC(2026, 9, 5);
  const day = (n) => new Date(base + n * 86400000).toISOString().slice(0, 10);
  const w = Array.from({ length: N }, (_, i) => day(i * 7));
  const e = Array.from({ length: N }, (_, i) => day(i * 7 + 6));
  const names = ['A', 'B', 'C', 'D', 'E'];
  const lift = { A: 1.0, B: 0.7, C: 0.5, D: 0.3, E: 0.22 };
  const seriesOf = (n) => Array.from({ length: N }, (_, i) => (i < N - 4 ? 100 : Math.round(100 * (1 + lift[n]))));
  const archives = [];
  for (let i = 0; i < N; i++) {
    const rows = names.map((n) => ({ nickname: n, calories: seriesOf(n)[i], checkins: 3, met: true }));
    archives.push(issue({ no: i + 1, start: w[i], end: e[i], memberRows: rows, leaves: [] }));
  }
  const cumulative = { group: { issueCount: N, totalCalories: 0, totalMinutes: 0 }, members: {} };
  for (const n of names) {
    const series = seriesOf(n);
    cumulative.members[n] = {
      // 累计必须与逐期序列自洽：周均就是这条线的平均
      totalCalories: series.reduce((s, x) => s + x, 0),
      totalMinutes: Math.round(series.reduce((s, x) => s + x, 0) / 5),
      totalCheckins: N * 3,
      metWeeks: N,
      streak: 1,
      sports: { 跑步: N * 3 },
    };
  }
  for (const a of archives) a.cumulative = cumulative;
  const config = { group: '角测', members: names.map((n) => ({ nickname: n, aliases: [], status: 'active' })) };

  const multi = runDigest(archives, { config }).out;
  assert.match(angleOf(multi, 'E'), /^水平/, 'E 在全员跑应被挤到水平档');
  assert.match(angleOf(multi, 'A'), /^变化/, 'A 的偏离最大，应进变化档');
  for (const n of names) {
    const single = runDigest(archives, { config, name: n }).out;
    assert.equal(angleOf(single, n), angleOf(multi, n), `${n} 的角度在 --name 与全员跑下不一致`);
  }
});

test('文档一致性：双行骨架单一真源在 references §2.2，SKILL.md 不内嵌', () => {
  // SKILL.md 内嵌骨架会与 references 形成双写，改一处漏一处就让人照着错的写；真源只在 references §2.2
  const pick = (file) =>
    readFileSync(file, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('full：') || l.startsWith('recent：'));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const fromSkill = pick(resolve(root, 'SKILL.md'));
  const fromRef = pick(resolve(root, 'references/insight-writing.md'));
  assert.equal(fromRef.length, 2, 'references §2.2 应有且仅有一份 full/recent 骨架');
  assert.equal(fromSkill.length, 0, 'SKILL.md 不应内嵌骨架（真源在 references §2.2）');
});

// --- P1-6：--name 与侧车 notes 的昵称解析（与归档 spotlights 同一套归一） ---

const ALIAS_CONFIG = {
  group: '测试群',
  members: [
    { nickname: '甲', aliases: ['老甲'], weightKg: 60, status: 'active' },
    { nickname: '乙', aliases: [], weightKg: 60, status: 'active' },
    { nickname: '丙', aliases: [], weightKg: 60, status: 'active' },
  ],
};

test('personal：--name 复用 calc 的昵称规则——别名与脏昵称都能归到规范名', () => {
  const archives = buildArchives();
  for (const raw of ['老甲', '甲~', '🔥甲']) {
    const { status, out } = runDigest(archives, { name: raw, config: ALIAS_CONFIG });
    assert.equal(status, 0, `--name「${raw}」应命中甲：\n${out}`);
    assert.ok(line(out, '甲'), `--name「${raw}」应输出甲的速览行：\n${out}`);
    assert.ok(!out.includes('乙 ·'), `--name 只该出一个人：\n${out}`);
  }
});

test('personal：--name 前缀兜底唯一命中才采纳，撞多人或未命中直接报错', () => {
  const config = {
    group: '撞名群',
    members: [
      { nickname: '小美', aliases: [], weightKg: 60, status: 'active' },
      { nickname: '小美同学', aliases: [], weightKg: 60, status: 'active' },
    ],
  };
  const suffix = runDigest(buildArchives(), { name: '小美 年底目标60KG', config });
  assert.equal(suffix.status, 0, `后缀备注应按前缀兜底归到小美：\n${suffix.out}`);
  assert.ok(line(suffix.out, '小美'), `应只输出小美：\n${suffix.out}`);
  assert.ok(!suffix.out.includes('小美同学 ·'), '唯一前缀命中不该把同名族的人都带出来');

  // 「小美同学啦」同时以 小美 / 小美同学 开头 → 两个候选，禁止猜测
  const ambiguous = runDigest(buildArchives(), { name: '小美同学啦', config });
  assert.equal(ambiguous.status, 1, '前缀撞多人必须失败');
  assert.match(ambiguous.out, /前缀匹配到多个成员/);
  assert.match(ambiguous.out, /小美、小美同学/);

  const missing = runDigest(buildArchives(), { name: '查无此人', config });
  assert.equal(missing.status, 1);
  assert.match(missing.out, /未找到成员「查无此人」/);
});

test('personal：侧车 notes 的 key 用别名/脏昵称也能命中（不再静默隐藏洞察区）', () => {
  const root = mkdtempSync(join(tmpdir(), 'wc-personal-sidecar-'));
  const reports = join(root, 'reports');
  mkdirSync(reports, { recursive: true });
  try {
    for (const a of buildArchives()) {
      writeFileSync(join(reports, `2026-issue${String(a.issueNo).padStart(2, '0')}.json`), JSON.stringify(a));
    }
    writeFileSync(join(root, 'members.json'), JSON.stringify(ALIAS_CONFIG));
    writeFileSync(
      join(reports, 'personal-insights.json'),
      JSON.stringify({
        issueNo: 4,
        notes: {
          '老甲~': { full: '四周攒下一千大卡，三周过线，缺的那周败在强度。', recent: '本期回落百米，节奏还在。' },
          '乙': { full: '两周一线，起伏比总量更显眼。', recent: '回归这周把断口补上了。' },
          '丙': { full: '全程零打卡，先问能不能把门槛降到一次。', recent: '连续四周无记录。' },
        },
      })
    );
    const r = spawnSync(process.execPath, [SCRIPT, reports], { encoding: 'utf-8' });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, out);
    assert.ok(!out.includes('数据洞察缺成员'), `别名 key 应命中甲：\n${out}`);
    const html = readFileSync(join(reports, '2026-issue04-personal.html'), 'utf-8');
    assert.ok(html.includes('四周攒下一千大卡'), '老甲~ 的 full 应落到甲的报告里');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
