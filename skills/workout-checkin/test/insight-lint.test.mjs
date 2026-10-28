/**
 * render 的 insights 版式契约（跨期骨架复制 / title 字数 / 栏目枚举）
 *
 * 规则真源：references/insight-writing.md §0-3（不复用骨架）、§1.7（title 一律 4 字）
 * 这两类都靠人眼抽查发现不了，必须由脚本拦。
 *
 * 栏目名一律从 render.mjs 的契约常量导入，测试里不写字面量：改名只需改常量与文档，
 * 测试不会因为「名字变了」而红——只会在「契约与文档不一致」时红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { INSIGHT_TITLES, COND_TITLE, CANONICAL_TITLES } from '../scripts/render.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = resolve(ROOT, 'scripts/render.mjs');
const SAMPLE = JSON.parse(readFileSync(resolve(ROOT, 'assets/data.sample.json'), 'utf-8'));
const DOC = readFileSync(resolve(ROOT, 'references/insight-writing.md'), 'utf-8');

/** 以样例为底，替换 insights 后渲染一次 */
function renderWith(insights, { issueNo = 2, prevInsights = null } = {}) {
  const ws = mkdtempSync(resolve(tmpdir(), 'wc-lint-'));
  const outDir = resolve(ws, 'reports');
  mkdirSync(outDir, { recursive: true });
  if (prevInsights) {
    writeFileSync(
      resolve(outDir, `2026-issue${String(issueNo - 1).padStart(2, '0')}.json`),
      JSON.stringify({ issueNo: issueNo - 1, insights: prevInsights }, null, 2),
      'utf-8'
    );
  }
  const dataPath = resolve(ws, 'data.json');
  writeFileSync(dataPath, JSON.stringify({ ...SAMPLE, issueNo, insights }, null, 2), 'utf-8');
  const r = spawnSync(process.execPath, [RENDER, dataPath, '-o', resolve(outDir, 'x.html')], {
    encoding: 'utf-8',
  });
  rmSync(ws, { recursive: true, force: true });
  return r;
}

/** 把某一栏换成指定文案（取第 1 个固定栏，断言只关心「开头能不能这么写」） */
const FIRST = INSIGHT_TITLES[0];
const withCol = (title, content) =>
  SAMPLE.insights.map((i) => (i.title === title ? { ...i, content } : i));

test('数据开头 → 通过（周报常态是数据在前）', () => {
  const r = renderWith(withCol(FIRST, '10 人全员达标（100%），压线过的只有两个人。'));
  assert.equal(r.status, 0, r.stderr);
});

test('金额开头 → 通过（只拦骨架复制）', () => {
  const r = renderWith(withCol(FIRST, '¥40 换来的能量只够一顿早饭。'));
  assert.equal(r.status, 0, r.stderr);
});

test('「本期 X 为 N」句式 → 通过（只拦骨架重合）', () => {
  const r = renderWith(withCol(FIRST, '本期达标为 3 人，比上期少两个。'));
  assert.equal(r.status, 0, r.stderr);
});

test('文案检查：与上期同栏逐字复制 → 报错（骨架重合 ≥ 0.8）', () => {
  // 上一期把同样 7 条原样写了一遍（只改数字也会被骨架归一化抓住）
  const prev = SAMPLE.insights.map((i) => ({ ...i }));
  const r = renderWith(
    SAMPLE.insights.map((i) => ({ ...i, content: i.content.replace(/\d+/, (d) => String(+d + 1)) })),
    { prevInsights: prev }
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /逐字相同|骨架重合/);
});

test('文案检查：无上期归档时不做跨期比对（首期不误报）', () => {
  const r = renderWith(SAMPLE.insights);
  assert.equal(r.status, 0, r.stderr);
});

// 标题版式：固定 6 栏 + 条件栏 + 自由栏一律 4 字（2+2 词组）。
// 夹具用合成字串，不复用任何实际栏目名——换名不该让测试失效。
const FREE_TITLE = '自拟四字'; // 任意 4 字自由栏标题

test('title 长度：3 字标题 → 报错', () => {
  const r = renderWith([...SAMPLE.insights, { title: '三字栏', content: '全群单期消耗刷新峰值。' }]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /title 不是 4 字/);
  assert.match(r.stderr, /三字栏」3字/);
});

test('title 长度：2 字与 5 字标题 → 报错', () => {
  const two = renderWith([...SAMPLE.insights, { title: '两字', content: '两位压线成员只差一次，下周补上。' }]);
  assert.equal(two.status, 1);
  assert.match(two.stderr, /两字」2字/);
  const five = renderWith([...SAMPLE.insights, { title: '五个字的栏', content: '入秋后户外项目会往室内迁移。' }]);
  assert.equal(five.status, 1);
  assert.match(five.stderr, /五个字的栏」5字/);
});

test('title 长度：4 字自由栏标题 → 通过', () => {
  const r = renderWith([...SAMPLE.insights, { title: FREE_TITLE, content: '两位压线成员只差一次，下周补上。' }]);
  assert.equal(r.status, 0, r.stderr);
});

test('文档契约：§1.7 动态扩展池的候选 title 全部 4 字', () => {
  // 从规则文档读取候选清单，不做硬编码——文档改回 2/3/5 字时这里会红
  const doc = readFileSync(resolve(ROOT, 'references/insight-writing.md'), 'utf-8');
  const section = doc.split('### 1.7')[1].split('\n### ')[0];
  const candidates = section
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .slice(2) // 去掉表头与分隔行
    .map((l) => l.split('|')[1].trim())
    .filter(Boolean);
  assert.ok(candidates.length >= 3, `未能从 §1.7 解析出候选 title（实际 ${candidates.length} 条）`);
  const bad = candidates.filter((t) => [...t].length !== 4);
  assert.deepEqual(bad, [], `候选 title 必须 4 字：${bad.join('、')}`);
});

test('文档契约：§1.2 固定栏目与 render 常量逐字同序', () => {
  // 文档自称「单一真源为 render.mjs 的枚举，本表为镜像」——镜像是否同步由这条用例守
  const section = DOC.split('### 1.2')[1].split('\n### ')[0];
  const fromDoc = section
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .slice(2) // 去掉表头与分隔行
    .map((l) => l.split('|')[2].trim())
    .filter(Boolean);
  assert.deepEqual(fromDoc, INSIGHT_TITLES, '§1.2 的固定栏目与 render.mjs 的 INSIGHT_TITLES 不一致');
});

test('文档契约：§1.6 条件栏名与 render 常量一致', () => {
  assert.ok(DOC.includes(COND_TITLE), `§1 未出现条件栏名「${COND_TITLE}」`);
  const section = DOC.split('### 1.6')[1].split('\n## ')[0];
  assert.ok(section.includes(COND_TITLE), '§1.6 的条件栏名与常量不一致');
});

test('样例数据：固定栏 + 条件栏按契约顺序出现', () => {
  const present = SAMPLE.insights.map((i) => i.title).filter((t) => CANONICAL_TITLES.includes(t));
  assert.deepEqual(present, CANONICAL_TITLES, 'data.sample.json 的固定栏顺序与契约不一致');
});

test('文案检查：正常改写（判据不同的同题材）→ 通过', () => {
  const prev = SAMPLE.insights.map((i) => ({ ...i }));
  // 栏目名取自契约；文案全是新写的判断句，与样例无骨架关系
  const contents = [
    '门槛这周咬得紧，压线过的人比上周多两个。',
    '热闹回到人头上，不再是靠项目铺开撑场面。',
    '高强度只剩游泳在扛，其余都在往下走。',
    '小张那一档连击这周断了，重启键在下次打卡里。',
    '版图收窄到五种，前三之外几乎没人碰。',
    '四杯半珍珠奶茶的量，摊到五个人身上等于白练两天。',
    '罚款面收窄，账本却没跟着松。',
  ];
  const fresh = CANONICAL_TITLES.map((title, i) => ({ title, content: contents[i] }));
  const r = renderWith(fresh, { prevInsights: prev });
  assert.equal(r.status, 0, r.stderr);
});
