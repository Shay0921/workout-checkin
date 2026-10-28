/**
 * preflight 体检测试：sportAlias 四象限判定
 *
 * 背景：resolveSport 的匹配顺序是「先直查 met，再走别名双向」，所以
 *   - 键在 met、值也在 met → 直查阶段被截胡，别名永不生效（死别名）
 *   - 键不在 met、值在 met → 合法的反向映射（「爬楼梯」→「爬楼」）
 * 只校验键会漏掉前者——而前者正是「想归并却静默拆成两个项目」的成因。
 *
 * 配置全部在临时目录合成，不读生产 members.json，也不碰 fixtures
 * （fixtures/members.test.json 中的「自由训练→自由活动」是 parse.test.mjs 的回归样本，故意保留）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const testDir = dirname(fileURLToPath(import.meta.url));
const preflightPath = resolve(testDir, '../scripts/preflight.mjs');

/** 最小合法配置（met 含 散步/跑步/养生操 三个项目） */
function baseConfig() {
  return {
    group: '测试运动群',
    weekRule: { minCheckins: 3, cycle: 'Mon-Sun' },
    redPacket: { zeroOrOne: 10, two: 5 },
    leaveKeywords: ['请假'],
    defaultWeightKg: 60,
    periodConfig: { anchorIssue: 1, anchorWeekStart: '2026-10-12', anchorWeekEnd: '2026-10-18' },
    convert: {
      climbPerFloorMin: 0.4,
      kmPerMin: { 跑步: 6 },
      minPerCount: {},
    },
    met: { 散步: 3.5, 跑步: 8.0, 养生操: 2.8 },
    sportAlias: { 散步: ['步行'] },
    sportNickname: { 散步: 'cityWalker', 跑步: '风之子', 养生操: '养生派' },
    members: [{ nickname: '成员甲', aliases: [], weightKg: 60, gender: '', status: 'active' }],
  };
}

/** 跑一次 preflight，返回 {status, out}（out = stdout + stderr 合并） */
function runPreflight(config) {
  const dir = mkdtempSync(resolve(tmpdir(), 'wk-preflight-'));
  const p = resolve(dir, 'members.json');
  writeFileSync(p, JSON.stringify(config, null, 2), 'utf-8');
  const r = spawnSync(process.execPath, [preflightPath, '--members', p], { encoding: 'utf-8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('preflight：正常别名 + 反向映射 → 放行', () => {
  const cfg = baseConfig();
  cfg.sportAlias = { 散步: ['步行', '户外散步'], 爬楼梯: '散步' };
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 0, `应放行，实际输出：\n${out}`);
  assert.match(out, /反向映射 1 条/);
  assert.match(out, /全部可命中/);
});

test('preflight：死别名（值本身是 met 条目）→ 退出码 1 并点名', () => {
  const cfg = baseConfig();
  cfg.sportAlias = { 养生操: ['太极', '散步'] };
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 1, '死别名必须拦下');
  assert.match(out, /死别名/);
  assert.match(out, /养生操 ← 散步/);
  assert.doesNotMatch(out, /养生操 ← 太极/, '太极不在 met，不应被误判');
});

test('preflight：键值都不在 met → 退出码 1', () => {
  const cfg = baseConfig();
  cfg.sportAlias = { 不存在项目: '某个别名' };
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 1);
  assert.match(out, /键值都不在 met/);
});

test('preflight：同一别名被两个项目声明 → 退出码 1', () => {
  const cfg = baseConfig();
  cfg.sportAlias = { 散步: ['走路'], 跑步: ['走路'] };
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 1);
  assert.match(out, /静默取首个/);
});

test('preflight：别名不是字符串 → 退出码 1', () => {
  const cfg = baseConfig();
  cfg.sportAlias = { 散步: [''] };
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 1);
  assert.match(out, /不是非空字符串/);
});

// ── 反向映射的「同键多值」陷阱：resolveSport 命中即 return，只有第一个值在 met 的候选生效 ──

test('preflight：同键多个反向映射 → 只有首个生效，其余判死', () => {
  const cfg = baseConfig();
  cfg.sportAlias = { 步行类: ['散步', '跑步'] }; // 键不在 met，两个值都在 met
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 1, '第二个反向映射永不生效，必须拦下');
  assert.match(out, /反向映射被同组前项截胡/);
  assert.match(out, /步行类 ← 跑步/);
  assert.doesNotMatch(out, /截胡[^\n]*散步/, '首个是生效的，不应出现在错误行');
});

test('preflight：键同时是别组别名（两跳歧义）→ 告警但不阻塞', () => {
  const cfg = baseConfig();
  cfg.sportAlias = { 养生操: ['太极'], 太极: ['散步'] };
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 0, `仅告警，不应改退出码：\n${out}`);
  assert.match(out, /既是本组键、又是/);
});

test('preflight：标准名放键、口语放值（正向写法）→ 全绿', () => {
  const cfg = baseConfig();
  cfg.sportAlias = { 散步: ['步行', '户外散步', '走路'] };
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 0);
  assert.match(out, /9?共 3 条别名，全部可命中|3 条别名，全部可命中/);
});

// ── 期号锚点：首期允许节后短周，其余不足 7 天仍告警 ──

test('preflight：第 1 期周四起、周日止的短周 → 放行且不告警', () => {
  const cfg = baseConfig();
  cfg.periodConfig = { anchorIssue: 1, anchorWeekStart: '2026-10-08', anchorWeekEnd: '2026-10-11' };
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 0, `应放行，实际输出：\n${out}`);
  assert.match(out, /首期短周/);
  assert.doesNotMatch(out, /期号与周窗口可能错位/);
});

test('preflight：非首期短周 → 仍告警', () => {
  const cfg = baseConfig();
  cfg.periodConfig = { anchorIssue: 2, anchorWeekStart: '2026-10-08', anchorWeekEnd: '2026-10-11' };
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 0);
  assert.match(out, /期号与周窗口可能错位/);
});

// ── 配置定位：members.json 随工作区走，默认读 <workspace>/members.json ──

test('preflight：默认读取 --workspace 根目录的 members.json', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'wk-preflight-ws-'));
  const p = resolve(dir, 'members.json');
  writeFileSync(p, JSON.stringify(baseConfig(), null, 2), 'utf-8');
  const r = spawnSync(process.execPath, [preflightPath, '--workspace', dir], { encoding: 'utf-8' });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, `应放行，实际输出：\n${out}`);
  assert.ok(out.includes(p), `输出应包含工作区配置路径 ${p}：\n${out}`);
});

// ── 归档名口径：必须与 calc/render 一致（<年>-issue<NN>.json），单位号归档三个脚本都看不见 ──

/** 搭一个带 reports/ 的工作区，返回 {dir, run} */
function workspaceWithArchives(archiveNames) {
  const dir = mkdtempSync(resolve(tmpdir(), 'wk-preflight-rep-'));
  writeFileSync(resolve(dir, 'members.json'), JSON.stringify(baseConfig(), null, 2), 'utf-8');
  mkdirSync(resolve(dir, 'reports'));
  for (const f of archiveNames) writeFileSync(resolve(dir, 'reports', f), '{}', 'utf-8');
  const r = spawnSync(process.execPath, [preflightPath, '--workspace', dir], { encoding: 'utf-8' });
  return { dir, status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('preflight：reports/ 内是规范命名归档 → 放行并计数', () => {
  const { status, out } = workspaceWithArchives(['2026-issue01.json', '2026-issue02.json']);
  assert.equal(status, 0, `应放行，实际输出：\n${out}`);
  assert.match(out, /已有 2 期归档/);
});

test('preflight：归档期号未补零（issue7）→ 退出码 1 并给出正确文件名', () => {
  const { status, out } = workspaceWithArchives(['2026-issue7.json']);
  assert.equal(status, 1, `calc 认不出这份归档，必须拦下：\n${out}`);
  assert.match(out, /期号未补零/);
  assert.match(out, /2026-issue07\.json/);
  assert.match(out, /暂无归档/, '不得把它算进「已有 N 期归档」');
});

test('preflight：三位期号（issue007）同样判为不规范', () => {
  const { status, out } = workspaceWithArchives(['2026-issue007.json']);
  assert.equal(status, 1, `应拦下：\n${out}`);
  assert.match(out, /2026-issue07\.json/);
});

// ── 归档期号连续性：缺口只告警不拦（出下一期只读最后一环，缺口影响的是补算） ──

test('preflight：归档期号连续 → 不告警，并给出期号范围', () => {
  const { status, out } = workspaceWithArchives(['2026-issue01.json', '2026-issue02.json', '2026-issue03.json']);
  assert.equal(status, 0, `应放行：\n${out}`);
  assert.match(out, /已有 3 期归档（第 1~3 期/);
  assert.doesNotMatch(out, /期号有缺口/);
});

test('preflight：归档期号有缺口 → 告警点名缺哪期与后果，但不拦', () => {
  const { status, out } = workspaceWithArchives(['2026-issue01.json', '2026-issue02.json', '2026-issue04.json']);
  assert.equal(status, 0, `缺口不该阻塞本期出报：\n${out}`);
  assert.match(out, /归档期号有缺口：缺第 3 期/);
  assert.match(out, /找不到上期归档/, '应说明补算时 calc 会怎么拦');
});

test('preflight：多个缺口一次列全', () => {
  const { out } = workspaceWithArchives(['2026-issue01.json', '2026-issue04.json', '2026-issue06.json']);
  assert.match(out, /缺第 2、3、5 期/);
});

test('preflight：期号跨年递增与同号换账本都不算缺口', () => {
  const cross = workspaceWithArchives(['2026-issue13.json', '2027-issue14.json']);
  assert.equal(cross.status, 0, `应放行：\n${cross.out}`);
  assert.doesNotMatch(cross.out, /期号有缺口/, '期号跨年全局递增，不按年分组');
  const reanchor = workspaceWithArchives(['2026-issue13.json', '2027-issue13.json', '2027-issue14.json']);
  assert.doesNotMatch(reanchor.out, /期号有缺口/, '同号跨年（换账本重新起链）是合法的');
});

test('preflight：工作区缺少 members.json → 退出码 2 并提示写盘路径', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'wk-preflight-empty-'));
  const expected = resolve(dir, 'members.json');
  const r = spawnSync(process.execPath, [preflightPath, '--workspace', dir], { encoding: 'utf-8' });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 2, `应提示首次初始化，实际输出：\n${out}`);
  assert.ok(out.includes(expected), `输出应包含待写入路径 ${expected}：\n${out}`);
  assert.match(out, /首次使用/);
});

// ── 昵称/别名冲突：必须按归一化 key 判定（emoji/空格/波浪号在匹配前已剥离） ──

test('preflight：昵称归一后相同（空格/符号差异）→ 退出码 1', () => {
  const cfg = baseConfig();
  cfg.members = [
    { nickname: '甲乙', aliases: [], weightKg: 60, gender: '', status: 'active' },
    { nickname: '甲 乙', aliases: [], weightKg: 60, gender: '', status: 'active' },
  ];
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 1, `归一后相同应拦下，实际输出：\n${out}`);
  assert.match(out, /昵称归一后重复/);
});

test('preflight：别名归一后撞上他人昵称 → 退出码 1', () => {
  const cfg = baseConfig();
  cfg.members = [
    { nickname: '甲乙', aliases: [], weightKg: 60, gender: '', status: 'active' },
    { nickname: '甲旧名', aliases: ['甲乙~'], weightKg: 60, gender: '', status: 'active' },
  ];
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 1, `别名撞车应拦下，实际输出：\n${out}`);
  assert.match(out, /归一后撞车/);
});

// ── 体重默认与 convert 体检：缺省体重可放行，缺换算必须早拦 ──

test('preflight：成员未填 weightKg 但有 defaultWeightKg → 放行', () => {
  const cfg = baseConfig();
  cfg.members = [{ nickname: '成员甲', aliases: [], gender: '', status: 'active' }];
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 0, `默认体重应放行，实际输出：\n${out}`);
  assert.match(out, /defaultWeightKg = 60/);
});

test('preflight：成员未填 weightKg 且 defaultWeightKg 缺失 → 退出码 1', () => {
  const cfg = baseConfig();
  delete cfg.defaultWeightKg;
  cfg.members = [{ nickname: '成员甲', aliases: [], gender: '', status: 'active' }];
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 1, `无默认体重必须拦下，实际输出：\n${out}`);
  assert.match(out, /defaultWeightKg/);
});

test('preflight：convert 缺失 → 退出码 1，不允许等到 calc 抛裸 TypeError', () => {
  const cfg = baseConfig();
  delete cfg.convert;
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 1, `convert 缺失必须早拦，实际输出：\n${out}`);
  assert.match(out, /convert 缺失/);
});

test('preflight：kmPerMin 含非法值 → 退出码 1', () => {
  const cfg = baseConfig();
  cfg.convert.kmPerMin = { 跑步: 0 };
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 1, `km 换算非正数必须拦下，实际输出：\n${out}`);
  assert.match(out, /kmPerMin.*跑步/);
});

test('preflight：convert 里有不认识的键 → 只告警不阻塞（写了也不生效）', () => {
  const cfg = baseConfig();
  cfg.convert.swimPerKmMin = 25; // 旧口径字段：calc 不再读取
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 0, `未知键不应拦住开工，实际输出：\n${out}`);
  assert.match(out, /swimPerKmMin/);
  assert.match(out, /不会被读取/);
});

test('preflight：minPerCount 含非法值 → 退出码 1', () => {
  const cfg = baseConfig();
  cfg.convert.minPerCount = { 跳绳: -1 };
  const { status, out } = runPreflight(cfg);
  assert.equal(status, 1, `count 换算非正数必须拦下，实际输出：\n${out}`);
  assert.match(out, /minPerCount.*跳绳/);
});
