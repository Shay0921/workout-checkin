// presentWeeks（在册期数）口径回归：链式 +1 / 旧归档一次性迁移 / 渲染不再依赖往期 json。
// 这个字段是达标率的分母，一旦算错，新人被系统性误判为「半途摆烂」，且不会报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCumulative } from '../scripts/cumulative.mjs';
import { buildPresenceIndex } from '../scripts/archive.mjs';
import { findArchiveMigrationGaps } from '../scripts/calc.mjs';

const SCRIPT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts');
const CALC = resolve(SCRIPT_DIR, 'calc.mjs');
const PERSONAL = resolve(SCRIPT_DIR, 'personal.mjs');
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const memberStat = (nickname, overrides = {}) => ({
  nickname,
  lastStatus: 'met',
  checkinCount: 3,
  totalMinutes: 60,
  totalCalories: 300,
  redPacketAmount: 0,
  sports: { 跑步: 3 },
  ...overrides,
});

test('presentWeeks：链式 +1，入群首期 = 1，老成员延续递增', () => {
  const config = { sportNickname: {}, met: {} };
  const prevCumulative = {
    group: { issueCount: 3 },
    members: {
      老张: { metWeeks: 3, streak: 3, totalCheckins: 9, totalMinutes: 180, totalCalories: 900, bestCalories: 400, totalRedPacket: 0, sports: {}, lastStatus: 'met', recentWeeks: [], presentWeeks: 3 },
    },
  };
  const cum = buildCumulative({
    prevCumulative,
    memberStats: [memberStat('老张'), memberStat('新人')],
    config,
    issueNo: 4,
  });
  assert.equal(cum.members.老张.presentWeeks, 4, '老成员第 3 期在册 3 → 第 4 期应为 4');
  assert.equal(cum.members.新人.presentWeeks, 1, '上期没有他的人，本期是第 1 期');
});

test('presentWeeks：达标/未达标/请假/缺席都 +1，只有「还没入群」不计数', () => {
  const config = { sportNickname: {}, met: {} };
  const had = (metWeeks) => ({
    metWeeks,
    streak: 0,
    attendanceStreak: 0,
    totalCheckins: 9,
    totalMinutes: 180,
    totalCalories: 900,
    bestCalories: 400,
    totalRedPacket: 0,
    sports: {},
    lastStatus: 'met',
    recentWeeks: [],
    presentWeeks: 3,
  });
  const cum = buildCumulative({
    prevCumulative: {
      group: { issueCount: 3 },
      members: { 达标者: had(3), 未达标者: had(2), 请假者: had(3), 缺席者: had(1) },
    },
    memberStats: [
      memberStat('达标者'),
      memberStat('未达标者', { lastStatus: 'partial', checkinCount: 1 }),
      memberStat('请假者', { lastStatus: 'leave', checkinCount: 0, sports: {} }),
      memberStat('缺席者', { lastStatus: 'absent', checkinCount: 0, sports: {} }),
      memberStat('新入群'),
    ],
    config,
    issueNo: 4,
  });
  // 在册 = 名单里的 active 成员，与本周表现无关：请假/缺席只是在达标率和连击上吃亏，不会被踢出分母
  for (const nick of ['达标者', '未达标者', '请假者', '缺席者']) {
    assert.equal(cum.members[nick].presentWeeks, 4, `${nick} 在册第 4 期，应计 4（与本周状态无关）`);
  }
  assert.equal(cum.members.达标者.metWeeks, 4);
  assert.equal(cum.members.未达标者.metWeeks, 2, '未达标不增加 metWeeks，但 presentWeeks 照加');
  assert.equal(cum.members.请假者.metWeeks, 3, '请假不增加 metWeeks，但 presentWeeks 照加');
  assert.equal(cum.members.新入群.presentWeeks, 1, '上期名单里没有他 = 本期才入群，从 1 起算');
});

test('presentWeeks：迁移基线覆盖「prev 缺字段」的 0，避免老成员被当新人', () => {
  const config = { sportNickname: {}, met: {} };
  const cum = buildCumulative({
    // 旧归档：有该成员但没 presentWeeks（本次升级前生成）；其余字段经 canonicalize 后齐全
    prevCumulative: {
      group: { issueCount: 4 },
      members: { 小恺: { metWeeks: 2, lastStatus: 'met', recentWeeks: [] } },
    },
    memberStats: [memberStat('小恺')],
    config,
    issueNo: 5,
    presentBaseline: new Map([['小恺', 2]]),
  });
  assert.equal(cum.members.小恺.presentWeeks, 3, '基线 2（第 3、4 期在册）+ 本期 1 = 3');
});

/** 造一期最简归档；cumulative 传 null 表示不写该字段（模拟结构不完整的归档） */
function archive({ no, weekStart, weekEnd, nicknames, cumulative }) {
  return {
    issueNo: no,
    weekStart,
    weekEnd,
    totalCaloriesSum: nicknames.length * 300,
    totalMinutesSum: nicknames.length * 60,
    metCount: nicknames.length,
    totalMembers: nicknames.length,
    leaveCount: 0,
    absentCount: 0,
    checkinList: nicknames.map((nickname) => ({
      nickname,
      totalCalories: 300,
      totalMinutes: 60,
      checkinCount: 3,
      gapText: '达标',
    })),
    leaveList: [],
    ...(cumulative ? { cumulative } : {}),
    spotlights: {},
    insights: [],
  };
}

test('calc 迁移：旧归档缺 presentWeeks 时扫一次归档补齐，新人仍从 1 起算', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wc-presence-migrate-'));
  const reports = join(ws, 'reports');
  mkdirSync(reports, { recursive: true });
  try {
    // 第 1 期：只有阿明、小芳在册，且归档缺少 presentWeeks
    writeFileSync(
      join(reports, '2026-issue01.json'),
      JSON.stringify(
        archive({
          no: 1,
          weekStart: '2026-10-05',
          weekEnd: '2026-10-11',
          nicknames: ['阿明~', '小芳'],
          cumulative: {
            group: { issueCount: 1 },
            members: {
              阿明: { metWeeks: 1, streak: 1, totalCheckins: 3, totalMinutes: 60, totalCalories: 300, sports: {}, lastStatus: 'met', recentWeeks: [] },
              小芳: { metWeeks: 1, streak: 1, totalCheckins: 3, totalMinutes: 60, totalCalories: 300, sports: {}, lastStatus: 'met', recentWeeks: [] },
            },
          },
        })
      )
    );
    copyFileSync(resolve(FIXTURES, 'mock-records.json'), join(ws, 'records.json'));
    const out = join(ws, 'data.json');
    const r = spawnSync(
      process.execPath,
      [CALC, join(ws, 'records.json'), '--members', resolve(FIXTURES, 'members.test.json'), '--week', '2026-10-15', '-o', out],
      { encoding: 'utf-8' }
    );
    const log = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, log);
    assert.match(log, /缺 presentWeeks/, '应提示已做一次性迁移');

    const data = JSON.parse(readFileSync(out, 'utf-8'));
    assert.equal(data.issueNo, 2);
    assert.equal(data.cumulative.members.阿明.presentWeeks, 2, '第 1 期在册 + 本期 = 2');
    assert.equal(data.cumulative.members.小芳.presentWeeks, 2);
    assert.equal(data.cumulative.members.小张.presentWeeks, 1, '第 1 期归档里没有他 = 本期才入群');
    assert.equal(data.cumulative.members.阿明.metWeeks, 2, '达标期数不受迁移影响');
    assert.equal(
      data.cumulative.group.firstWeekStart,
      '2026-10-05',
      '迁移要一并补上群首期日期，否则标题区间从本期起永久错位'
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('渲染：归档自带 presentWeeks 时，达标率不再依赖往期 json', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wc-presence-o1-'));
  const reports = join(ws, 'reports');
  mkdirSync(reports, { recursive: true });
  try {
    // 只放最新一期（往期归档全都不存在）；丁 presentWeeks=2 且两期都达标
    const cumMember = (presentWeeks, metWeeks) => ({
      streak: metWeeks,
      bestStreak: metWeeks,
      attendanceStreak: metWeeks,
      metWeeks,
      presentWeeks,
      totalCheckins: metWeeks * 3,
      totalMinutes: metWeeks * 60,
      totalCalories: metWeeks * 500,
      bestCalories: 500,
      totalRedPacket: 0,
      sports: { 跑步: metWeeks * 3 },
      lastStatus: 'met',
      recentWeeks: [],
    });
    writeFileSync(
      join(reports, '2026-issue04.json'),
      JSON.stringify({
        issueNo: 4,
        weekStart: '2026-10-26',
        weekEnd: '2026-11-01',
        cumulative: {
          group: { issueCount: 4, totalCalories: 1400, totalMinutes: 240 },
          members: { 丁: cumMember(2, 2), 戊: cumMember(4, 3) },
        },
        checkinList: [
          { nickname: '丁', totalCalories: 500, totalMinutes: 60, checkinCount: 3, gapText: '达标' },
          { nickname: '戊', totalCalories: 500, totalMinutes: 60, checkinCount: 3, gapText: '达标' },
        ],
        leaveList: [],
        spotlights: {},
      })
    );
    writeFileSync(
      join(ws, 'members.json'),
      JSON.stringify({
        group: '在册期数测试群',
        members: [
          { nickname: '丁', aliases: [], weightKg: 60, gender: '', status: 'active' },
          { nickname: '戊', aliases: [], weightKg: 60, gender: '', status: 'active' },
        ],
      })
    );
    const r = spawnSync(process.execPath, [PERSONAL, reports], { encoding: 'utf-8' });
    const log = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, log);
    const html = readFileSync(join(reports, '2026-issue04-personal.html'), 'utf-8');
    const rateOf = (nick) => {
      const row = html.match(new RegExp(`data-nickname="${nick}"[^>]*data-metrate="(\\d+)"`));
      return row ? Number(row[1]) : null;
    };
    assert.equal(rateOf('丁'), 100, '在册 2 期全达标，且往期归档缺失也能算出 100%');
    assert.equal(rateOf('戊'), 75, '在册 4 期达标 3 期 = 75%');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('迁移判定：归档缺哪个字段补哪个（原始归档口径，不经 canonicalize）', () => {
  const member = { metWeeks: 1, recentWeeks: [] };
  assert.equal(findArchiveMigrationGaps(null), null, '首期没有上期归档 → 不迁移');
  assert.deepEqual(findArchiveMigrationGaps({ cumulative: undefined }), ['presentWeeks', 'group.firstWeekStart']);
  assert.deepEqual(findArchiveMigrationGaps({ cumulative: { group: {}, members: { 甲: member } } }), [
    'presentWeeks',
    'group.firstWeekStart',
  ]);
  // canonicalize 之后 presentWeeks 会是 0，只有原始归档能看出它缺少该字段
  assert.deepEqual(findArchiveMigrationGaps({ cumulative: { group: { firstWeekStart: '2026-10-05' }, members: { 甲: { ...member, presentWeeks: 1 } } } }), null);
  assert.deepEqual(
    findArchiveMigrationGaps({ cumulative: { group: {}, members: { 甲: { ...member, presentWeeks: 1 } } } }),
    ['group.firstWeekStart'],
    'presentWeeks 已有时不该顺带覆盖在册基线'
  );
});

test('calc 迁移：只缺 firstWeekStart 时补的是首期日期，presentWeeks 照旧链式 +1', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wc-presence-fws-'));
  const reports = join(ws, 'reports');
  mkdirSync(reports, { recursive: true });
  try {
    // 上期归档：成员级 presentWeeks 已在，只有 group.firstWeekStart 缺（旧 group + 新成员字段）
    const prev = archive({
      no: 1,
      weekStart: '2026-10-05',
      weekEnd: '2026-10-11',
      nicknames: ['阿明'],
      cumulative: {
        group: { issueCount: 1 },
        members: {
          阿明: {
            metWeeks: 1, streak: 1, attendanceStreak: 1, presentWeeks: 1, totalCheckins: 3,
            totalMinutes: 60, totalCalories: 300, bestCalories: 300, totalRedPacket: 0,
            sports: {}, lastStatus: 'met', recentWeeks: [],
          },
        },
      },
    });
    writeFileSync(join(reports, '2026-issue01.json'), JSON.stringify(prev));
    copyFileSync(resolve(FIXTURES, 'mock-records.json'), join(ws, 'records.json'));
    const out = join(ws, 'data.json');
    const r = spawnSync(
      process.execPath,
      [CALC, join(ws, 'records.json'), '--members', resolve(FIXTURES, 'members.test.json'), '--week', '2026-10-15', '-o', out],
      { encoding: 'utf-8' }
    );
    const log = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, log);
    assert.match(log, /缺 group\.firstWeekStart/, '应提示补的是首期日期');
    assert.doesNotMatch(log, /缺 presentWeeks/, 'presentWeeks 已存在，不该说它缺');

    const data = JSON.parse(readFileSync(out, 'utf-8'));
    assert.equal(data.issueNo, 2);
    assert.equal(data.cumulative.group.firstWeekStart, '2026-10-05', '首期日期取自上期归档，不是本期');
    assert.equal(data.cumulative.members.阿明.presentWeeks, 2, '在册期数继续链式 +1');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('速览与渲染同一个分母：往期归档缺失时，digest 的达标率不被逐期扫描带偏', () => {
  const ws = mkdtempSync(join(tmpdir(), 'wc-presence-digest-'));
  const reports = join(ws, 'reports');
  mkdirSync(reports, { recursive: true });
  const cumMember = (presentWeeks, metWeeks) => ({
    streak: metWeeks,
    bestStreak: metWeeks,
    attendanceStreak: metWeeks,
    metWeeks,
    presentWeeks,
    totalCheckins: metWeeks * 3,
    totalMinutes: metWeeks * 60,
    totalCalories: metWeeks * 500,
    bestCalories: 500,
    totalRedPacket: 0,
    sports: { 跑步: metWeeks * 3 },
    lastStatus: 'met',
    recentWeeks: [],
  });
  try {
    writeFileSync(
      join(reports, '2026-issue04.json'),
      JSON.stringify({
        issueNo: 4,
        weekStart: '2026-10-26',
        weekEnd: '2026-11-01',
        cumulative: {
          group: { issueCount: 4, firstWeekStart: '2026-10-05', totalCalories: 1400, totalMinutes: 240 },
          members: { 丁: cumMember(2, 2), 戊: cumMember(4, 3) },
        },
        checkinList: [
          { nickname: '丁', totalCalories: 500, totalMinutes: 60, checkinCount: 3, gapText: '达标' },
          { nickname: '戊', totalCalories: 500, totalMinutes: 60, checkinCount: 3, gapText: '达标' },
        ],
        leaveList: [],
        spotlights: {},
      })
    );
    writeFileSync(
      join(ws, 'members.json'),
      JSON.stringify({
        group: '在册期数测试群',
        members: [
          { nickname: '丁', aliases: [], weightKg: 60, gender: '', status: 'active' },
          { nickname: '戊', aliases: [], weightKg: 60, gender: '', status: 'active' },
        ],
      })
    );

    // 只有最新一期归档：逐期扫描数出「达标 1 期 / 可见 1 期」，链式值是 2/2 与 3/4。
    // 速览若用扫描值，AI 会写「4 期只达标 1 周」，而卡片显示 100%——两边必须同源。
    const digest = spawnSync(process.execPath, [PERSONAL, reports, '--digest'], { encoding: 'utf-8' });
    const dlog = (digest.stdout || '') + (digest.stderr || '');
    assert.equal(digest.status, 0, dlog);
    assert.match(dlog, /丁 · 达标2\/2\(在册2期\)/, `速览应沿用链式在册口径：\n${dlog}`);
    assert.match(dlog, /戊 · 达标3\/4\(在册4期\)/);
    assert.doesNotMatch(dlog, /达标[0-9]\/1\b/, '不该把可见期数当达标分母');
    // 归档不全只影响逐期指标，不该再说达标率失真
    assert.match(dlog, /⚠ 归档可见 1 期/);
    assert.doesNotMatch(dlog, /达标率的分母偏小/);

    const render = spawnSync(process.execPath, [PERSONAL, reports], { encoding: 'utf-8' });
    assert.equal(render.status, 0, (render.stdout || '') + (render.stderr || ''));
    const html = readFileSync(join(reports, '2026-issue04-personal.html'), 'utf-8');
    const rateOf = (nick) => {
      const row = html.match(new RegExp(`data-nickname="${nick}"[^>]*data-metrate="(\\d+)"`));
      return row ? Number(row[1]) : null;
    };
    assert.equal(rateOf('丁'), 100, '页面与速览同为 2/2');
    assert.equal(rateOf('戊'), 75, '页面与速览同为 3/4');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('兜底扫描：退群再回归从 1 重算，与 calc 链式同口径', () => {
  const idx = new Map([
    ['甲', '甲'],
    ['乙', '乙'],
  ]);
  const mk = (no, nicks) => ({ issueNo: no, members: new Map(nicks.map((n) => [n, { status: 'met' }])) });
  // 甲 #1#2 在册，#3 退群（归档无他），#4 回归
  const issues = [mk(1, ['甲', '乙']), mk(2, ['甲', '乙']), mk(3, ['乙']), mk(4, ['甲', '乙'])];
  const scanned = buildPresenceIndex(issues, idx);
  assert.equal(scanned.get('乙'), 4, '全程在册 = 4');
  assert.equal(scanned.get('甲'), 1, '断档前的不累计，回归后从 1 重新计');

  // 同一场景走 calc 链式（上期 #3 的 cumulative 里没有甲），两边必须相等
  const cum = buildCumulative({
    prevCumulative: { group: { issueCount: 3 }, members: { 乙: { presentWeeks: 3, metWeeks: 3, recentWeeks: [] } } },
    memberStats: [memberStat('甲'), memberStat('乙')],
    config: { sportNickname: {}, met: {} },
    issueNo: 4,
  });
  assert.equal(cum.members.甲.presentWeeks, scanned.get('甲'), '兜底扫描与链式累加必须同口径');
  assert.equal(cum.members.乙.presentWeeks, scanned.get('乙'));
});
