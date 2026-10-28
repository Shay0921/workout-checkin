#!/usr/bin/env node
/**
 * preflight.mjs — 运行前置体检（Step 0）
 *
 * 用法：
 *   node preflight.mjs [--members members.json] [--workspace <工作区目录，默认当前目录>]
 *
 * 作用：在翻译接龙、跑 calc 之前，一次性确认「能不能开工」：
 *   1. members.json 是否存在（默认 <工作区>/members.json；不存在 = 首次使用 → 退出码 2，提示走 Step 2.5 初始化）
 *   2. 配置键是否齐全、类型是否合法、占位符是否已替换；convert / defaultWeightKg 也在此拦下，避免 calc 遇到 floor/km/count 或缺体重时抛裸 TypeError
 *   3. 成员/别名是否冲突（按归一化后的 key 检查重复昵称、别名撞车）
 *   4. met 与 sportAlias / sportNickname / intensityOverride 是否自洽
 *   5. 渲染依赖 handlebars 是否内嵌完整（scripts/vendor/handlebars.cjs）
 *   6. 工作区 reports/ 归档现状（信息项，不阻塞）
 *
 * 退出码：
 *   0 = 可开工
 *   1 = 配置有错，需修 members.json 后重跑
 *   2 = 首次使用，需先初始化 members.json（Step 2.5）
 *
 * 设计约束：单命令、无 shell 依赖、纯 Node、正斜杠路径，Mac/Windows/Linux 一致。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeName } from './nickname.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(SCRIPT_DIR, '..');
const LEGACY_MEMBERS_PATH = resolve(SKILL_DIR, 'members.json');

const OK = '✓';
const BAD = '✗';
const WARN = '⚠';

const results = [];
const add = (level, msg) => results.push({ level, msg });
const ok = (msg) => add('ok', msg);
const bad = (msg) => add('bad', msg);
const warn = (msg) => add('warn', msg);
const info = (msg) => add('info', msg);

function parseArgs(argv) {
  const args = argv.slice(2);
  const getOpt = (name) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : null;
  };
  return {
    membersPath: getOpt('--members'),
    workspace: getOpt('--workspace'),
  };
}

/** 日期解析：真实日历存在性（月日可不补零，2026-3-5 = 2026-03-05；本地时区，禁用 toISOString 反推） */
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isPositiveNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** 检查 members.json 的结构与自洽性；不抛异常，全部落到 results */
function checkConfig(config) {
  // ── group
  if (!isNonEmptyString(config.group)) {
    bad('group 缺失或为空（应为群名）');
  } else if (config.group.includes('示例群名')) {
    bad(`group 仍是示例占位符：${config.group}`);
  } else {
    ok(`group：${config.group}`);
  }

  // ── weekRule
  const minCheckins = config.weekRule?.minCheckins;
  if (!Number.isInteger(minCheckins) || minCheckins < 1) {
    bad('weekRule.minCheckins 必须是 ≥1 的整数');
  } else {
    ok(`weekRule.minCheckins = ${minCheckins}`);
  }
  if (config.weekRule?.cycle && config.weekRule.cycle !== 'Mon-Sun') {
    warn(`weekRule.cycle = ${config.weekRule.cycle}（脚本按 Mon-Sun 计算，非此值可能不符预期）`);
  }

  // ── periodConfig 锚点
  const pc = config.periodConfig || {};
  if (!Number.isInteger(pc.anchorIssue) || pc.anchorIssue < 1) {
    bad('periodConfig.anchorIssue 必须是 ≥1 的整数');
  }
  const start = parseDate(pc.anchorWeekStart);
  const end = parseDate(pc.anchorWeekEnd);
  if (!start) {
    bad(`periodConfig.anchorWeekStart 非法：${pc.anchorWeekStart}（需 YYYY-MM-DD 且是真实日期，占位符未替换）`);
  }
  if (!end) {
    bad(`periodConfig.anchorWeekEnd 非法：${pc.anchorWeekEnd}（需 YYYY-MM-DD 且是真实日期，占位符未替换）`);
  }
  if (start && end) {
    const spanDays = Math.round((end - start) / 86400000);
    const isFirstShortWeek = pc.anchorIssue === 1 && spanDays < 6 && end.getDay() === 0;
    if (end < start) {
      bad('periodConfig 锚点 end 早于 start');
    } else if (spanDays !== 6 && !isFirstShortWeek) {
      warn(`periodConfig 锚点跨度 ${spanDays + 1} 天（应为周一~周日共 7 天），期号与周窗口可能错位`);
    } else if (isFirstShortWeek) {
      ok(`期号锚点：第 1 期为首期短周 ${pc.anchorWeekStart} ~ ${pc.anchorWeekEnd}（起于周内、止于周日）`);
    } else {
      ok(`期号锚点：第 ${pc.anchorIssue} 期 = ${pc.anchorWeekStart} ~ ${pc.anchorWeekEnd}`);
    }
  }

  // ── defaultWeightKg（成员 weightKg 可缺省，但必须有正数默认值兜底）
  if (!isPositiveNumber(config.defaultWeightKg)) {
    bad('defaultWeightKg 缺失或非正数（成员未填 weightKg 时按此默认体重换算）');
  } else {
    ok(`defaultWeightKg = ${config.defaultWeightKg}`);
  }

  // ── convert：量纲换算系数必须在体检阶段拦下，避免 calc 遇到 floor/km/count 才抛裸 TypeError
  const convert = config.convert;
  if (!convert || typeof convert !== 'object' || Array.isArray(convert)) {
    bad('convert 缺失或不是对象（至少需要 climbPerFloorMin / kmPerMin）');
  } else {
    const convertProblems = [];
    if (!isPositiveNumber(convert.climbPerFloorMin)) {
      convertProblems.push('climbPerFloorMin 缺失或非正数（floor 单位无法换算）');
    }
    if (!convert.kmPerMin || typeof convert.kmPerMin !== 'object' || Array.isArray(convert.kmPerMin)) {
      convertProblems.push('kmPerMin 缺失或不是对象（km 单位无法按项目换算）');
    } else {
      const badKm = Object.entries(convert.kmPerMin)
        .filter(([, v]) => !isPositiveNumber(v))
        .map(([k]) => k);
      if (badKm.length > 0) {
        convertProblems.push(`kmPerMin 中这些项目的值不是正数：${badKm.join('、')}`);
      }
      const unknownKm = Object.keys(convert.kmPerMin).filter((k) => !Object.hasOwn(config.met || {}, k));
      if (unknownKm.length > 0) {
        warn(`convert.kmPerMin 中这些项目不在 met：${unknownKm.join('、')}`);
      }
    }
    if (convert.minPerCount !== undefined) {
      if (!convert.minPerCount || typeof convert.minPerCount !== 'object' || Array.isArray(convert.minPerCount)) {
        convertProblems.push('minPerCount 不是对象（count 单位无法按项目换算）');
      } else {
        const badCount = Object.entries(convert.minPerCount)
          .filter(([, v]) => !isPositiveNumber(v))
          .map(([k]) => k);
        if (badCount.length > 0) {
          convertProblems.push(`minPerCount 中这些项目的值不是正数：${badCount.join('、')}`);
        }
        const unknownCount = Object.keys(convert.minPerCount).filter((k) => !Object.hasOwn(config.met || {}, k));
        if (unknownCount.length > 0) {
          warn(`convert.minPerCount 中这些项目不在 met：${unknownCount.join('、')}`);
        }
      }
    }
    const knownConvertKeys = ['climbPerFloorMin', 'kmPerMin', 'minPerCount'];
    const strayKeys = Object.keys(convert).filter((k) => !knownConvertKeys.includes(k));
    if (strayKeys.length > 0) {
      warn(`convert 中这些键不会被读取（写了也不生效）：${strayKeys.join('、')}——公里/个数的系数请写进 kmPerMin / minPerCount 的项目键`);
    }
    if (convertProblems.length > 0) {
      bad(`convert 配置有问题（${convertProblems.length} 处）：${convertProblems.join('；')}`);
    } else {
      const kmCount = convert.kmPerMin ? Object.keys(convert.kmPerMin).length : 0;
      const countCount = convert.minPerCount ? Object.keys(convert.minPerCount).length : 0;
      ok(`convert 可用：爬楼 ${convert.climbPerFloorMin}min/层 · km ${kmCount} 项 · count ${countCount} 项`);
    }
  }

  // ── met
  const met = config.met;
  const metKeys = met && typeof met === 'object' && !Array.isArray(met) ? Object.keys(met) : [];
  if (metKeys.length === 0) {
    bad('met 缺失或为空（至少要有群内实际运动项目）');
  } else {
    const badMet = metKeys.filter((k) => !isPositiveNumber(met[k]));
    if (badMet.length > 0) {
      bad(`met 中这些项目的值不是正数：${badMet.join('、')}`);
    } else {
      ok(`met ${metKeys.length} 项`);
    }
  }

  // ── members
  const members = Array.isArray(config.members) ? config.members : null;
  if (!members || members.length === 0) {
    bad('members 缺失或为空数组（至少要有 1 名成员）');
  } else {
    const activeCount = members.filter((m) => m?.status === 'active').length;
    const problems = [];
    members.forEach((m, i) => {
      const tag = `members[${i}]`;
      if (!isNonEmptyString(m?.nickname)) {
        problems.push(`${tag}.nickname 缺失`);
        return;
      }
      if (m.nickname.includes('示例成员')) problems.push(`${tag}.nickname 仍是示例占位符`);
      if (m.status !== 'active' && m.status !== 'left') problems.push(`${tag}.status = ${m.status}（只允许 active / left）`);
      if (m.weightKg !== undefined && m.weightKg !== null && !isPositiveNumber(m.weightKg)) {
        problems.push(`${tag}.weightKg 存在但不是正数`);
      } else if ((m.weightKg === undefined || m.weightKg === null) && !isPositiveNumber(config.defaultWeightKg)) {
        problems.push(`${tag}.weightKg 缺失，且 defaultWeightKg 未配置正数默认值`);
      }
      if (m.aliases !== undefined && (!Array.isArray(m.aliases) || m.aliases.some((a) => typeof a !== 'string'))) {
        problems.push(`${tag}.aliases 必须是字符串数组`);
      }
      if (m.gender !== undefined && !['男', '女', ''].includes(m.gender)) {
        problems.push(`${tag}.gender = ${m.gender}（只允许 男 / 女 / 空字符串）`);
      }
    });
    if (problems.length > 0) {
      bad(`成员字段有问题（${problems.length} 处）：${problems.slice(0, 6).join('；')}${problems.length > 6 ? ' …' : ''}`);
    } else {
      ok(`members ${members.length} 人（active ${activeCount} / left ${members.length - activeCount}）`);
    }

    // 昵称重复 / 别名撞车（必须按归一化后的 key 比较：emoji、波浪号、空格、大小写会在匹配前被剥离）
    // calc 的精确匹配是「首个命中」，历史 cumulative 归并也依赖同一索引；归一后撞车会静默算到同一人。
    const nameOwner = new Map(); // 归一化 key → 首次声明者
    const conflicts = new Set();
    members.forEach((m) => {
      if (!isNonEmptyString(m?.nickname)) return;
      const names = [
        { raw: m.nickname, kind: 'nickname' },
        ...(Array.isArray(m.aliases) ? m.aliases : []).map((a) => ({ raw: String(a), kind: 'alias' })),
      ];
      for (const { raw, kind } of names) {
        const key = normalizeName(raw);
        if (!key) continue;
        const prev = nameOwner.get(key);
        if (!prev) {
          nameOwner.set(key, { nickname: m.nickname, raw, kind });
          continue;
        }
        if (prev.nickname === m.nickname) continue;
        conflicts.add(
          kind === 'nickname' && prev.kind === 'nickname'
            ? `昵称归一后重复：「${prev.raw}」与「${raw}」去掉 emoji/符号/空格后相同，记录无法区分归属`
            : `昵称/别名归一后撞车：「${prev.raw}」（属于「${prev.nickname}」）与「${raw}」（属于「${m.nickname}」）归一化后相同`
        );
      }
    });
    if (conflicts.size > 0) for (const msg of conflicts) bad(msg);
    else ok('昵称/别名无冲突（含归一化）');
  }

  // ── sportAlias：必须按「键/值是否在 met」四象限判定
  //
  // resolveSport 的匹配顺序是「先直查 met，再走别名双向」：
  //   ① 键在 met、值也在 met → raw 无论写键还是写值，都在直查阶段被截胡，这条别名永不生效（死别名）
  //   ② 键在 met、值不在 met → 正常别名（值归一为键）
  //   ③ 键不在 met、值在 met → 合法的反向映射（raw 写键 → 返回值为名，如「爬楼梯」→「爬楼」）
  //   ④ 键值都不在 met → 永不命中（纯死配置）
  // 只校验键（旧逻辑）会漏掉 ①，而 ① 正是「想归并却静默拆成两个项目」的成因。
  if (config.sportAlias && typeof config.sportAlias === 'object') {
    const metSet = new Set(metKeys);
    const dead = [];
    const orphan = [];
    const reverse = [];
    const shadowedReverse = [];
    const badShape = [];
    const owner = new Map(); // 别名 → 声明它的标准名
    const dup = [];
    let pairCount = 0;

    for (const [std, alias] of Object.entries(config.sportAlias)) {
      const cands = Array.isArray(alias) ? alias : [alias];
      if (cands.length === 0 || cands.some((a) => !isNonEmptyString(a))) {
        badShape.push(std);
        continue;
      }
      // 反向映射（键不在 met）靠「raw === 键」命中，而 resolveSport 命中即 return，
      // 所以同一键下只有第一个「值在 met」的候选生效，其余都是死别名。
      let reverseTaken = false;
      for (const a of cands) {
        pairCount += 1;
        if (owner.has(a) && owner.get(a) !== std) dup.push(`「${a}」同时挂在「${owner.get(a)}」与「${std}」下`);
        else owner.set(a, std);

        const keyInMet = metSet.has(std);
        const valInMet = metSet.has(a);
        if (keyInMet && valInMet) dead.push(`「${std} ← ${a}」`);
        else if (!keyInMet && !valInMet) orphan.push(`「${std} ← ${a}」`);
        else if (!keyInMet && valInMet) {
          if (reverseTaken) shadowedReverse.push(`「${std} ← ${a}」`);
          else {
            reverse.push(`「${std} ← ${a}」`);
            reverseTaken = true;
          }
        }
      }
    }

    // 两跳歧义：某组的键同时是另一组的别名，且该键不在 met → raw 命中顺序取决于对象顺序
    for (const [std, alias] of Object.entries(config.sportAlias)) {
      if (metSet.has(std) || !owner.has(std)) continue;
      if (owner.get(std) !== std) {
        warn(`sportAlias「${std}」既是本组键、又是「${owner.get(std)}」的别名（且不在 met）：命中哪个取决于对象顺序，建议合并成一组`);
      }
    }

    if (badShape.length > 0) bad(`sportAlias 这些键的别名不是非空字符串或字符串数组：${badShape.join('、')}`);
    if (dead.length > 0) {
      bad(`sportAlias 有 ${dead.length} 条死别名（值本身也是 met 条目，直查先命中 → 永不生效）：${dead.join('、')}`);
      warn('  若要归并：从 met 删掉别名那一项，只保留标准名；若要两个项目独立：删掉这条别名');
    }
    if (orphan.length > 0) {
      bad(`sportAlias 有 ${orphan.length} 条键值都不在 met（永不命中）：${orphan.join('、')}`);
    }
    if (dup.length > 0) {
      bad(`sportAlias 同一别名被多个项目声明（按对象顺序静默取首个）：${dup.join('；')}`);
    }
    if (shadowedReverse.length > 0) {
      bad(`sportAlias 有 ${shadowedReverse.length} 条反向映射被同组前项截胡（永不生效）：${shadowedReverse.join('、')}`);
      warn('  同一键只保留一个「值在 met」的候选；要并列多个别名，把标准名放键、其余放值');
    }
    if (reverse.length > 0) {
      ok(`sportAlias 反向映射 ${reverse.length} 条（合法，但建议改成「标准名 ← 别名」的正向写法）：${reverse.join('、')}`);
    }
    if (dead.length === 0 && orphan.length === 0 && dup.length === 0 && badShape.length === 0 && shadowedReverse.length === 0) {
      const groups = Object.keys(config.sportAlias).length;
      ok(`sportAlias ${groups} 组共 ${pairCount} 条别名，全部可命中`);
    }
  }

  // ── sportNickname：覆盖率仅告警（缺了只是没有专精标签）
  if (config.sportNickname && typeof config.sportNickname === 'object') {
    const missing = metKeys.filter((k) => !isNonEmptyString(config.sportNickname[k]));
    if (missing.length > 0) {
      warn(`${missing.length} 个项目没有 sportNickname（只是缺专精昵称，不影响计算）：${missing.join('、')}`);
    } else {
      ok(`sportNickname ${Object.keys(config.sportNickname).length} 项（覆盖全部 met）`);
    }
  }

  // ── intensityOverride
  if (config.intensityOverride && typeof config.intensityOverride === 'object') {
    const keys = Object.keys(config.intensityOverride);
    const badLevel = keys.filter((k) => !['high', 'mid', 'low'].includes(config.intensityOverride[k]));
    if (badLevel.length > 0) {
      bad(`intensityOverride 档位非法（只允许 high/mid/low）：${badLevel.join('、')}`);
    }
    const unknown = keys.filter((k) => !metKeys.includes(k));
    if (unknown.length > 0) {
      warn(`intensityOverride 这些键不在 met 中：${unknown.join('、')}`);
    }
    if (badLevel.length === 0 && unknown.length === 0) {
      ok(`intensityOverride ${keys.length} 项（${keys.map((k) => `${k}→${config.intensityOverride[k]}`).join('、')}）`);
    }
  }

  // ── leaveKeywords
  if (!Array.isArray(config.leaveKeywords) || config.leaveKeywords.filter(isNonEmptyString).length === 0) {
    warn('leaveKeywords 为空或非数组（请假将无法自动识别）');
  } else {
    ok(`leaveKeywords ${config.leaveKeywords.length} 个`);
  }

  // ── redPacket
  const rp = config.redPacket || {};
  if (!Number.isFinite(rp.zeroOrOne) || !Number.isFinite(rp.two)) {
    warn('redPacket.zeroOrOne / two 缺失或非数字（红包档位会异常）');
  } else {
    ok(`红包档位：0-1 次 ¥${rp.zeroOrOne} / 差 1 次 ¥${rp.two}`);
  }

  // ── badges：各徽章层级须为正数升序；连击最后一档应为 30（之后等级自动延伸）
  const badges = config.badges || {};
  const badTiers = [];
  for (const [key, tiers] of Object.entries(badges)) {
    const valid =
      Array.isArray(tiers) &&
      tiers.length > 0 &&
      tiers.every((t) => Number.isFinite(t) && t > 0) &&
      tiers.every((t, i) => i === 0 || t > tiers[i - 1]);
    if (!valid) badTiers.push(key);
  }
  if (badTiers.length > 0) {
    bad(`badges 层级须为非空、正数、严格升序数组：${badTiers.join('、')}`);
  } else if (Object.keys(badges).length > 0) {
    ok(`badges ${Object.keys(badges).length} 类徽章层级合法`);
  }
  const streakTiers = badges.streak;
  if (Array.isArray(streakTiers) && streakTiers.length > 0) {
    const finalTier = streakTiers[streakTiers.length - 1];
    if (finalTier !== 30) {
      warn(`badges.streak 最后一档是 ${finalTier}，建议设为 30：30 周起胶囊固定真金火炼，成就等级会自动每 +10 周 +1 Lv，无需额外 40 档`);
    } else {
      ok('badges.streak 30 周封顶（之后成就等级自动延伸）');
    }
  }
}

function checkDependency() {
  // handlebars 已内嵌为 scripts/vendor/handlebars.cjs（零安装，随 skill 目录整体迁移不断链）
  const vendor = join(SKILL_DIR, 'scripts', 'vendor', 'handlebars.cjs');
  if (existsSync(vendor)) {
    ok('渲染依赖 handlebars 已内嵌（scripts/vendor/）');
  } else {
    bad(`渲染依赖缺失：${vendor} 不存在（skill 目录不完整，请重新获取完整 skill）`);
  }
}

function checkWorkspace(workspaceDir) {
  if (!workspaceDir) return;
  const reportsDir = join(workspaceDir, 'reports');
  if (!existsSync(reportsDir)) {
    info(`工作区 reports/ 不存在：${reportsDir}（首次渲染会自动创建，本期按首期兜底）`);
    return;
  }
  let files = [];
  let misnamed = [];
  try {
    // 归档名口径必须和 calc/render 完全一致：<年>-issue<NN>.json（期号至少两位补零）。
    // 单位号（2026-issue7.json）三个脚本都看不见——calc 下期直接报「找不到上期归档」，
    // 而这里若按 \d+ 计数还会谎报「已有 N 期归档」，所以单独点名要求改名。
    for (const f of readdirSync(reportsDir)) {
      const m = /^\d{4}-issue(\d+)\.json$/.exec(f);
      if (!m) continue;
      const want = String(Number(m[1])).padStart(2, '0');
      if (m[1] === want) files.push(f);
      else misnamed.push([f, f.replace(`issue${m[1]}.json`, `issue${want}.json`)]);
    }
  } catch {
    warn(`无法读取 reports/：${reportsDir}`);
    return;
  }
  for (const [f, want] of misnamed) {
    bad(`reports/${f} 期号未补零：calc 找上期只认 ${want}，这份归档等于不存在（下期会报断链）→ 改名后重跑体检`);
  }
  if (files.length === 0) {
    info('reports/ 内暂无归档（本期按首期兜底：无趋势对比、无回归欢迎）');
  } else {
    // 期号连续性：calc 找上期只认「期号 −1」那一份，中间缺一环要等到补算那一期才报错，
    // 而那时接龙往往已经翻译完（体检的意义就是别让用户白干）。出下一期只需要最后一环，
    // 所以缺口只告警不拦：影响的是补算，不是本期。
    // 期号跨年是全局递增的（2027 年接着 2026 的号往后排），故按号排序查缺口、不按年分组；
    // 同号跨年（换账本重新起链）是合法的，去重后不算缺口。
    const nos = [...new Set(files.map((f) => Number(/^\d{4}-issue(\d{2,})\.json$/.exec(f)[1])))].sort((a, b) => a - b);
    const holes = [];
    for (let i = 1; i < nos.length; i++) {
      for (let n = nos[i - 1] + 1; n < nos[i]; n++) holes.push(n);
    }
    ok(`reports/ 已有 ${files.length} 期归档（第 ${nos[0]}~${nos[nos.length - 1]} 期，可用于趋势对比）`);
    if (holes.length > 0) {
      warn(
        `归档期号有缺口：缺第 ${holes.join('、')} 期——出下一期不受影响（只读最后一环），但补算缺口后面那一期时 calc 会以「第 N 期找不到上期归档」拦下，届时要么先补齐缺的那期，要么由用户明示 --allow-missing-prev 断链重来`
      );
    }
  }
  const recordsPath = join(workspaceDir, 'records.json');
  if (!existsSync(recordsPath)) {
    info('records.json 尚未生成（Step 1 翻译接龙后才有）');
  }
}

function countBy(level) {
  return results.filter((r) => r.level === level).length;
}

function main() {
  const { membersPath: membersOpt, workspace } = parseArgs(process.argv);
  // 配置随工作区走：默认读 <工作区>/members.json；--workspace 缺省 = 当前目录
  const workspaceDir = workspace ? resolve(workspace) : process.cwd();
  const membersPath = membersOpt ? resolve(membersOpt) : resolve(workspaceDir, 'members.json');

  console.log('运动打卡 skill · 前置体检');
  console.log('────────────────────────────');
  console.log(`skill   ：${SKILL_DIR}`);
  console.log(`工作区  ：${workspaceDir}`);
  console.log(`配置    ：${membersPath}`);
  console.log('────────────────────────────');

  // 1. 配置文件存在性 —— 这是「是否首次使用」的唯一判断依据
  if (!existsSync(membersPath)) {
    console.log(`${BAD} 未找到 members.json：${membersPath}`);
    if (existsSync(LEGACY_MEMBERS_PATH) && LEGACY_MEMBERS_PATH !== membersPath) {
      console.log(`  ${WARN} 检测到旧版配置：${LEGACY_MEMBERS_PATH}`);
      console.log(`     请迁移到 ${membersPath}（新版本不再默认读取 skill 目录内配置）。`);
    }
    console.log('────────────────────────────');
    console.log('结论：首次使用，先初始化配置（Step 2.5）');
    console.log('  1. 读结构模板：assets/members.sample.json');
    console.log('  2. 按提问清单收集：assets/members.sample.md');
    console.log(`  3. 写入 ${membersPath} 后重跑本体检`);
    process.exit(2);
  }
  ok('members.json 存在');

  // 2. 解析
  let config;
  try {
    // 剥离 UTF-8 BOM：与 calc/personal 同一口径，避免「体检报错但 calc 能跑」的不一致
    config = JSON.parse(readFileSync(membersPath, 'utf-8').replace(/^\uFEFF/, ''));
  } catch (e) {
    bad(`JSON 解析失败：${e.message}`);
    report();
    process.exit(1);
  }
  ok('JSON 可解析');

  checkConfig(config);
  checkDependency();
  checkWorkspace(workspace || !membersOpt ? workspaceDir : null);

  report();

  if (countBy('bad') > 0) {
    console.log(`结论：有 ${countBy('bad')} 处 ✗ 必须先修（配置类改 members.json，归档命名类改 reports/ 里的文件名）→ 修完重跑本体检`);
    process.exit(1);
  }
  console.log('结论：可开工 → Step 1 翻译接龙');
  process.exit(0);
}

function report() {
  for (const r of results) {
    const icon = r.level === 'bad' ? BAD : r.level === 'warn' ? WARN : r.level === 'info' ? '·' : OK;
    console.log(`${icon} ${r.msg}`);
  }
  console.log('────────────────────────────');
}

main();
