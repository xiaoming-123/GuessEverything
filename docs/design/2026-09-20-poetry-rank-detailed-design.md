# 诗词升官 · 优化详细设计（2026-09-20）

> 上游方案：`docs/design/2026-09-20-poetry-rank-optimization-and-art.md`（v2，人物/可玩性/解锁/吸引力要素）。
> 本文是落地层：数据模型 diff、纯逻辑层接口、API 契约、服务端时序、前端状态机、测试计划。
> 架构红线不变：`lib/games/` 零依赖纯函数；答案永不下发；门禁服务端强制；结算幂等；语料仅公版。
> 代码事实基线（2026-09-20 读取）：`rank-service.ts` 678 行、`engine.ts` 375 行、`schema.prisma` 121 行、页面 348 行。

## 0. 总览与分期

| 期 | 内容 | 涉及层 | 验收 |
| --- | --- | --- | --- |
| D1 | 人设对话系统 + 主页重做（身份卡/功名估算/路线图迷雾）+ 结算仪式感 | 纯逻辑 + 服务端视图 + 前端 | 单测 + 浏览器 |
| D2 | 每日题 DAILY + 月历 + 成就徽章 + 功名簿页 | schema + 纯逻辑 + API + 前端 | 单测 + 集成 + 浏览器 |
| D3 | 诗词阁 + 2 类新题型（引擎 + 容量口径同步） | schema + 引擎 + 容量审计 + 前端 | 单测 + 审计脚本 + 浏览器 |
| D4 | 问同窗提示 + 剪影竞猜 | API + 前端 | 集成 + 浏览器 |
| D5 | 美术批量（12 阶 Q 版 + 表情包）入库 + 全量终验 | 资产 + 前端 | 构建 + 浏览器 15+ 项 |
| D6 | 皇榜（排行榜，纯派生视图 + 虚拟榜位 + 低压力展示） | 纯逻辑 + API + 前端 | 单测 + 集成 + 浏览器 |

P2（内侍/同窗/说书人立绘、限时事件框架、分享卡、外观）不在本文展开，仅列接口预留位。

---

## 1. D1 · 人设对话系统（persona）

### 1.1 纯逻辑层 `src/lib/games/poetry/persona.ts`（新建，零依赖）

```ts
/** 人设 key：研习=引路先生 / 科考=主考官 / 皇帝大考=钦差（天子亲试） */
export type PersonaKey = "TUTOR" | "EXAMINER" | "EMPEROR";

export function personaFor(kind: RankKind, rankId: number): PersonaKey;
// PRACTICE→TUTOR；EXAM 且 rankId===10→EMPEROR；EXAM→EXAMINER；DAILY→TUTOR

/** 开局白（按 kind 3-4 句池，seed 确定性随机，测试断言同 seed 同句） */
export function openingLine(key: PersonaKey, seed: number): string;

/** 判题反馈（不含答案本身——答案由 RankedJudgeView.correctAnswer 承载，文案里只许出现出处类信息） */
export function feedbackLine(
  key: PersonaKey,
  input: { correct: boolean; timeout?: boolean; combo: number; explanation: string },
): string;
// 对：`"对。" + explanation + （combo>=3 追加夸奖池）`
// 错：`"错。" + explanation + （安慰/点题池）`
// 超时：`"时辰到了。" + explanation + （催促池）`

/** 结算台词 */
export function promotionLine(key: PersonaKey, fromLabel: string, toLabel: string): string;
// 例 EXAMINER：`"${fromLabel}中式，擢升${toLabel}。"`；EMPEROR：登极专用句
export function failLine(accuracy: number): string;   // 例 `"正确率 50%，距 60% 还差一题，卷面功名已为你留下。"`
export function practiceLine(expGained: number): string; // 例 `"这一卷记下 ${expGained} 功名。"`
```

- 全部句式池是文件内常量（文案中文），`seed` 用 `mulberry32`（复用 `sampling.ts` 口径），保证可单测、可复现。
- **红线**：任何句式不得包含答案、选项内容；explanation 只来自服务端 `RankedJudgeView`（客户端不持有 meta）。

### 1.2 服务端接线（rank-service.ts 改动）

- `RankedStartView` 增字段：`persona: PersonaKey`、`opening: string`（seed = `session.id` 哈希，服务端生成，客户端直接展示）。
- `RankedJudgeView` 增字段：`feedback: string`（服务端拼，`combo` 用结算前 streak+1）。
- `RankSummary` 增字段：`settleLine: string`（promotionLine / failLine / practiceLine 按 kind 与 promotion.promoted 选择）。
- 不改任何判定/计分逻辑，仅视图层拼装。

### 1.3 前端（quiz 组件气泡化）

- 新组件 `src/components/rank/persona-bubble.tsx`：
  输入 `{ avatar: string, expression?: "normal"|"happy"|"surprised"|"sad", text, variant: "question"|"feedback" }`；
  头像用 `public/art/q_npc_*.png`（D5 前用 emoji 占位：🎓/📜/👑）。
- `page.tsx` PLAYING 分支改造：
  - 题面区 = persona-bubble(variant=question) + 题面文本 + 倒计时环（**倒计时只在此气泡激活**，进入 REVEAL 即停）；
  - 选项 = choice-list（保留，胶囊样式微调）；
  - 判题反馈 = judge-card 改造为 persona-bubble(variant=feedback)：文本用 `lastJudge.feedback`（store 增字段 `feedback`），出处行保留；
  - 连击视觉：combo≥3 时题面气泡边框升级琥珀金（3/5/8 三档：indigo→amber 描边→amber 光晕），**纯 CSS，无新数据**。
- REVEAL 时序不变（现有 `reveal/next` 状态机），倒计时口径不变 → 速度分零影响。

### 1.4 主页重做（IDLE）

`src/app/play/poetry-rank/page.tsx` 的 IDLE 分支 + `rank-road.tsx` 重写：

- **身份卡**（新组件 `rank-identity-card.tsx`）：当前阶 Q 版立绘（`/art/q_hero_rank{rankId:02d}_{key}.png`，D5 前占位 emoji）+ 大号 `rank.label` + `rank.subtitle`。
- **功名估算**：`est = ceil(expToNext / avgExp)`，`avgExp` = 最近 3 局 `expGained` 均值（数据源：`RankView.recent` 字段，见 §2.3；不足 3 局用全部，无局则不显示估算行）；文案 `还差 {expToNext} 功名，约 {est} 局研习`。
- **路线图迷雾**（`rank-road.tsx` 重写，纯客户端逻辑，输入 = 现有 `rank.ranks[]` + `rank.rankId`）：
  | 状态 | 条件 | 渲染 |
  | --- | --- | --- |
  | 已升 | `r.id < rankId` | 彩色立绘缩略 + 称号 + ✓ |
  | 当前 | `r.id === rankId` | 高亮脉冲 + 大节点 |
  | 下一阶 | `r.id === rankId+1` | 半剪影（CSS `filter: brightness(0.4)` 遮罩）+ 称号可见、副标题 `——` |
  | 迷雾 | `r.id > rankId+1` | 黑色剪影 + `？？？`（称号/副标题全隐） |
  | 皇帝特殊 | `r.isEmperor && rankId < 9` | **节点整体隐藏**（不渲染，路线图以丞相为可见终点）；`rankId >= 9` 时按皇帝节点渲染（👑 +「登极大考」） |
  - 布局：已升节点收成顶部一行小圆点（"已过 N 阶"），下方纵向只展示 当前 + 后续可见节点（窄屏 ≤5 行）。
- **双按钮**：研习（主，铺满）；科考（金色，`nextUnlocked=false` 时置灰 + 内嵌 `还差 {expToNext}`）；皇帝大考按钮在 `rankId===9` 且功名达标时以金色大按钮显示。
- **最近战绩**：一行 `上一局 {KIND_LABEL} · 正确率 {x}% · +{expGained} 功名` + `已见 {seenPoems} 题`（数据源见 §2.3）。

### 1.5 结算仪式感（rank-settle-view.tsx 扩展）

- **擢升（PROMOTED）**：上下两段对比——旧官衔（小、置灰）→ 新官衔（大、琥珀金描边、Q 版立绘放大 1.2× + 入场 300ms 缩放动画，CSS keyframes）；`settleLine` 居中台词；功名入账滚动数字（requestAnimationFrame 800ms，纯展示）。
- **失败（EXAM_FAILED）**：`failLine`（含正确率与缺口题数）+「直接重考」主按钮（调 start EXAM，现有逻辑）+「回官途」次按钮。
- **研习（KIND_NOT_EXAM）**：`practiceLine` + 功名条从旧值到新值的宽度动画（CSS transition）。
- **皇帝终点**：布衣 → 皇帝两张立绘并排 + 固定文案「位极人臣，已登天子（架空称号终点）」。

---

## 2. D2 · 每日题 + 成就 + 功名簿

### 2.1 每日题（DAILY）

**规则**：每天 1 题（服务端日期 `Asia/Shanghai` 口径，`Date.now()` + `Intl.DateTimeFormat` 取本地日）；出题官阶 = 玩家当前官阶的 `gradeWindow`（研习窗口，非科考窗口）；功名正常计入 totalExp（与研习同口径，经同一结算通道）；不晋升（`evaluatePromotion` 的 KIND_NOT_EXAM 分支天然覆盖）。

**schema diff**：

```prisma
/// 每日题记录（幂等：一玩家一日一局）
model PlayerDaily {
  playerId  String
  /// 服务端本地日期 YYYY-MM-DD（Asia/Shanghai）
  date      String
  sessionId String
  /// 是否已结算（未结算可续答，TTL 内）
  settled   Boolean @default(false)
  createdAt DateTime @default(now())

  @@unique([playerId, date])
  @@index([playerId, date])
}
```

**服务端时序**（`startRankedSession` 增 DAILY 分支）：
1. `kind === "DAILY"` 时：`date = localDate()`；`daily = prisma.playerDaily.findUnique({ where: { playerId_date } })`；
   - 存在且 `settled` → 409「今日已答完」；
   - 存在且未结算 → 409 + 返回可恢复会话（复用 resume 语义，客户端转 resume）；
   - 不存在 → 事务内 `create` 占位（先占位后选题，P2002 冲突即重试换日逻辑：换种子），`rankId = 当前官阶`，`roundCount = 1`，`stage = "DAILY"`。
2. `judgeRankedAnswer` 末题结算分支：DAILY 与 PRACTICE/EXAM 同通道；结算事务内补 `playerDaily.update({ settled: true })`。
3. `startRankedSession` 入参 kind 联合类型扩为 `"PRACTICE" | "EXAM" | "DAILY"`（types.ts 的 `RankKind` 已含 DAILY，仅服务端此前拒绝，改为放行）。
4. **补签宽限（streak freeze）**：月历断签不清零功名（功名本就只增不减，天然合规）；月历"周连满"奖励见 §2.2 月历。补签 = 每月 1 次将上月某未答日标记为"补"，**只影响月历展示与周连满判定，不加功名**（纯展示奖励，防刷）。

**月历视图**（`RankView` 扩展字段 `daily: DailyView`）：

```ts
export interface DailyView {
  /** 当月 28 格（4 周，简化月历）：done=已答 / pending=今日未答 / future / missing=过期未答 */
  cells: Array<{ date: string; state: "done" | "pending" | "future" | "missing" }>;
  /** 本周连满次数（整周 7 格全 done 记 1 次，含补签） */
  weeksCompleted: number;
  /** 本周周奖（weeksCompleted 对应档位，纯展示；周奖功名在周一首局结算时补记 200/周，幂等键 playerId:YYYY-WW） */
  weeklyBonus: number;
}
```

周奖补记：服务端在任意一局结算事务中检查 `PlayerRank.weeklyBonusKeys`（见 2.2 PlayerRank 扩展）缺周时补记——**幂等键落库，崩溃可恢复**，与 settleKey 同风格。

### 2.2 成就徽章

**schema diff**：

```prisma
/// 玩家已获成就（幂等唯一）
model PlayerAchievement {
  playerId String
  /// 成就 key（纯逻辑层 ACHIEVEMENTS 表定义）
  key      String
  earnedAt DateTime @default(now())

  @@unique([playerId, key])
  @@index([playerId])
}
```

`PlayerRank` 增字段：`weeklyBonusKeys Json @default("[]")`（形如 `["2026-W38", ...]`，周奖幂等）。

**纯逻辑层 `src/lib/games/poetry/achievements.ts`（新建，零依赖）**：

```ts
export interface AchievementSpec {
  key: string;          // 稳定 key：FIRST_PRACTICE / ALL_CORRECT / COMBO_3 / RANK_1 / RANK_5 / RANK_9 / EMPEROR / SEEN_100 / SEEN_500 / WEEKLY_3
  label: string;        // 称号：初窥门径 / 十拿九稳 / 连中三元 / 童生及第 / 金榜题名 / 位极人臣 / 登极 / 学富五车 / 诗词阁主 / 三月连满
  desc: string;
  /** 判定时点：settle=结算事务后评估 */
  check: (ctx: AchievementCtx) => boolean;
}

export interface AchievementCtx {
  rankId: number;        // 结算后
  newRank: number;       // 晋升后
  promoted: boolean;
  correctCount: number;
  totalRounds: number;
  maxCombo: number;      // 本局最大连击（结算事务内从 AnswerRecord 推导）
  seenCount: number;     // 已见题累计（PlayerSeenKey 计数，事务内查）
  weeksCompleted: number;// 周连满累计（DAILY 月历推导）
  kind: RankKind;
}

export const ACHIEVEMENTS: AchievementSpec[];            // 10 条数据表
export function evaluateAchievements(
  ctx: AchievementCtx,
  earnedKeys: string[],   // 已持有 key 集（事务内查）
): string[];             // 本次新达成 key（纯函数，可单测）
```

- 首批全 **metric 型**（里程碑：有意义的行动），签到类不单独建成就（月历周连满只喂 WEEKLY_3 这一个里程碑）。
- **服务端接线**：结算事务后（同一事务尾）：查 `PlayerAchievement` 持有集 → `evaluateAchievements` → `createMany` 新达成 → `RankSummary.newBadges: string[]` 下发（只下发 key，文案客户端查纯逻辑表 `ACHIEVEMENTS` 渲染——文案在纯逻辑层，前端可直接 import，与 RANKS 同模式）。
- `maxCombo` 推导：结算事务内按 `answers` 升序扫一遍算最大连续 correct 段（10 题规模，O(n)）。

### 2.3 RankView 扩展（GET /api/games/poetry/rank 明文视图）

```ts
export interface RankView {
  // …现有字段不变…
  /** 已见题累计（功名簿/最近战绩展示） */
  seenCount: number;
  /** 上一局战绩（最新 FINISHED 官阶局；无则 null） */
  recent: { kind: RankKind; expGained: number; accuracy: number } | null;
  /** 已获成就 key 集 */
  badges: string[];
  daily: DailyView;
}
```

- 查询成本：`PlayerSeenKey.count` + `gameSession.findFirst(FINISHED, orderBy createdAt desc)` + `PlayerAchievement.findMany(select key)` + 当月 `PlayerDaily.findMany`——4 条索引查询，SQLite 单文件无压力。

### 2.4 功名簿页（`src/app/play/poetry-rank/ledger/page.tsx`，新建）

- 三区块：成就宫格（10 格，已获=彩色+日期，未获=剪影+条件描述）/ 月历（§2.1 cells 渲染）/ 功名总览（totalExp、seenCount、近 10 局小柱状图，数据源：`gameSession` 近 10 局 select kind+score+createdAt，GET 明文 `/api/games/poetry/rank/ledger`）。
- 主页 IDLE 右上角入口 🏮「功名簿」。

---

## 3. D3 · 诗词阁 + 新题型

### 3.1 诗词阁（收集）

**schema diff**：

```prisma
/// 诗词阁：玩家答过的诗（按 poemId 去重，答过即入库，不论对错）
model PlayerPoem {
  playerId  String
  poemId    String
  title     String
  poet      String
  dynasty   String
  grade     Int
  /// 该诗在阁内首次答对过（展示「已通」标记）
  mastered  Boolean @default(false)
  seenAt    DateTime @default(now())

  @@unique([playerId, poemId])
  @@index([playerId, dynasty])
  @@index([playerId, poet])
}
```

**落库点**：`judgeRankedAnswer` 每轮判题后（非末题分支与结算事务内都处理）：`round.meta` 有 poemTitle/poet/dynasty，**poemId 由 sourceKey 第一段还原**（`sourceKey = poemId:lineIndex:type`，engine.ts 既有格式）；`upsert` 幂等；`mastered` 仅当本题 correct 且该诗未 mastered 时置 true（`updateMany` 条件更新）。
- 诗词阁收录 = "已见"（答题即见），与 PlayerSeenKey（素材粒度）是两个维度：阁按诗去重，SeenKey 按 诗×句位×题型 去重。

**API**（GET 明文视图）：
- `GET /api/games/poetry/rank/gallery` → `GalleryView`：
  ```ts
  export interface GalleryView {
    total: number;                    // 入阁诗数
    byDynasty: Array<{ dynasty: string; count: number }>;
    byGrade: Array<{ grade: number; count: number }>;
    /** 分页：page 从 1，pageSize 默认 20 */
    items: Array<{
      title: string; poet: string; dynasty: string; grade: number;
      mastered: boolean; seenAt: string; lines: string[];  // lines 全文公版语料
    }>;
  }
  ```
  查询：`groupBy(dynasty)` + `groupBy(grade)` + 分页 `findMany`（orderBy seenAt desc）。
- 前端页 `src/app/play/poetry-rank/gallery/page.tsx`：朝代/grade 两个分组条（点击过滤）+ 诗卡列表（卡 = 标题/作者/朝代/「已通」章 + 展开看全文）；顶部 `total / 语料总数`（语料总数走 `GET /api/games/poetry/rank` 的 `RankView.corpusTotal` 新增字段，`Poem.count()`）。

### 3.2 新题型（引擎扩展）

**types.ts**：

```ts
export enum PoetryQuestionType {
  GUESS_POET = "GUESS_POET",
  GUESS_TITLE = "GUESS_TITLE",
  COMPLETE_NEXT = "COMPLETE_NEXT",
  /** 选字填空：句中挖一字（□），4 个单字选项 */
  FILL_CHAR = "FILL_CHAR",
  /** 朝代配对：一句名句，4 个朝代选项 */
  DYNASTY_PICK = "DYNASTY_PICK",
}
```

**engine.ts 改动**（`rankedRoundPool` / `materializeRound` / `faceKey` / `materialKey`）：

- `materialKey` 对 FILL_CHAR 扩为 `poemId:lineIndex:FILL_CHAR:pos`（pos = 挖字位置，防同句不同字位互斥）；其余题型格式不变。
- 素材枚举：`rankedRoundPool` 的每 (item, lineIndex) 循环改为：
  - 恒加 3 基础题型；
  - FILL_CHAR：每句 1 个候选，`pos = rand 选 CJK 字位`（过滤：该字为 `\u4e00-\u9fff`、非标点、句中 CJK 字数 ≥ 2）；
  - DYNASTY_PICK：每句 1 个候选（选项 = 朝代名，无需 pos）。
  - 题型混合权重（心流"有张有驰"）：`rankId < 3` 仅基础 3 型（低阶不混入，容量与体验优先）；`rankId >= 3` 起 FILL_CHAR/DYNASTY_PICK 各按 30% 概率追加（rand 判定，seed 确定可复现）。
- `materializeRound` 新增两分支：
  - **FILL_CHAR**：`prompt = line 挖字为「□」`（保留原句其余文字）；`correct = 被挖字`；干扰项池 = 同诗其余 CJK 字 + 同朝代其他诗的 CJK 字（`distractors.ts` 新增 `charDistractorPool(pool, item, char)`：去重、≠correct、取 3；不足 3 判该素材无效跳过）。
  - **DYNASTY_PICK**：`prompt = pickQuote(item, lineIndex)`；`correct = item.dynasty`；干扰项池 = 语料中出现过的其他朝代（`dynastyDistractorPool(pool, dynasty)`：按出现频次降序取 3，保证干扰项是"看起来可能"的朝代）。
- `faceKey` 两题型：`type|prompt|correct` 同现有格式（prompt 含 □ / 朝代题 prompt 为诗句）。
- **容量审计同步**（capacity.ts）：题型枚举处同步加两型，口径与 `rankedRoundPool` 一致（同函数素材化，审计脚本 `poetry-capacity-audit.ts` 重跑验证）。
- 判题/结算/已见/答案记录路径**零改动**（PoetryRound 结构不变：prompt + 4 options + answerIndex）。

### 3.3 干扰项质量红线

- FILL_CHAR 干扰字不得与 correct 同字（含异体字不处理，公版语料以字面为准）；单字选项 UI 样式与句选项一致（choice-list 不感知题型差异）。
- DYNASTY_PICK 干扰朝代必须真实存在于语料（防"不可能选项"送分感）。
- 两题型均走 `strictOptions=true`（ranked 模式既有严格口径：干扰项不足即弃素材）。

---

## 4. D4 · 问同窗 + 剪影竞猜

### 4.1 问同窗（每局 1 次提示）

**规则**：一局一次；代价 = 本局最终功名 ×0.8（结算时应用，`GameSession.hintUsed` 标记）；效果 = 移除 2 个错误选项（剩 3 选 1，**不泄答案**：响应只含被移除索引，客户端灰置）；仅对当前未答轮次有效（下一题自动失效，服务端按 `roundIndex` 校验：提示针对请求时的当前题）。

**schema diff**：`GameSession` 增 `hintUsed Boolean @default(false)`、`hintRemoved Json @default("[]")`（被移除选项索引数组，resume 恢复时下发，客户端灰置）。

**API**：`POST /api/games/poetry/rank/hint`（withCrypto）：

```ts
// 入参 { gameSessionId: string, roundIndex: number }
// 出参 { removedIndexes: number[] }   // 恒 2 个，均 ≠ answerIndex
// 错误：404 对局不存在 / 410 已结束或超时 / 409 本局已用过提示 / 400 轮次已答
```

**服务端时序**（单事务）：
1. 校验会话 ACTIVE、未超时、`roundIndex` 无 AnswerRecord、`hintUsed === false`；
2. `rounds[roundIndex].options` 中排除 `answerIndex` 的索引集合，rand（`Math.random` 一次性消费，无复现需求）取 2；
3. `update { hintUsed: true, hintRemoved }`（P2002 不适用，乐观即可：步骤 1 的 `updateMany({ where: { hintUsed: false } })` 原子抢占，count===0 即 409）。

**结算应用**：`settleRankedSession` 功名记账处：`const exp = hintUsed ? Math.round(sessionScore * 0.8) : sessionScore`；`RankSummary.expGained` 用折后值；`RankSummary` 增 `hintUsed: boolean`。
**合规校验**：`hintRemoved` 全 ≠ answerIndex（单测断言 1000 次随机全过）。

### 4.2 剪影竞猜（每日 1 次小彩蛋）

**规则**：IDLE 页"猜猜下一官衔是什么"，选项 = 当前 +1 阶与 ±1 干扰（共 4 个称号）；每日 1 次；猜中 +100 功名（折后不走 0.8——提示代价只作用对局）；**不晋升、不解锁任何门禁**，纯功名 + 心理锚定。

**schema diff**：

```prisma
/// 剪影竞猜（一玩家一日一次）
model RankGuess {
  playerId   String
  date       String   // YYYY-MM-DD 服务端本地
  guessLabel String   // 玩家选的称号
  correct    Boolean
  gained     Int      @default(0)
  createdAt  DateTime @default(now())

  @@unique([playerId, date])
}
```

**API**：`POST /api/games/poetry/rank/guess`（withCrypto）：
- 入参 `{ guessLabel: string }`；出参 `{ correct: boolean, gained: number, todayUsed: true }`；
- 错误：409 今日已猜 / 403 已是皇帝（无下一阶）。
- 服务端：选项生成**不在响应里下发**（客户端自己用 RANKS 表渲染 4 选项：`rankId+1` 真答案 + `rankId-1`、`rankId+2`（边界取 `rankId+3`/`rankId-2`）、随机一远阶——纯客户端可选池，服务端只按 `guessLabel === RANKS[rankId+1].label` 判对错）；功名记账走 `playerRank.update`（+100，幂等靠 RankGuess 唯一键占位）。
- 前端：IDLE 路线图下方小卡片，当日已猜显示结果（GET 视图 `RankView` 增 `guess: { done: boolean, correct?: boolean, gained?: number } | null`）。

---

## 4.5 D6 · 皇榜（排行榜）

> 定位：本玩法进度的**派生展示面**，不是新玩法模式（不违反"本分支只含诗词升官"）；
> 零 schema 改动（rank/totalExp/nickname 全部是服务端结算权威写入的既有数据）；
> 评估结论 2026-09-20：成本 ≈60 行服务端 + 150 行前端，防作弊随既有结算通道白捡。

**冷启动（最大风险）**：纯逻辑层内置 **5 个虚拟榜位**（公版名人 + 架空官衔/功名，固定值，`isVirtual: true` 标记，架空称号不宣称真实官制），与真实数据合并排序。主题贴切（皇榜=金殿金榜），并为低进度玩家提供**追赶锚点**（进度系统前方要有可见目标，Meta §2.3）。
**低压力展示**（Octalysis：排行是 Black Hat 压力源，v1 取低压力形态）：
- 只展示 **Top 100** + 我的追赶卡片，不做全量名次；
- 我的位次用**追赶叙事**而非精确名次：`与第 N 位{称号}只有一卷之差（还差 X 功名）`（N = 我前面第一个人）；我进不了前 100 时显示 `距金榜还差 X 功名（上一位：第 100 名{称号}）`；
- 排序 `rank DESC, totalExp DESC`（官阶为主、功名细粒度防同阶并列僵局）。
**v1 不做赛季重置**：常青榜；赛季化钩子随 P2 限时事件框架一起做（避免现在引入时间轴复杂度）。
**防刷评估**：功名有界（每局 ≤10 题 × 计分上限，会话 TTL + 已见占用限速），Top 100 + 2 条 count 查询在单节点 SQLite 无压力。

**纯逻辑层 `src/lib/games/poetry/leaderboard.ts`（新建，零依赖）**：

```ts
export interface LeaderboardEntry {
  /** 展示名（真实玩家昵称 / 虚拟名人） */
  name: string;
  avatar: string;            // emoji（虚拟与真实同规格）
  rankLabel: string;         // 官衔称号（架空）
  totalExp: number;
  isVirtual: boolean;
}
/** 虚拟榜位（5 个公版名人，固定官衔/功名；架空，不宣称真实官制） */
export const VIRTUAL_ENTRIES: LeaderboardEntry[]; // 李白·翰林 / 苏轼·侍郎 / 辛弃疾·知府 / 王勃·举人 / 孟浩然·秀才

/** 合并排序：官阶 → 功名 → name（虚拟与真实同规则；rankLabel 由 rank id 查 RANKS 表回填） */
export function mergeLeaderboard(
  real: Array<{ name: string; avatar: string; rank: number; totalExp: number }>,
  limit = 100,
): LeaderboardEntry[];
```

**API**（GET 明文，与 `/api/games/poetry/rank` 同模式）：

```ts
// GET /api/games/poetry/rank/leaderboard
// 出参：
export interface LeaderboardView {
  items: LeaderboardEntry[];              // Top 100（虚拟+真实合并）
  my: {
    rankLabel: string;
    totalExp: number;
    /** 我前面的人数（名次 = 该值 + 1；不含虚拟位时另行标注） */
    aboveCount: number;
    /** 追赶叙事目标：我前面最近一位的 totalExp（算 gapToAbove 用） */
    aboveExp: number;
  } | null;                               // playerId 缺失/未注册时 null
}
```

- 服务端：`prisma.playerRank.findMany({ include: { player: { select: { nickname, avatar } } }, orderBy: [{ rank: "desc" }, { totalExp: "desc" }], take: 200 })` → `mergeLeaderboard` 截 100；`my` = `playerRank.findUnique` + `count({ where: { OR: [{ rank: > 我的 rank }, { rank: = 我的 rank, totalExp: > 我的 exp }] } })`。
- 前端 `src/app/play/poetry-rank/leaderboard/page.tsx`：金榜样式（琥珀金主题，与 indigo 主调形成"金殿"反差）；列表 Top 100（前三名 🥇🥈🥉 或印章标记，虚拟位带名人小传一句话 hover/点击）；底部我的追赶卡片（§4.5 叙事文案）。IDLE 页右上 🏮 入口旁加 📜「皇榜」。
- 测试：
  - 单测：`mergeLeaderboard` 官阶/功名排序、虚拟位混排、limit 截断、同官阶同功名不抖动（稳定排序，加 name 作第三键）；
  - 集成：leaderboard 路由（空库 → 全虚拟位；注入玩家 → 排序与 aboveCount/gap 正确；playerId 缺失 → my=null 200）。
  - 浏览器：空库渲染虚拟榜；注入后名次与追赶文案；窄屏。

---

## 5. API 与路由清单（汇总）

| 路由 | 方法 | 加密 | 新增/改造 |
| --- | --- | --- | --- |
| `/api/games/poetry/rank` | GET | 明文 | 改造：RankView + seenCount/recent/badges/daily/guess/corpusTotal |
| `/api/games/poetry/rank/start` | POST | withCrypto | 改造：kind 放行 DAILY；视图 + persona/opening |
| `/api/games/poetry/rank/answer` | POST | withCrypto | 改造：视图 + feedback；结算 + settleLine/newBadges/hintUsed 折名 |
| `/api/games/poetry/rank/resume` | POST | withCrypto | 改造：视图 + persona/opening + hintRemoved（已用提示的灰置恢复） |
| `/api/games/poetry/rank/ledger` | GET | 明文 | 新增：功名簿数据 |
| `/api/games/poetry/rank/gallery` | GET | 明文 | 新增：诗词阁分页 |
| `/api/games/poetry/rank/hint` | POST | withCrypto | 新增：问同窗 |
| `/api/games/poetry/rank/guess` | POST | withCrypto | 新增：剪影竞猜 |
| `/api/games/poetry/rank/leaderboard` | GET | 明文 | 新增：皇榜（Top 100 + 我的追赶卡，D6） |

新增路由全部薄壳（`withCrypto` 包装 + 参数校验），业务落 `rank-service.ts`（同文件新增分区，保持官阶业务单点）；gallery/ledger 的只读查询可独立 `gallery-service.ts`（避免 rank-service 继续膨胀）。

---

## 6. 前端状态机与组件清单

**rank-store.ts 增量**（现有字段不动）：
- `persona: PersonaKey | null`、`opening: string`、`lastJudge.feedback: string`、`lastSummary.settleLine/newBadges/hintUsed`；
- IDLE 新增数据：`daily: DailyView | null`、`guess: GuessView | null`、`recent`、`badges: string[]`（来自 GET rank 视图）。

**组件清单**：

| 组件 | 状态 | 职责 |
| --- | --- | --- |
| `rank-identity-card.tsx` | 新建 | 身份卡（D1） |
| `persona-bubble.tsx` | 新建 | 对话气泡（头像/表情/题面/反馈）（D1） |
| `rank-road.tsx` | 重写 | 迷雾路线图（D1） |
| `rank-settle-view.tsx` | 扩展 | 仪式感结算（D1） |
| `ledger/page.tsx` + 成就宫格/月历组件 | 新建 | 功名簿（D2） |
| `gallery/page.tsx` + 诗卡组件 | 新建 | 诗词阁（D3） |
| `choice-list.tsx` | 微调 | 胶囊化 + 灰置（hint 移除项） |
| `judge-card.tsx` | 改造 | 并入 persona-bubble 反馈（或保留壳换内容） |

**美术引用约定**：`/art/q_hero_rank00_buyi.png` … `/art/q_hero_rank10_emperor.png`（12 张）、`/art/q_npc_examiner.png`、`/art/q_npc_tutor.png`、`/art/q_expr_{npc}_{happy|surprised|sad}.png`（8 张）、封面 `/art/cover_v1.png`。D5 前全部占位 emoji，引用处统一走常量表 `src/lib/art-assets.ts`（D5 只改这张表，组件不动）。

---

## 7. 测试计划（每期必过：tsc 0 错 + lint 0 警 + 全量单测 + 构建）

**D1**：
- `tests/games/poetry/persona.test.ts`：同 seed 同句（确定性）；反馈句不含答案/选项文本（构造 100 个 round 断言）；personaFor 映射（DAILY→TUTOR、EXAM+10→EMPEROR）。
- `tests/db/rank-integration.test.ts` 增：start 视图含 persona/opening；answer 视图含 feedback；结算 settleLine 三分支（PROMOTED/EXAM_FAILED/KIND_NOT_EXAM）。
- 浏览器：IDLE 身份卡/迷雾/估算行；对话气泡走一局；结算擢升动画与台词。

**D2**：
- 纯逻辑：`evaluateAchievements` 10 条条件表驱动单测（每条正/反例）；`localDate` 边界（UTC+8 与 UTC 日期切换日）。
- 集成：DAILY 幂等（同日二次 start 409；结算前二次 start 返回可恢复）；DAILY 不晋升；周奖幂等键补记（构造跨周）；成就落库幂等（重复结算不重复发）；badges 视图。
- 浏览器：月历渲染；功名簿页；每日题 1 题闭环。

**D3**：
- 引擎：FILL_CHAR/DYNASTY_PICK 素材化单测（seed 复现；挖字位 CJK 过滤；干扰项 ≠ correct；strictOptions 弃素材）；`rankId<3` 不混入新题型（断言 200 局无 FILL_CHAR）；`rankId>=3` 混入率 ≈30%±（seed 固定断言精确值）。
- **容量审计重跑**（`poetry-capacity-audit.ts`）：新题型纳入后各窗口容量报告更新，缺口数字复核。
- 集成：PlayerPoem 落库（答对/答错都入阁；mastered 仅答对置位；poemId 去重）；gallery 分页/分组。
- 浏览器：诗词阁过滤与诗卡；新题型走一局（题面 □ 渲染）。

**D4**：
- 集成：hint 原子抢占（并发双请求仅 1 成功）；removedIndexes 全 ≠ answerIndex（1000 次随机断言）；结算功名 ×0.8；resume 恢复灰置；guess 每日幂等、+100 功名、皇帝拒绝。
- 浏览器：问同窗灰置 2 项；竞猜卡片当日状态。

**D5**：
- 资产入库后：12 张立绘一致性目视（对照 §2.2 装束表逐阶核对道具）；全浏览器回归（原 15 项 + D1-D4 新增项）。

**D6**：
- 单测：`mergeLeaderboard`（官阶/功名/name 三键稳定排序、虚拟位混排、limit 截断、空 real 返回全虚拟）。
- 集成：路由（空库 → 全虚拟位且 `my=null`；注入 3 玩家 → 排序/aboveCount/aboveExp 精确断言；playerId 缺失 → 200 + my=null）。
- 浏览器：空库渲染；注入后追赶文案与名次；前三名样式；窄屏。

---

## 8. 明确不做（边界声明）

- 不做好友/账号体系（匿名体系限制，方案 §5.5）；**皇榜例外已落 D6**（纯派生只读视图，无社交关系，不算玩法模式）；
- 皇榜 v1 不做赛季重置、不做精确名次全量展示（§4.5）；
- 不做真实官制宣称（架空文案红线）；
- 不做付费/广告（副业项目当前阶段）；
- 不引入新玩法模式（本分支只含诗词升官）；
- 提示/竞猜不泄答案（§4 红线），所有判定服务端收口；
- 外观/限时事件/分享卡（P2）仅预留接口位，本期不实现。
