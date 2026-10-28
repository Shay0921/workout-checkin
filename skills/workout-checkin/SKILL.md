---
name: "workout-checkin"
description: "运动打卡接龙生成周报，当用户想回顾运动群一周的打卡情况、统计或汇总运动打卡数据、生成周报或个人运动战报、查看个人累计与历史趋势时使用。典型触发：用户粘贴运动打卡接龙/打卡文本，或说「生成周报」「出个人报告」「统计一下打卡」。不用于普通健身建议、非打卡类群聊总结，以及非运动领域的周报/考勤统计。"
---

# 运动打卡周报生成 Skill

把用户粘贴的「运动打卡接龙」**翻译**为结构化流水（records.json），由确定性脚本完成全部统计计算（data.json）与渲染（HTML 周报 + 自动出图），并自动归档供下周趋势对比。

📌 **分工铁律**：AI 只负责两件事——① 把接龙文本翻译成 records.json（自然语言理解）；② 依据算好的数字补写文案（周报 insights / 个人双行，写法见 `references/insight-writing.md`）。**其余一切计算（期号、人数、百分比、角度、卡路里、红包、排序、趋势）一律由脚本完成，AI 禁止手工计算任何统计字段**——同一份 records.json 无论何时、何模型触发，计算结果必须完全一致。

## 术语（全文按此理解，命令里一律写绝对路径）

| 记号 | 指什么 | 怎么确定 |
| --- | --- | --- |
| `<skill目录>` | 本 SKILL.md 所在目录（含 `scripts/` `templates/` `assets/`） | = 本文件路径的上级目录 |
| `<工作区>` | **当前会话的工作目录**（用户打开的项目文件夹） | `members.json` / `records.json` / `data.json` / `reports/` 都在它下面；**不是** skill 目录 |
| 期 / 期号 | 一个统计周（周一 ~ 周日），期号由锚点推算 | calc 计算，AI 不推算 |
| 归档 | `reports/<年>-issue<NN>.json`（机器账本，下期读它做趋势）+ 同名 `.html`（成品）；年取该期 weekStart 的年份，期号跨年连续递增 | render 成功时自动成对写入 |

## 文件清单（本 skill 目录）

**出报告时会调用的（Step 0–6 主链路）**

| 文件 | 作用 |
| --- | --- |
| `scripts/preflight.mjs` | **前置体检（Step 0）**：判断是否首次使用 + 校验配置 + 依赖内嵌完整 + 归档现状 |
| `scripts/calc.mjs` | **计算脚本（唯一计算真源）**：读 records.json + members.json + 上期归档 → 输出 data.json（insights 留空由 AI 补写）。期号判定、归一化、换算、卡路里、红包档位、排序、趋势、累计全在此 |
| `scripts/cumulative.mjs` | 累计快照共享层（纯函数，被 calc 与 personal 共同 import）：链式累计、徽章层级、人格标签、本周之星、spotlight、里程碑、连击胶囊 |
| `scripts/nickname.mjs` | 昵称归一/别名索引：records 与历史归档的 cumulative 共用同一套映射，改名后历史累计按同一人接续 |
| `scripts/render.mjs` | 渲染脚本：校验字段 + insights 契约 → Handlebars 渲染 → 残留占位符检查 → 输出 HTML 并自动写同名归档 .json |
| `scripts/personal.mjs` | 个人战报生成脚本：渲染读最新一期归档的 cumulative，每人一节（`--name` 单人）；`--digest` 只打印历史速览供 AI 写双行分析 |
| `scripts/shot.mjs` | **自动出图（Step 5）**：复用本机 Chrome 无头截取周报 `.report` → `reports/<年>-issue<NN>.auto.png`（与页面「保存图片」同尺寸）；只在无头页面里临时隐藏按钮，不改 HTML；找不到浏览器时回退手动保存 |
| `scripts/angle.mjs` | 个人双行「主论点角度」判定（纯函数）：变化 / 结构 / 水平三档 + 变化·结构两档配额（水平兜底不限）+ 变化档按证据类型轮转，供 `personal.mjs --digest` 输出 `▸` 角度 |
| `scripts/text-lint.mjs` | 文案坍缩检测（纯函数）：骨架相似度（数字归一后 bigram Jaccard）。render 用于跨期同栏、personal 用于同批跨人，≥0.8 报错 / 0.65 告警 |
| `scripts/vendor/handlebars.cjs` | 渲染依赖 handlebars（内嵌单文件，**零安装**）：目录整体迁移/复制/解压不断链，沙箱环境也不需要任何 install 步骤 |
| `templates/template-mobile.html` | **交付模板（移动端单列，480px）**。头部注释是 data.json 字段契约的单一真源，改占位符须同步更新 |
| `templates/template-personal.html` | 个人战报模板（双列，每人一节） |
| `references/insight-writing.md` | **洞察文案写法（Step 3 / Step 6 动笔前必读）**：两类产物共用的写作总则 + 周报 6 栏与视角门槛 + 个人双行分工与档位 + 交付前自检 |

**不参与出报告（首次初始化 / 测试 / 维护）**

| 文件 | 作用 |
| --- | --- |
| `assets/members.sample.json` | 配置结构模板（Step 2.5 用）：完整 members.json 骨架，占位符需替换 |
| `assets/members.sample.md` | 配置字段说明书（Step 2.5 用）：字段分档 + 量纲折算 `convert` + 提问清单与接龙格式 + 成员字段说明 + 常见调整场景 + 禁忌 |
| `assets/data.sample.json` | 结构与取值样例（仅测试/参照）：字段集由 `test/sample-schema.test.mjs` 守卫，calc 迭代后须同步。**禁止当交付数据渲染**（render 对文件名含 sample 的数据硬拦截） |
| `test/` | 单元测试（node:test，零依赖）：日期/解析/统计/趋势/累计/端到端，另含出图 CLI 参数、沙箱降级与真实截图回归，锁住已知坑 |


运行时数据（调用时的工作区）：

**交付物**

- `<工作区>/reports/<年>-issue<NN>.html` —— 每期周报成品（人看：浏览器打开可保存图片）
- `<工作区>/reports/<年>-issue<NN>.auto.png` —— Step 5 自动出图产物（与「保存图片」同尺寸，宽 912、高度随内容）；不覆盖用户手动保存的 `<年>-issue<NN>.png`
- `<工作区>/reports/<年>-issue<NN>-personal.html` —— 个人战报（Step 6 按需生成；默认交付仍是全员周报）

**配置与中间产物**

- `<工作区>/members.json` —— 群规则配置（首次初始化生成，随工作区走）：达标线、红包档位、请假关键词、MET 表、intensityOverride、量纲换算、期数锚点、成员名单
- `<工作区>/records.json` —— AI 翻译的打卡流水（每期覆盖）
- `<工作区>/data.json` —— calc 输出的统计数据（每期覆盖；AI 在其上补写 insights）
- `<工作区>/reports/personal-insights.json` —— 个人洞察边车（Step 6 按需写入，personal.mjs 读取；同一文件按 issueNo 复用）

**机器账本**

- `<工作区>/reports/<年>-issue<NN>.json` —— 每期数据归档（render 成功后自动写入，下期 calc 读取做趋势对比）

## 执行流程

### Step 0：前置体检（每期都跑，首次运行必跑）

```bash
node <skill目录>/scripts/preflight.mjs --workspace <工作区>
```

- **这是判断「是否首次使用」的唯一入口**：`<工作区>/members.json` 不存在 → 退出码 `2`，走 Step 2.5 初始化；`0` 配置自洽，直接进 Step 1；`1` 有 `✗` 必须先修（按输出逐条修：配置类改 members.json，归档命名类改 reports/ 里的文件名）后重跑
- 一次跑完：配置键齐全与类型、日期占位符是否已替换（`YYYY-MM-DD` 未换必报错）、昵称重复/别名撞车（按归一化后比较）、met 与 sportAlias / sportNickname / intensityOverride 自洽、渲染依赖内嵌完整（scripts/vendor/）、工作区归档现状
- **sportAlias 写法**：标准名放键、口语放值（`"爬楼": ["爬楼梯"]`），反着写（口语当键）虽能命中但语义颠倒，不要这么写——反向映射 preflight 只提示不拦截，全靠写对；死别名、永不命中、重复声明、反向截胡等错误写法 preflight 会逐条点名报错，按体检输出修（全部走 stdout，不在 stderr）
- **`✗` 必须先修**，`⚠` 可放行但要在下期前补；体检通过后才翻译接龙——避免先花力气翻译再被配置问题打回
- 体检报「依赖缺失」= skill 目录不完整，重新获取完整 skill 即可（依赖已内嵌，零安装；见「跨平台兼容」）

### Step 1：翻译接龙 → records.json（AI 职责，禁止计算）

把用户粘贴的接龙文本逐条翻译为下面的薄结构，写入 `<工作区>/records.json`：

```json
{
  "weekStart": "2026-10-12",
  "records": [
    { "nickname": "成员甲~", "ordinal": 3, "sport": "力量训练", "quantity": 1.5, "unit": "h" }
  ],
  "leaves": [ { "nickname": "成员乙", "reason": "病假" } ]
}
```

字段规则：

- `weekStart`：**本期统计周的周一**（锚点短周填实际起始日）。calc 用它挡住「复用上期接龙出本周周报」——与 `--week` 推出的周期不符直接报错；缺失只告警，但必须补写
- `nickname`：**原样抄写**接龙中的昵称（含 emoji、波浪号等脏字符）——归一化匹配由 calc 完成
- `ordinal`：第几次打卡（「第一次/第1次/第①次/第1️⃣次」等价识别为整数）；无标注填 `null`（calc 自动补号）。写了就必须是**正整数 number**：字符串 `"1"`、0、负数、小数、中文序数一律判「次数标注非法」整期不产出
- `sport`：**原样抄写**项目名——MET 查表与别名归一由 calc 完成
- `quantity` + `unit`：原始量化与单位，unit 枚举 `h / min / floor / km / count`；`floor` / `km` / `count` 靠 `convert` 折算，未配置时 calc 报「换算未配置」；换算由 calc 完成
  - `quantity` 必须写**正数 number**：`1.5` / `45` / `200`，字符串、`"1,5"`（逗号小数点）、`"约1小时"`、区间 `"30-40"`、带单位文本、0 / 负数一律判「数量非法」整期不产出——范围或约数取能确认的一端，或直接问用户，**禁止自行估算**
  - 原文数字缺单位（如「跑了30」）→ **按 `min` 处理**（群内口语默认分钟）；只有原文写了「小时 / h」或数值本身是小时量级（1、1.5、2）且上下文在讲时长时才用 `h`。单位读错（30min 当 30h）脚本不会报错，只会整期数字全错
- `leaves[]`：请假成员（命中 leaveKeywords 如「病假」「事假」「复查」），`reason` 填原文短语。**两类请假**：
  - 未注明次数（「本周病假」「复查」「考试」「事假」）→ 只填 nickname/reason = **整周豁免**
  - **注明次数**（「第三次请假」「请假两次」「第 2 次病假」）→ 加 `times: N` = **部分请假 N 次**（「第三次请假」= 请假 1 次占第 3 个名额，填 `times: 1`）——请假 N 次抵 N 次打卡义务，打卡 + 请假 ≥ 达标线即达标。`times` 必须是**正整数**，且只用于非整周请假：整周语义误写会把豁免的人拖进未打卡名单，非法值判「请假次数无效」整期不产出
  - 请假成员的打卡记录若同时存在仍写入 records（calc 以打卡为准，整周豁免仅限未打卡者，并会告警）

解析规则：

| 噪声 | 处理 |
| --- | --- |
| 分隔符混杂（`+` 空格 `，` `、`） | 视为分隔符切分 |
| **序号错乱/重复/缺失** | **按「昵称 + 第N次」归人，完全忽略行首序号** |
| 一条含多个项目（如「自由活动+46分钟+羽毛球+1.85h」） | 拆成多条 records，各自带相同 ordinal |
| 成员表外昵称 | 照常翻译进 records——calc 会报错列出，再按「报错处理」确认 |
| **昵称带后缀备注**（如「成员甲 年底目标60KG」） | 原样抄写——calc 前缀兜底自动归人；命中多个成员时报错，确认后把准确昵称补进对应成员 `aliases` |
| **表外新运动项目** | **翻译阶段先停下来问用户，不猜 MET**——完整流程见「边界情况」 |

### Step 2：确定性计算（calc.mjs，含期号判定）

```bash
node <skill目录>/scripts/calc.mjs <工作区>/records.json -o <工作区>/data.json
```

- 默认统计「本周」（今天所在的周一~周日，本地时区）；补算历史周期加 `--week <任意日期>`（常规周归一到所在周一；锚点期按 `anchorWeekStart ~ anchorWeekEnd` 实际起止，支持首期短周），「算上周」= 当前日期减 7 天传参
- **节假日/特殊周期达标线**：本周只需打卡 N 次即达标时加 `--min-checkins N`——达标判定/达标率/状态文案/红包档位全部自动跟随，归档记录当期生效值；「差 1 次」档只在达标线 ≥ 2 时存在，达标线 1 时 0 打卡直接落「未打卡」档；**用户接龙语境提到节假日（国庆/春节/假期等）但未明说达标线时，先确认一句「本周达标线是否需要临时调整？」再计算**
- 期号、周起止由脚本从 members.json 锚点计算（stdout 打印摘要，核对用）
- **每次运行从磁盘重读 members.json**（天然杜绝会话缓存事故）；自动定位上期归档（本年 `issue<NN-1>` → 跨年回退上一年最大期号），无归档按首期兜底
- 输出完整 data.json（基础统计 + 8 个扩展字段：cumulative / metSnapshot / spotlights / milestoneCelebrations / calorieKing / efficiencyStar / progressStar / streakBreaks），`insights` 为空数组占位，字段契约见模板头部注释

报错处理（stderr + 退出码 1；records / leaves 的字段错误**一次列全**，其余遇到第一个即退出。按 stderr 文案修，改完重跑即可）：

- `数量非法` → **只回读接龙原文改成正确的正数 number，不许猜一个能过校验的值**——原文没写时长或无从判断就问用户
- `次数标注非法` → `ordinal` 改成正整数 number（去掉引号）；接龙没写次数就整条省略，由脚本补号。**不要为了过校验把两次打卡写成同一个 ordinal**，那会把两次并成一次
- `请假次数无效` → `times` 改正整数；原文是整周请假语义就整条删掉 `times`
- `未知昵称 / 前缀匹配到多个成员` → 与用户确认：新成员 → members.json 增员（确认出的准确昵称加进 `aliases`）；否 → 修正 records.json 拼写/归属后重跑
- `未知运动 / 未知单位` → 未知运动按「边界情况」新项目流程注册，**禁止猜 MET**；未知单位核对 unit 枚举（h/min/floor/km/count）修 records.json
- `楼层/公里/数量换算未配置` → 先问用户折算系数，写进 members.json 的 `convert` 后重跑，**禁止改 records 里的数值绕过**
- `体重无效` → 给该成员补 `weightKg`，或在 members.json 配 `defaultWeightKg`
- `records.json 标注的统计周是 X，本期应为 Y` → 手里不是本周接龙：请用户重新贴本周接龙；确实补算 X 周就传 `--week` 落在 X 周，**禁止手改 weekStart 蒙混**
- `--week 不是有效日期` / `weekStart 不是有效日期` → 必须是真实存在的日期，月日可不补零（`2026-3-5` = `2026-03-05`）；`2026-02-30` 这类会被直接拦下
- `第 N 期找不到上期归档` / `上期归档读不出来` → 账本断链或归档损坏，**交回用户决定，禁止自行加 `--allow-missing-prev`**（会清掉累计/连击/里程碑）；先按 stderr 排查：流浪归档挪回 reports/ → 补算上一期
- `归档期号未补零` → 按 stderr 给出的对照改名为 `<年>-issue<NN>.json` 后重跑
- `<工作区>/members.json` 不存在 → 回 Step 0 体检（退出码 2）

> **软告警（`⚠` 且不中断）不算报错**：单条时长偏高、单人单周合计偏高、重复贴合并等只是提示核对，报表照常产出；确认原文无误就继续，不用改数据去消警告。

> **`--members <路径>` 是备用参数**：只在临时读另一份配置 / 测试隔离 / 改配置前后对比时用；常规流程一律不传，默认永远读 `<工作区>/members.json`。

### Step 2.5：首次初始化 members.json（仅首次使用时执行）

**触发条件**：Step 0 退出码为 `2`（或 calc 报「未找到 members.json」）。已存在配置时整段跳过。

**禁止凭记忆手写整份 JSON**（整张 MET 表 + 别名 + 专精昵称，抄错一个键整期报废）。**默认值优先，只问三件事**——提问方式、默认值清单、成员对象生成规则、接龙格式 A/B 全部以 `assets/members.sample.md` **§三–§四** 为准，本节不复述：

1. 读两个配套文件：`assets/members.sample.json`（结构真源，复制后替换占位符，**不要从本文件正文抄 JSON**）+ `assets/members.sample.md`（填写口径）
2. 按 §三 默认值直出（达标线 3 次/周、红包 ¥5 / ¥10、9 个请假词、默认体重 60kg、MET 表），摘要列给用户并说明「**不调整就按默认来**」
3. 按 §三 只问三件事（一条消息问完）：① 群名；② 成员名单——**首选让用户贴一次完整接龙**，且接龙只是名单下界，必须补问「还有没有未打卡/请假没接龙的成员？」把名单补全；③ 首个统计周——常规周填周一 ~ 周日，节后短周填实际开始日 ~ 该周周日，**不要把锚点改成该周周一**。成员对象按 §三–§四 生成（昵称原样、`status` 一律 `active`、体重/性别可选默认 60kg / 留空、变体写法观察不到先不配 `aliases`），并主动讲清「体重决定卡路里、性别不影响计算」与「归档是不可变快照、改体重只对未来期生效」两点
4. 以 sample.json 为底替换占位符 → **摘要展示给用户确认**（群名 / 人数 / 达标线 / 红包 / 首期日期 + 沿用默认值的项）→ 写入 `<工作区>/members.json`（与 records.json / data.json / reports/ 同级，不写进 skill 目录）
5. 重跑 Step 0 体检，退出码 `0` 才算可用。通过后**按触发来源回主流程**：Step 0 首跑触发（records.json 尚未翻译）→ 回 Step 1；calc 报错触发（records.json 已在）→ 回 Step 2 重跑
6. 初始化时按 §三 末尾的「接龙格式」告知用户：群里有现成格式就沿用，没有固定格式的新群才建议格式 A；下周起用户直接贴接龙原文就是 Step 1 的输入

### Step 3：补写 insights（AI 职责，唯一文案环节）

**动笔前先读 `<skill目录>/references/insight-writing.md` §0–1**——6 栏各自「必须回答的问题」、视角门槛、季节边界、条件栏分档文案、交付前自检全在那边。本步骤只给流程：

1. 读 `<工作区>/data.json`（`insights` 此时为空数组）
2. 按文档补写 `insights`：固定 6 栏 + 条件栏（`streakBreaks` 非空时）+ 最多 2 条自由栏，共 6–9 条，每条 `{ title, content }`（title 一律 4 字，不手写序号，模板自动从 1 起）
3. 按文档 §1.8 自检通过后再进 Step 4

> 条数、固定 title、顺序、条件栏有无由 render.mjs 逐条硬校验（见 Step 4）。规则只在 references 里存一份——本文件不复述，避免两处走样。

### Step 4：渲染 + 自动归档（render.mjs）

```bash
node <skill目录>/scripts/render.mjs <工作区>/data.json
# 不带 -o 时默认写 <工作区>/reports/<年>-issue<NN>.html + 同名 .json
```

- 渲染前自动校验：缺字段报错、多余字段警告、**insights 契约校验**（为空 / 条数不在 6-9 / 固定 6 栏 title 缺失 / 元素非 `{title, content}` 结构 / **title 不是 4 字** / **与上期同栏骨架重合 ≥ 0.8** → 均报错，必须先完成 Step 3）、渲染后残留 `{{` 报错——**任何报错都必须修复 data.json 后重跑，禁止跳过**
- 渲染成功后**自动写同名归档** `reports/<年>-issue<NN>.json`（= 最终 data + archivedAt + records 流水内嵌）；已存在时警告并覆盖（补算场景）。`-o` 只在试渲染时用：指到 `reports/` 之外会告警，且本期会从下期账本里消失
- 交付为移动端单列布局（微信内分享/手机浏览优先）；输出 HTML 内置「保存图片」按钮（html2canvas-pro），浏览器打开即可导出 PNG；Step 5 还会用 `shot.mjs` 自动出一份同级 PNG，按钮与手动保存流程保持不变
- 无需 `cd` 到 skill 目录：依赖已内嵌 `scripts/vendor/`，任意工作目录可直接执行（报告内的导出库走 CDN，与本地运行无关）

### Step 5：交付（自动出图 + 极简输出）

1. **自动出图**（Step 4 渲染成功后立即执行，失败不阻断交付）：

   ```bash
   node <skill目录>/scripts/shot.mjs <工作区>/reports/<年>-issue<NN>.html
   ```

   - 产物：`<工作区>/reports/<年>-issue<NN>.auto.png`（与页面「保存图片」同尺寸、同裁切；宽 912、高度随内容）；**不覆盖**已有的 `<年>-issue<NN>.png` 等手动保存文件；要换路径加 `-o <路径.png>`
   - 只影响无头浏览器里的这一张截图：截图前临时隐藏固定按钮 `#saveImageBtn`、阻断 jsdelivr CDN；**不改 HTML、不删按钮**，用户仍可在浏览器里手动保存
   - 受限环境（TRAE / 容器等）若报 `Chrome CDP 连接已关闭`：脚本会自动加 `--no-sandbox` 重试一次，不占用 `--retries` 次数；也可直接传该参数
   - 退出码非 `0`（本机没有 Chrome/Chromium、页面加载失败等）→ **照常交付 HTML**，一句话说明「未能自动出图，请用浏览器打开手动保存」；不要安装依赖、不要改报告、不要反复重试
   - 个人战报不调用此脚本（Step 6 保持原有手动保存流程）
2. 用当前环境可用的预览方式打开 `reports/<年>-issue<NN>.html` 交付（有 `present_files` 等预览工具就用，没有就直接给出文件路径）；**「保存图片」需要能执行页面脚本的真实浏览器**——不支持脚本的预览器点按钮无反应属预期（已知 WorkBuddy 内置预览如此；其他 agent 的内置浏览器一般可以正常保存）；不要尝试内联脚本等客户端方案，交付时主动提示一句「保存图片请用浏览器打开该文件」
3. 一行复述周期与期号供用户核对（第 N 期 · 周一 ~ 周日 · 红包 ¥X）——防 `--week` 传错周
4. **禁止在对话中复述统计明细**（名单、红包、卡路里、趋势等分析或列表）——用户可直接在 HTML 中查看，对话重复输出纯属浪费 token

### Step 6：个人战报（按需，三步）

```bash
# ① 取历史速览（逐期时间线 + 每人派生量 + 已分配的主论点角度；不渲染、不写盘）
node <skill目录>/scripts/personal.mjs <工作区>/reports --digest
# ② 写侧车 <工作区>/reports/personal-insights.json（契约见 insight-writing.md §2.1）
# ③ 渲染
node <skill目录>/scripts/personal.mjs <工作区>/reports [--name 昵称] [-o 输出.html]
```

- `--digest` 为拿逐期序列由脚本扫全部归档（一两秒、AI 零 token）；渲染路径仍只读**最新一期归档**的 cumulative（链式累计已内嵌：累计消耗/时长、达标期数、项目人次、连击、近 4 周）。**禁止自己读归档 JSON，也禁止心算任何平均值**
- **正常交付永远是全员报告**；`--name` 只在补写/补渲染某一人时用，不是另一种交付形态
- 产物 `reports/<年>-issue<NN>-personal.html`，内容与版式由 `templates/template-personal.html` 决定——**不需要预知页面结构**

**AI 双行分析（必写）**：动笔前读 `<skill目录>/references/insight-writing.md` §2–3——双行骨架与数字来源（§2.2）、速览行尾 `▸` 主论点证据的用法（§2.3，照用不重排）、侧车契约（§2.1）全在该文档，以它为准。侧车须覆盖全部目标成员，覆盖不全时 personal.mjs 打印 ⚠（含名单），见到必须补写后重跑。

## 边界情况

- **首期运行**：无上期归档 → calc 自动兜底（`redPacketTrendText` =「首期 · 暂无对比」、`returnWelcome` = null）
- **全员达标/请假**：`redPacketTiers` 为空数组、`totalPeople: 0`（模板空表格正常显示合计行）
- **重复贴/修改贴**：calc 按（昵称, 次数, 项目）三元组自动去重（时长相同）或合并（时长不同），并打印警告
- **部分请假（`times`）的判定结果**：打卡已够线 →「达标」（不注请假）；打卡不足但打卡 + 请假 ≥ 达标线 →「达标+N请假」；有效次数不足 →「差 N 次」，红包按有效次数走档；0 打卡且请假 ≥ 达标线 → 等同整周豁免（进请假名单 ¥0）；**0 打卡且非整周豁免 → 一律计入未打卡人数**（名单显示「差 N 次」或「未打卡」）。打卡 / 请假 / 未打卡三档人数之和恒等于群总人数
- **接龙出现 MET 表外的新项目**（如桨板、攀岩）：`resolveSport` 在 `met` 与 `sportAlias` 均未命中即报「未知运动」，整期不产出，**禁止猜测 MET**。处理流程：
  1. 把新项目报给用户，共同确定项目名与常见写法、MET 值（拿不准参照 Compendium：休闲滑雪≈6.0、滑冰≈5.5、滑板≈5.0）、专精昵称
  2. 在 members.json 补 `met` + `sportNickname` + `sportAlias`（复用同 MET 的别名都写进 alias），体感与 MET 不符再进 `intensityOverride`
  3. 要进入**新群默认骨架**时再同步静态镜像（`members.sample.json` / `data.sample.json` 的 `metSnapshot.met`），清单与测试要求见 `assets/members.sample.md` §五；只给当前群用就只改 members.json
  4. 重跑 Step 0 体检核对反向映射，通过后重跑 calc；动过 sample 就跑 `sample-schema` 测试
  - **报告里的运动清单是现算的**：强度分组（MET ≥7 high / 4–6.9 mid / <4 low）、专精门槛（10 / 15 / 25）、专精 chip 全部由脚本从 members.json 生成，模板不用改；`intensityOverride` 只挪档位不改卡路里，`sportNickname` 同名即合并专精计数
  - **伞形条目**：一个上位词覆盖多个流派写法时（如「养生操」收太极 / 八段锦 / 站桩），`met` 只建一条、流派全写进它的 `sportAlias` 数组，接龙写哪个都合并计次。哪些已经注册、哪些是伞形词，一律以 members.json 的 `met` / `sportAlias` 为准——未注册项目永远不进入统计
  - **该不该归并是语义判断，代码不参与**：同一动作的不同说法 → 配别名（骑车 = 骑行、步行 = 散步）；动作不同、只是字面接近 → 不配（徒步 ≠ 爬山，各自独立计量）。表外叫法（如「爬坡」）不硬配别名，按上面「新项目」流程走。想让某个叫法独立成项就单独写进 `met`，MET 值相同也照写；只在专精维度靠同一个 `sportNickname` 合并计次的，计量上仍是两条独立条目

## 维护原则

- **模板 class 名铁律**：所有由数据驱动的 class 后缀（spotlight.type / streakCapsule.style / badge / personaClass / statusClass 等）必须在模板里经 `lower` helper 转全小写输出（helper 由 render.mjs / personal.mjs 注册），CSS 只定义小写类名——html2canvas-pro 的导出管线会把克隆 DOM 的 class 名归一为小写，**驼峰类名页面显示正常、导出图片中静默失效**（破纪录胶囊变紫、里程碑 Lv 掉底色）。数据契约中的枚举原值保持驼峰不变，仅渲染层转小写
- **计算口径变更**（公式、排序、档位判定等）：改 `scripts/calc.mjs` 或 `scripts/cumulative.mjs`，并在 `test/` 补对应用例（测试命令按 Node 版本二选一，写法见「跨平台兼容」，全绿后再交付）
- **模板占位符与字段契约**：改 `templates/template-mobile.html`（同步更新头部注释契约），render.mjs 的校验清单自动跟随，无需改脚本
- **文案规则变更**（栏目、视角门槛、季节边界、双行分工、字数口径）：只改 `references/insight-writing.md`——SKILL.md 不重复这些规则。若动的是固定栏枚举，同步 render.mjs 的 `INSIGHT_TITLES`
- **群规则 / 成员档案变更**（达标线、红包、MET、换算、锚点、成员增删改名、体重性别）：只改 `<工作区>/members.json`——calc 每次从磁盘重读；**改完先跑一次 `preflight.mjs`** 再跑 calc。字段口径与「想改什么 → 改哪个键」见 `assets/members.sample.md` §四–§五。改名时新名换进 `nickname`、旧名进 `aliases`，历史累计/连击/徽章自动接续；每期归档是不可变快照，体重/性别只对未来期生效（性别零计算影响），确需重算历史须用户明确坚持并告知逐期重跑成本
- 禁止手工编辑渲染输出的 HTML 与归档 JSON——重新生成会覆盖

## 跨平台兼容（Mac / Windows / Linux）

- **命令纪律**：所有命令单命令执行——无 `&&`/`||` 链、无 `cd`、无 `ls`、无 `/dev/null` 重定向；路径一律用正斜杠 `/`（Node 在 Windows 同样接受）
- **日期**：全程本地时区手工拼接，**禁用 `toISOString()`**（UTC 日期会使东八区零点倒退一天，已由 calc/render 内置实现并有测试锁死）；换行按 `[\r\n]+` 处理 CRLF
- **前提**：Node ≥ 20 即可跑主链路（preflight / calc / render / personal）与单元测试（目录形式，见下条）。渲染依赖已内嵌（`scripts/vendor/handlebars.cjs`），**无任何安装步骤**，沙箱/离线/目录迁移均可直接运行
- **自动出图（Step 5）**：`scripts/shot.mjs` 需要 Node ≥ 18 + 本机 Chrome/Edge/Chromium/Brave，零安装。自动探测 macOS/Windows 的浏览器路径与 Linux 的常见路径，也可用 `--chrome <可执行文件绝对路径>` 或环境变量 `CHROME_PATH` / `CHROME_BIN` 指定；找不到浏览器或截图失败时**跳过自动出图**（HTML 与手动保存不受影响），不要为出图安装任何依赖；受限环境（容器 / TRAE 等受管 IDE）首次启动失败会自动用 `--no-sandbox` 再试一次
- **测试命令**：`node --test <skill目录>/test/`（目录形式，Node 20+ 支持；本机 macOS + Chrome 实测 275 项全绿，无 Chrome 的机器为 274 通过 + 1 跳过）。不要用引号 glob（Node 24 会报 Could not find），也不要用不带引号的 glob（Windows 不展开）；该命令在 macOS（bash/zsh）与 Windows（PowerShell/cmd）都可直接运行，仅数量不同：Windows 共额外跳过 3 项（2 项依赖 POSIX shell 的沙箱降级用例 + 1 项依赖 X_OK 检查的用例），即 272 通过 + 3 跳过
