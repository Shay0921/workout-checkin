#!/usr/bin/env node
/**
 * 运动打卡周报渲染脚本：data.json + templates/template-mobile.html → 最终交付 HTML + 同名归档 JSON
 *
 * 用法：
 *   node render.mjs <data.json> [-o 输出.html]
 *
 * 职责（按顺序执行）：
 *   1. 读取模板与数据文件
 *   2. 从模板自动提取全部顶层占位符（剔除 HTML 注释与块内字段）
 *   3. 校验数据：缺失字段报错、多余字段警告（防拼写错误）；insights 契约校验（为空 / 条数不在 6-9 /
 *      固定栏目缺失 / 条件栏「连击动态」与 streakBreaks 不匹配 / 顺序错误 / 结构非法 /
 *      title 不是 4 字 / 与上期同栏骨架重合 ≥ 0.8，均报错，
 *      强制 AI 按 references/insight-writing.md §1 契约补写后再渲染）
 *   4. Handlebars 渲染（先剥离头部契约注释，交付 HTML 保持干净）
 *   5. 残留占位符检查（渲染结果中若仍有 {{ 说明数据/模板异常）
 *   6. 写出 HTML 文件
 *   7. 自动归档：渲染成功即终态，在 HTML 同目录写 <年>-issue<NN>.json（含最终 insights；
 *      data.json 同目录存在 records.json 时内嵌流水明细，供下期趋势与审计）
 *
 * 退出码：0 成功；1 失败（错误信息打印到 stderr）
 */
import Handlebars from './vendor/handlebars.cjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skeletonSimilarity } from './text-lint.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(SCRIPT_DIR, '../templates/template-mobile.html');

/** 保存图片文件名：<weekStart 年>-issue<NN>-<MM.DD>.png（与归档命名同源） */
export function formatSaveName(weekStart, issueNo) {
  const [year, month, day] = String(weekStart).split('-');
  return `${year}-issue${String(issueNo).padStart(2, '0')}-${month}.${day}.png`;
}

/**
 * insights 栏目契约（唯一真源）
 * 固定 6 栏按序排列；条件栏「连击动态」插在第 COND_INDEX 个固定栏之前。
 * 文档镜像（references §1.2、模板头部契约）由 test/insight-lint.test.mjs 逐字校验。
 */
export const INSIGHT_TITLES = ['达标快报', '趋势解读', '强度观察', '项目版图', '能量账本', '红包入池'];
export const COND_TITLE = '连击动态';
const COND_INDEX = 3; // 「项目版图」之前（强度观察之后）
/** 实际允许出现的顺序（含条件栏） */
export const CANONICAL_TITLES = [
  ...INSIGHT_TITLES.slice(0, COND_INDEX),
  COND_TITLE,
  ...INSIGHT_TITLES.slice(COND_INDEX),
];

/** 本地时区 YYYY-MM-DD HH:mm 格式化（禁 toISOString：UTC 日期会使东八区零点倒退一天） */
function fmtDateTime(d) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 解析命令行参数：data.json 路径 + 可选 -o 输出路径 */
function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0].startsWith('-')) {
    console.error('用法: node render.mjs <data.json> [-o 输出.html]');
    process.exit(1);
  }
  const dataPath = resolve(args[0]);
  let outPath = null;
  const oIdx = args.indexOf('-o');
  if (oIdx !== -1 && args[oIdx + 1]) {
    outPath = resolve(args[oIdx + 1]);
  }
  return { dataPath, outPath };
}

/**
 * 从模板源码提取全部顶层占位符根名（栈式解析，感知块上下文）
 *
 * 规则：{{#each x}} 会切换变量作用域（块内变量是子字段）；
 *       {{#if x}} 不切换作用域（块内变量仍属当前作用域）。
 * 因此仅当未处于任何 each 块内时，变量才计入顶层清单。
 * 忽略：{{@index}}、{{else}}、块关闭标签、HTML 注释内的字面量。
 *
 * @param {string} tpl 模板源码
 * @returns {Set<string>} 顶层变量名集合
 */
export function extractTopLevelVars(tpl) {
  // 先剔除 HTML 注释（契约注释里包含 {{var}} 字面量，不能计入校验清单）
  const cleaned = tpl.replace(/<!--[\s\S]*?-->/g, '');
  const vars = new Set();
  const stack = []; // 记录嵌套的块类型：'each' 切换作用域，'if'/'compare' 不切换
  const inEach = () => stack.includes('each');
  // each 切换变量作用域；if/compare/with 等不切换（块内变量仍属当前作用域）
  const SCOPE_BLOCKS = new Set(['each']);

  // 匹配：开块 {{#helper args}}、关块 {{/helper}}、{{else}}、简单变量 {{var}}/{{obj.field}}
  const tagRe =
    /\{\{#(\w+)\s+([^}]*?)\}\}|\{\{\/(\w+)\}\}|\{\{\s*else\s*\}\}|\{\{\s*([a-zA-Z]\w*)((?:\.\w+)*)\s*\}\}/g;

  let m;
  while ((m = tagRe.exec(cleaned)) !== null) {
    if (m[1]) {
      // 开块：首个参数若是简单变量名且在 any each 之外，计入顶层（如 {{#if foo}} 的 foo）
      const firstArg = (m[2].trim().split(/\s+/)[0] || '').split('.')[0];
      if (firstArg && /^[a-zA-Z]\w*$/.test(firstArg) && !inEach()) vars.add(firstArg);
      stack.push(SCOPE_BLOCKS.has(m[1]) ? 'each' : 'if');
    } else if (m[3]) {
      // 关块：弹栈
      stack.pop();
    } else if (m[4]) {
      // 简单变量：仅当不在任何 each 块内才是顶层字段
      if (!inEach()) vars.add(m[4]);
    }
    // {{else}} 与 {{@index}} 不匹配捕获组，自然跳过
  }
  return vars;
}

/**
 * 校验数据字段与模板占位符的一致性
 * @param {object} data 渲染数据
 * @param {Set<string>} required 模板要求的顶层字段
 * @returns {{missing: string[], extra: string[]}}
 */
// cumulative / spotlight 等扩展字段不进模板占位符，但属于 calc 合法输出，白名单豁免告警
// （export 供 test/render.test.mjs 做漂移守卫：白名单里的键必须是 calc 真实产出的字段）
export const EXTRA_FIELDS_WHITELIST = new Set([
  'cumulative', 'metSnapshot', 'spotlights', 'milestoneCelebrations',
  'efficiencyStar', 'progressStar', 'calorieKing', 'streakBreaks',
  'totalSessions', 'avgMinutesPerSession',
]);

export function validateData(data, required) {
  const keys = new Set(Object.keys(data));
  const missing = [...required].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !required.has(k) && !EXTRA_FIELDS_WHITELIST.has(k));
  return { missing, extra };
}

/**
 * 渲染结果残留占位符检查（计数用全部命中，展示时去重）
 * 正常数据下 Handlebars 会把所有 {{...}} 求值掉，残留说明数据字段类型异常（如对象被当字符串输出）。
 * @param {string} html 渲染结果
 * @returns {string[]} 命中的占位符文本（未去重，空数组 = 干净）
 */
export function findLeftoverPlaceholders(html) {
  return html.match(/\{\{[^}]*\}\}/g) || [];
}

/**
 * 取同目录下期号小于 current 的最大归档（跨年按数值期号比较）的 insights
 * @returns {Array|null} 无归档或解析失败返回 null
 */
function readPrevInsights(dir, currentIssueNo) {
  let best = null;
  for (const f of readdirSync(dir)) {
    const m = /^\d{4}-issue(\d{2,})\.json$/.exec(f); // 与 calc.findPrevReport 同口径：期号至少两位
    if (!m) continue;
    const no = Number(m[1]);
    if (no >= currentIssueNo) continue;
    if (!best || no > best.no) best = { no, path: resolve(dir, f) };
  }
  if (!best) return null;
  try {
    const ins = JSON.parse(readFileSync(best.path, 'utf-8')).insights;
    return Array.isArray(ins) ? ins : null;
  } catch {
    return null;
  }
}

/** 主流程 */
function main() {
  const { dataPath, outPath } = parseArgs(process.argv);
  // 归档/上期比对都发生在「输出 HTML 同目录」，提前算好。
  // 不带 -o 时默认落进 data.json 同级的 reports/：写别处等于本期从下期 calc 的账本里消失，
  // 且跨期骨架比对（readPrevInsights）也会因读不到上期归档而整块静默跳过。
  const outDir = outPath ? dirname(resolve(outPath)) : resolve(dirname(resolve(dataPath)), 'reports');

  // 1. 读取模板与数据
  const tplRaw = readFileSync(TEMPLATE_PATH, 'utf-8');
  let data;
  try {
    // 剥离 UTF-8 BOM：Windows 记事本 / PowerShell 默认会写入 BOM，JSON.parse 会报 Unexpected token
    data = JSON.parse(readFileSync(dataPath, 'utf-8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error(`✗ data.json 解析失败：${dataPath}`);
    console.error(`  原因：${e.message}`);
    console.error('  常见原因：补写 insights 时漏逗号/引号、括号不匹配、写盘截断，或保存成了带 UTF-8 BOM 的编码。');
    console.error('  请修正 JSON 语法后重跑；不要手工编辑报告 HTML 绕过本步（会被下次渲染覆盖）。');
    process.exit(1);
  }

  // 2. 提取模板占位符并校验数据
  const required = extractTopLevelVars(tplRaw);
  const { missing, extra } = validateData(data, required);
  if (missing.length > 0) {
    console.error(`✗ 数据缺失 ${missing.length} 个模板必需字段（见模板头部契约）：`);
    missing.forEach((k) => console.error(`  - ${k}`));
    process.exit(1);
  }
  if (extra.length > 0) {
    console.warn(`⚠ 数据含 ${extra.length} 个模板未引用的字段（请检查拼写或更新契约）：`);
    extra.forEach((k) => console.warn(`  - ${k}`));
  }

  // insights 契约校验（规则真源 references/insight-writing.md §1）：固定 6 栏 + 条件栏（断更时必插）+ 最多 2 条自由栏
  const KNOWN = new Set(CANONICAL_TITLES);
  const insights = data.insights;
  const hasBreaks = Array.isArray(data.streakBreaks) && data.streakBreaks.length > 0;
  const minCount = hasBreaks ? 7 : 6;
  if (!Array.isArray(insights) || insights.length === 0) {
    console.error('✗ insights 为空：请先由 AI 按 references/insight-writing.md §1 补写 6-9 条数据洞察到 data.json，再执行渲染');
    process.exit(1);
  }
  const badShape = insights.filter(
    (i) =>
      !i ||
      typeof i.title !== 'string' ||
      !i.title.trim() ||
      typeof i.content !== 'string' ||
      !i.content.trim()
  );
  if (badShape.length > 0) {
    console.error(
      `✗ insights 有 ${badShape.length} 条结构非法：每条必须为 {title, content} 且均为非空字符串（禁止纯字符串数组）`
    );
    process.exit(1);
  }
  // 标题版式统一 4 字（固定栏全部是 2+2 词组，自由栏自拟标题也必须凑成 4 字，
  // 否则一屏里 2 字与 5 字标题混排，卡片左侧标题列对不齐）
  const badTitleLen = insights.filter((i) => [...i.title.trim()].length !== 4);
  if (badTitleLen.length > 0) {
    const detail = badTitleLen.map((i) => `「${i.title.trim()}」${[...i.title.trim()].length}字`).join('、');
    console.error(`✗ insights 有 ${badTitleLen.length} 条 title 不是 4 字：${detail}`);
    console.error('  自由栏不要自拟 2-3/5 字标题，从 references/insight-writing.md §1.7 的 4 字候选里选');
    process.exit(1);
  }
  if (insights.length < minCount || insights.length > 9) {
    console.error(`✗ insights 为 ${insights.length} 条（契约：固定 6 栏${hasBreaks ? ' + 连击动态 1 栏（本期有断更）' : ''} + 最多 2 条自由栏，最少 ${minCount} 条），请修正 data.json 后重跑`);
    process.exit(1);
  }
  const missingTitles = INSIGHT_TITLES.filter((t) => !insights.some((i) => i.title === t));
  if (missingTitles.length > 0) {
    console.error(`✗ insights 缺少固定栏目：${missingTitles.join('、')}（固定 title 为枚举值，见 references/insight-writing.md §1.2）`);
    process.exit(1);
  }
  const hasCond = insights.some((i) => i.title === COND_TITLE);
  if (hasBreaks && !hasCond) {
    console.error(`✗ 本期存在断更（streakBreaks 非空）但 insights 缺少条件栏「${COND_TITLE}」，请插入到「项目版图」之前`);
    process.exit(1);
  }
  if (!hasBreaks && hasCond) {
    console.error(`✗ 本期无断更（streakBreaks 为空）但 insights 出现「${COND_TITLE}」：条件栏仅在断更时允许，避免凑数`);
    process.exit(1);
  }
  // 固定栏 + 条件栏的相对顺序校验（自由栏不参与）
  const seq = insights.map((i) => i.title).filter((t) => KNOWN.has(t));
  let last = -1;
  for (const t of seq) {
    const idx = CANONICAL_TITLES.indexOf(t);
    if (idx <= last) {
      console.error(`✗ insights 固定栏顺序错误：「${t}」应位于 ${CANONICAL_TITLES.join('→')} 中的正确位置`);
      process.exit(1);
    }
    last = idx;
  }

  // 跨期骨架比对：与上一期同栏几乎逐字复制 = 模式坍缩（规则见 references/insight-writing.md §0-3）
  if (existsSync(outDir)) {
    const prevIns = readPrevInsights(outDir, data.issueNo);
    if (prevIns) {
      const copied = [];
      const similar = [];
      for (const it of insights) {
        const p = prevIns.find((x) => x.title === it.title);
        if (!p) continue;
        const sim = skeletonSimilarity(it.content, p.content);
        if (sim >= 0.65) (sim >= 0.8 ? copied : similar).push({ title: it.title, sim });
      }
      if (copied.length > 0) {
        console.error(`✗ ${copied.length} 条 insight 与上期同栏几乎逐字相同（骨架重合 ≥ 0.8）：`);
        copied.forEach((c) => console.error(`  - 「${c.title}」重合 ${c.sim.toFixed(2)}`));
        console.error('  换视角或换句式后重跑；同一栏连续两期只改数字 = 模式坍缩（references/insight-writing.md §0-3）');
        process.exit(1);
      }
      if (similar.length > 0) {
        console.warn('⚠ 以下 insight 与上期同栏骨架较近（0.65–0.8），确认不是只换了数字：');
        similar.forEach((c) => console.warn(`  - 「${c.title}」重合 ${c.sim.toFixed(2)}`));
      }
    }
  }

  // 3. 剥离头部契约注释后渲染（契约仅供产数参考，不进入交付 HTML）
  const tplForRender = tplRaw.replace(
    /<!--\s*=+\s*[\r\n]+[\s\S]*?数据契约[\s\S]*?-->/,
    ''
  );
  // 序号 helper：@index 从 0 起，+1 后输出（数据洞察编号从 1 开始）
  Handlebars.registerHelper('inc', (v) => v + 1);
  // 小写 helper：数据驱动的 class 后缀必须全小写输出——html2canvas-pro 导出管线
  // 会把克隆 DOM 的 class 名归一为小写，驼峰类名在导出图中静默失效（详见模板头部契约）
  Handlebars.registerHelper('lower', (v) => String(v ?? '').toLowerCase());
  // 保存图片文件名 helper：按周期期号命名，避免浏览器端用当天日期导致与报告不对应
  Handlebars.registerHelper('saveName', formatSaveName);
  // 比较 helper：{{#compare a ">" b}}...{{/compare}}（支持 > >= < <= == !=）
  Handlebars.registerHelper('compare', (a, op, b, options) => {
    const cmp = {
      '>': a > b, '>=': a >= b, '<': a < b, '<=': a <= b,
      '==': a == b, '!=': a != b,
    };
    return cmp[op] ? options.fn(this) : options.inverse(this);
  });
  const template = Handlebars.compile(tplForRender);
  const html = template(data);

  // 4. 残留占位符检查（正常数据下不应出现任何 {{）
  const leftover = findLeftoverPlaceholders(html);
  if (leftover.length > 0) {
    console.error(`✗ 渲染结果残留 ${leftover.length} 处占位符（数据字段类型可能异常）：`);
    [...new Set(leftover)].forEach((s) => console.error(`  - ${s}`));
    process.exit(1);
  }

  // 5. 写出 HTML：默认与归档同名成对（reports/<年>-issue<NN>.html），不带 -o 也不会把账本写错地方
  const stem = `${data.weekStart.slice(0, 4)}-issue${String(data.issueNo).padStart(2, '0')}`;
  const finalOut = outPath || resolve(outDir, `${stem}.html`);

  // 5.5 试渲染保护：样例数据（*.sample.json）禁止把产物写进 reports/。
  //     归档写在「输出 HTML 同目录」，一旦落在 reports/ 会被下期 calc 当作上期，
  //     连带污染 cumulative / 连击 / 徽章，且事后无法分辨真假归档。
  if (/sample/i.test(basename(dataPath)) && basename(dirname(finalOut)) === 'reports') {
    console.error(`✗ 拒绝写盘：数据源为样例文件（${basename(dataPath)}），不得输出到 reports/`);
    console.error('  归档写在输出 HTML 的同目录（不带 -o 时即 <工作区>/reports/）；试渲染请用 -o 指到工作区之外，例如：');
    console.error('  -o /tmp/wc-preview/preview.html');
    process.exit(1);
  }

  mkdirSync(dirname(finalOut), { recursive: true });
  writeFileSync(finalOut, html, 'utf-8');

  console.log(`✓ 渲染完成：${finalOut}`);
  console.log(`  第 ${data.issueNo} 期 · ${data.weekStart} ~ ${data.weekEnd} · 红包 ¥${data.redPacketTotal}`);

  // 6. 自动归档：渲染成功即终态。归档 = 最终 data（含 AI 补写的 insights）+ records 流水明细；
  //    文件名与 HTML 同目录成对（同一 stem），下期 calc.mjs 读取做趋势对比
  const archivePath = resolve(dirname(finalOut), `${stem}.json`);
  // 6.1 归档目录体检：不带 -o 时默认已落 reports/，走到这里只可能是显式指到别处。
  //     calc 下期只读 <工作区>/reports/，落在别处等于本期从未存在——下期 calc 会直接拦下断链，
  //     硬加 --allow-missing-prev 放行则累计期数/连击/里程碑从下期起全部重置。
  //     样例数据的试渲染本来就指向 reports/ 之外（5.5 已挡住它进 reports/），不必重复提示。
  if (basename(dirname(finalOut)).toLowerCase() !== 'reports' && !/sample/i.test(basename(dataPath))) {
    console.warn(`⚠ 归档将写到 ${dirname(finalOut)}——目录名不是 reports/，下期 calc 读不到它，本期等于从账本里消失。`);
    console.warn('  下期 calc 会以「第 N 期找不到上期归档」拦下；若用 --allow-missing-prev 硬过，累计期数/连击/里程碑会从下期起全部重置。');
    console.warn('  正式出报请去掉 -o（默认写 <工作区>/reports/<年>-issue<NN>.html）或显式指向该路径；确认只是试渲染可忽略本提示。');
  }
  const archive = { ...data, archivedAt: fmtDateTime(new Date()) };
  const recordsPath = resolve(dirname(dataPath), 'records.json');
  if (existsSync(recordsPath)) {
    try {
      // records.json 是 AI 翻译产物，可能带 BOM：与 calc 读取口径保持一致
      archive.records = JSON.parse(readFileSync(recordsPath, 'utf-8').replace(/^\uFEFF/, ''));
    } catch {
      console.warn('⚠ records.json 解析失败，归档未内嵌流水明细');
    }
  }
  if (existsSync(archivePath)) {
    console.warn(`⚠ 归档已存在，覆盖写入（补算场景）：${archivePath}`);
  }
  writeFileSync(archivePath, JSON.stringify(archive, null, 2) + '\n', 'utf-8');
  console.log(`✓ 归档完成：${archivePath}`);
}

// 作为脚本执行时跑主流程；被测试 import（取栏目契约）时不执行
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
