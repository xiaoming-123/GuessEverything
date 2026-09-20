# 诗词升官 · 优化详细设计（2026-09-20）

> 上游方案：`docs/design/2026-09-20-poetry-rank-optimization-and-art.md`（v2，人物/可玩性/解锁/吸引力要素）。
> 评估依据：`docs/design/2026-09-20-poetry-rank-design-review.md`（2026-09-20，A1–A10 / B1–B10 / C3–C4 修订已全部应用本文，落点以「review Xn」标注）。
> 本文是落地层：数据模型 diff、纯逻辑层接口、API 契约、服务端时序、前端状态机、测试计划。
> 架构红线不变：`lib/games/` 零依赖纯函数；答案永不下发；门禁服务端强制；结算幂等；语料仅公版。
> 代码事实基线（2026-09-20 读取）：`rank-service.ts` 678 行、`engine.ts` 375 行、`schema.prisma` 121 行、页面 348 行。
> 修订（2026-09-20 晚）：新增 D0 语料扩容并行轨；DAILY 过期重建 / 皇帝阶题数 / kind 推导单点化；补签字段与路由；
> recentGames/seenCount 提前至 D1；seenCount 口径过滤；FILL_CHAR faceKey 带 pos 与三处解析链改造；
> DYNASTY_PICK 干扰口径放宽为真实朝代白名单；hint 持久化 hintRoundIndex；剪影竞猜改猜迷雾阶（rankId+2）；
> 皇榜追赶目标从合并列表计算 + 虚拟位功名利值；全文「12 阶」勘正为 11 阶（RANKS 0..10 共 11 条）。

## 0. 总览与分期

| 期 | 内容 | 涉及层 | 验收 |
| --- | --- | --- | --- |
| D0（并行轨） | 语料扩容：全部玩法层扩充的物理前置（容量审计已判 48 首全路径阻塞，D2 每日题 / D3 新题型均加速耗池）。执行计划见 `2026-09-20-poetry-corpus-plan.md` | 语料 + 审计脚本 | `poetry-capacity-audit.ts` 重跑：60% 正确率全路径真实引擎回放可行 |
| D1 | 人设对话系统 + 主页重做（身份卡/功名估算/路线图迷雾）+ 结算仪式感 | 纯逻辑 + 服务端视图 + 前端 | 单测 + 浏览器 |
| D2 | 每日题 DAILY + 月历 + 成就徽章 + 功名簿页 | schema + 纯逻辑 + API + 前端 | 单测 + 集成 + 浏览器 |
| D3 | 诗词阁 + 2 类新题型（引擎 + 容量口径同步） | schema + 引擎 + 容量审计 + 前端 | 单测 + 审计脚本 + 浏览器 |
| D4 | 问同窗提示 + 剪影竞猜 | API + 前端 | 集成 + 浏览器 |
| D5 | 美术批量（11 阶 Q 版主角 + 表情包）入库 + 全量终验 | 资产 + 前端 | 构建 + 浏览器 15+ 项 |
| D6 | 皇榜（排行榜，纯派生视图 + 虚拟榜位 + 低压力展示） | 纯逻辑 + API + 前端 | 单测 + 集成 + 浏览器 |

P2（内侍/同窗/说书人立绘、限时事件框架、分享卡、外观）不在本文展开，仅列接口预留位。

**D0 扩容门槛（按审计模型反推，D2 上线的硬前置）**：现 48 首 / 全库题面并集 693 道；100% 正确率路径需 805 题（知府→侍郎 EXAM 阻塞）、60% 正确率需 1425 题（贡士→进士即阻塞）。每日题上线后每玩家每日至少再耗 1 个已见键、D3 新题型加速消耗——**D2 上线前全库题面并集 ≥ 1500（≈ 现量 2.2 倍，保 60% 正确率全路径回放可行）、朝代覆盖 ≥ 5 个**（DYNASTY_PICK 干扰项质量依赖，见 §3.3；不足 5 朝代时该题型按白名单兜底可运行但干扰项重复度高）。D3 的容量审计重跑一律以扩容后语料为准。

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
- **功名估算**：`est = ceil(expToNext / avgExp)`，`avgExp` = 最近 3 局 `expGained` 均值（数据源：`RankView.recentGames` 近 3 局数组，见 §2.3——review A8：字段定义与**交付期一并从 D2 提前到 D1**，消除"D1 使用、D2 定义"的排期倒挂；不足 3 局用全部，无局则不显示估算行）；文案 `还差 {expToNext} 功名，约 {est} 局研习`。
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
- 最近战绩：一行 `上一局 {KIND_LABEL} · 正确率 {x}% · +{expGained} 功名` + `已见 {seenPoems} 题`（数据源：`recentGames[0]` 与 `seenCount`，见 §2.3，D1 交付）。

### 1.5 结算仪式感（rank-settle-view.tsx 扩展）

- **擢升（PROMOTED）**：上下两段对比——旧官衔（小、置灰）→ 新官衔（大、琥珀金描边、Q 版立绘放大 1.2× + 入场 300ms 缩放动画，CSS keyframes）；`settleLine` 居中台词；功名入账滚动数字（requestAnimationFrame 800ms，纯展示）。
- **失败（EXAM_FAILED）**：`failLine`（含正确率与缺口题数）+「直接重考」主按钮（调 start EXAM，现有逻辑）+「回官途」次按钮。
- **研习（KIND_NOT_EXAM）**：`practiceLine` + 功名条从旧值到新值的宽度动画（CSS transition）。
- **皇帝终点**：布衣 → 皇帝两张立绘并排 + 固定文案「位极人臣，已登天子（架空称号终点）」。

---

## 2. D2 · 每日题 + 成就 + 功名簿

### 2.1 每日题（DAILY）

**规则**：每天 1 题（服务端日期 `Asia/Shanghai` 口径，`Date.now()` + `Intl.DateTimeFormat` 取本地日）；出题官阶 = 玩家当前官阶的 `gradeWindow`（研习窗口，非科考窗口）；功名正常计入 totalExp（与研习同口径，经同一结算通道）；不晋升（`evaluatePromotion` 的 KIND_NOT_EXAM 分支天然覆盖）。

**countFor 修正（review A6，rank.ts 改动，D2 首个提交）**：现有 `countFor` 的 `if (r.isEmperor) return EMPEROR_COUNT` **先于 kind 判断**——皇帝阶玩家开 DAILY 会出 15 题，且 rank 10 窗口 [12,12] 有效池仅 22 题，每天烧 15 个已见键、不到两天断粮，还挤占登极大考的池子。改为：

```ts
export function countFor(rankId: number, kind: RankKind): number {
  if (kind === "DAILY") return DAILY_COUNT;   // 每日题恒 1 题，皇帝阶也一样
  const r = rankById(rankId);
  if (r.isEmperor) return EMPEROR_COUNT;
  if (kind === "EXAM") return EXAM_COUNT;
  return PRACTICE_COUNT;
}
```

单测断言：`countFor(10, "DAILY") === 1`（现有测试套件里若有皇帝 DAILY=15 的断言一并更正）。

**kind 推导单点化（review A7，rank-service.ts 三处改造站点，全部列入 D2 改动清单）**：

| 站点 | 现状（代码行号基线 2026-09-20） | 改造 |
| --- | --- | --- |
| `startRankedSession` 目标官阶推导（:147） | `targetId = kind === "PRACTICE" ? currentRankId : currentRankId + 1`——DAILY 落入 else 取 current+1，**越级出题，违反红线** | `targetId = kind === "EXAM" ? currentRankId + 1 : currentRankId`（PRACTICE 与 DAILY 同取当前阶） |
| `judgeRankedAnswer` 结算 kind（:357） | `session.stage === "EXAM" ? "EXAM" : "PRACTICE"`——DAILY 静默降级成 PRACTICE，结算摘要 kind / persona 映射全错 | 抽单点函数 `kindOfStage(stage: string): RankKind`（`"EXAM"→EXAM / "DAILY"→DAILY / 其余→PRACTICE`），此处与 resume 共用 |
| `resumeRankedSession` 视图 kind（:670） | 同款三元——恢复的每日题显示成研习 | 改用 `kindOfStage` |

`kindOfStage` 落 `rank-service.ts`（或纯逻辑层 `types.ts` 旁的工具），集成测试断言：DAILY 局 start/answer/resume 三视图 kind 均为 `"DAILY"`，且出题窗口 = 当前官阶 gradeWindow（构造 rank 3 玩家断言所有 round 素材 grade ∈ [3,7]）。

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
  /// 补签标记（review A10）：仅对「过期未答（missing）」的历史日可由补签置 true；
  /// 只影响月历展示与周连满判定，不加功名。真实作答日恒 false。
  madeUp    Boolean @default(false)
  createdAt DateTime @default(now())

  @@unique([playerId, date])
  @@index([playerId, date])
}
```

（无外键、只有 playerId 字符串——与既有 PlayerSeenKey 同风格，**有意为之**：匿名体系下玩家不删、免迁移负担，后人勿"补全外键"。PlayerAchievement / PlayerPoem / RankGuess 同此，review B10。）

**服务端时序**（`startRankedSession` 增 DAILY 分支）：
1. `kind === "DAILY"` 时：`date = localDate()`；`daily = prisma.playerDaily.findUnique({ where: { playerId_date } })`；
   - 存在且 `settled` → 409「今日已答完」；
   - 存在且未结算 → 查关联会话：
     - 会话 ACTIVE 且未过期 → 409 + 返回可恢复会话（复用 resume 语义，客户端转 resume）；
     - **会话已 EXPIRED / 不存在（review A2 死锁修复）→ 事务内 `update` 占位换新 sessionId、重建会话**——旧会话作废不结算（功名不入账，与 PRACTICE 弃局同口径），当日机会不因超时卡死；
   - 不存在 → 事务内 `create` 占位（先占位后选题，P2002 冲突即重试换日逻辑：换种子），`rankId = 当前官阶`，`roundCount = 1`，`stage = "DAILY"`。
2. `judgeRankedAnswer` 末题结算分支：DAILY 与 PRACTICE/EXAM 同通道；结算事务内补 `playerDaily.update({ settled: true })`。
3. `startRankedSession` 入参 kind 联合类型扩为 `"PRACTICE" | "EXAM" | "DAILY"`（types.ts 的 `RankKind` 已含 DAILY，仅服务端此前拒绝，改为放行）。
4. **补签（streak freeze，review A10 补全）**：`POST /api/games/poetry/rank/makeup`（withCrypto，入参 `{ date }`）——服务端校验：① date 属**上一个自然月**且该日 PlayerDaily 不存在或 `settled=false`（真实过期缺答）；② 本自然月配额未用尽（`playerDaily.count({ playerId, date: 本月前缀, madeUp: true }) < 1`）；通过后 `upsert` 该日 `{ settled: true, madeUp: true }`。**不加功名**（纯展示奖励，防刷）；只影响月历 cells 状态与周连满判定。
5. 月历断签不清零功名（功名本就只增不减，天然合规）。

**月历视图**（`RankView` 扩展字段 `daily: DailyView`）：

```ts
export interface DailyView {
  /** 当月真实天数格（review B2：弃 28 格简化月历——29-31 日无处安放且与 ISO 周对不齐）：
   *  当月 1 号起、周一起排，首尾以 null 补空位；每格状态：
   *  done=已答 / made=补签（展示区别色）/ pending=今日未答 / future / missing=过期未答 */
  cells: Array<{ date: string; state: "done" | "made" | "pending" | "future" | "missing" } | null>;
  /** 本月周连满次数（ISO 周口径：周一..周日 7 天全 done|made 记 1 次；跨月的周按其周四所在月归属，与 YYYY-WW 键一致） */
  weeksCompleted: number;
  /** 本周周奖（weeksCompleted 对应档位，纯展示；周奖功名在周一首局结算时补记 200/周，幂等键 playerId:YYYY-WW，ISO 8601 周号） */
  weeklyBonus: number;
  /** 本月补签配额剩余（0 或 1） */
  makeupLeft: number;
}
```

**周奖补记（review B3 追溯范围收敛）**：服务端在任意一局结算事务中检查 `PlayerRank.weeklyBonusKeys`（见 2.2 PlayerRank 扩展），**仅补记「最近 8 个已完结 ISO 周」内、PlayerDaily 历史可证真实连满（7 天全 done|made）且键未发过的周**——不做全历史扫描（老玩家一次结算触发全表扫描的风险），8 周窗口覆盖长假回归场景已足够。连满判定纯函数 `completedWeeks(dailies, now)` 落纯逻辑层（零依赖，可单测：构造跨月/跨年/补签混合数据断言）。

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
- `maxCombo` 推导：结算事务内按 `answers` 升序扫一遍算最大连续 correct 段（10 题规模，O(n)）。**前提（review B5）**：现有结算 findMany（rank-service.ts:517）select 只有 `correct/gained`、无 orderBy——改造为 `select: { roundIndex, correct, gained }, orderBy: { roundIndex: "asc" }`，否则"升序"无从谈起。

### 2.3 RankView 扩展（GET /api/games/poetry/rank 明文视图）

> review A8：`recentGames` / `seenCount` 的**交付期提前到 D1**（§1.4 功名估算与最近战绩的使用方在 D1）；D2 增量只有 `badges` / `daily` / `guess` / `corpusTotal`。

```ts
export interface RankView {
  // …现有字段不变…
  /** 已见题累计（功名簿/最近战绩展示）。
   *  口径（review A5）：PlayerSeenKey 同时存 sourceKey 行（`poemId:lineIndex:type`，冒号分隔）
   *  与 faceKey 行（`type|prompt|correct`，竖线分隔），直接 count() ≈ 2× 真实题数——
   *  只数 sourceKey 行：`count({ where: { playerId, key: { contains: ":" } } })`
   *  （faceKey 首段是题型枚举名，不含冒号；判别式对两种 key 格式恒成立）。 */
  seenCount: number;
  /** 近 3 局战绩（最新在前；D1 功名估算 avgExp 与"最近战绩"行共用） */
  recentGames: Array<{ kind: RankKind; expGained: number; accuracy: number }>;
  /** 已获成就 key 集（D2） */
  badges: string[];
  /** 每日题月历（D2） */
  daily: DailyView;
  /** 剪影竞猜当日状态（D4） */
  guess: { done: boolean; correct?: boolean; gained?: number } | null;
  /** 语料总数（D3 诗词阁分母，`Poem.count()`） */
  corpusTotal: number;
}
```

- `recentGames` 实现（review A8/B4）：`gameSession.findMany({ where: { playerId, kind: "RANKED", status: "FINISHED" }, orderBy: { createdAt: "desc" }, take: 3 })`；`expGained` 直接取 `score` 字段——**结算时 score 落库口径统一为「实际入账功名」**（hint 折后值，见 §4.1，review B4），因此 recentGames 无需再聚合 AnswerRecord；`accuracy` 库中无字段，结算事务尾将 accuracy 一并写入 `GameSession` 新增字段 `accuracy Int @default(0)`（schema diff 归入 D2，D1 先用 AnswerRecord 聚合过渡亦可——二选一，推荐直接加字段，一次迁移）。
- 查询成本：`PlayerSeenKey.count` + `gameSession.findMany(take 3)` + `PlayerAchievement.findMany(select key)` + 当月 `PlayerDaily.findMany` + `Poem.count`——5 条索引查询，SQLite 单文件无压力。

### 2.4 功名簿页（`src/app/play/poetry-rank/ledger/page.tsx`，新建）

- 三区块：成就宫格（10 格，已获=彩色+日期，未获=剪影+条件描述）/ 月历（§2.1 cells 渲染，含补签格与 makeup 入口）/ 功名总览（totalExp、seenCount、近 10 局小柱状图，数据源：`gameSession` 近 10 局 select kind+score+createdAt——score 即实际入账功名（§2.3 口径），柱状图与 recentGames 同源同口径（review C4）；GET 明文 `/api/games/poetry/rank/ledger`）。
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

**engine.ts 改动**（`rankedRoundPool` / `materializeRound` / `faceKey` / `materialKey`，**含 review A4 的三处解析链改造——只改 materialKey 会让已见排除对新题型静默失效**）：

- `materialKey` 对 FILL_CHAR 扩为 `poemId:lineIndex:FILL_CHAR:pos`（pos = 挖字位置，防同句不同字位互斥）；其余题型格式不变。
- **`faceKey` 增加 pos 维度（review A4-3）**：签名扩为 `faceKey(item, lineIndex, type, pos?)`，FILL_CHAR 分支返回 `type|prompt(含□)|correct|pos`——同句不同挖字位是两个不同题面（□ 位置不同，prompt 本就不同，pos 显式入 key 保证与 materialKey 同粒度）；其余题型忽略 pos，格式不变。
- **`faceKeyOfKey` 改造（review A4-1，engine.ts:354-375）**：现有实现 `parts.pop()` 取 type、再 pop 取 lineIndex——四段 FILL_CHAR key 会 pop 出 pos 当 type → NaN → return undefined → 已见 FILL_CHAR 的题面排除静默失效。改为：pop 出的末段若是纯数字且倒数第二段是 `FILL_CHAR`，则再 pop 一次取 pos；题型白名单（366-372 行）加入 FILL_CHAR / DYNASTY_PICK。单测：四段 key 的 `faceKeyOfKey` 往返（materialKey → faceKeyOfKey ≡ faceKey 直算）。
- **`collectSeenKeys` 改造（review A4-2，rank-service.ts:269-292）**：byKey 映射现在只按三段格式构建——四段 sourceKey 查不到 → faceKey 不落库 → 换 poemId 绕过去重的防线对新题型失效。改为：素材枚举时 FILL_CHAR 同步枚举 pos（与 `rankedRoundPool` 同口径），byKey 键用四段格式；或更简单——直接从 round 反查语料重构 faceKey（round.meta 补 `lineIndex/pos` 两字段，服务端专用不下发）。推荐后者，改动面小且消除"两处枚举必须一致"的隐式耦合。
- 素材枚举：`rankedRoundPool` 的每 (item, lineIndex) 循环改为：
  - 恒加 3 基础题型；
  - FILL_CHAR：每句 1 个候选，`pos = rand 选 CJK 字位`（过滤：该字为 `\u4e00-\u9fff`、非标点、句中 CJK 字数 ≥ 2）；
  - DYNASTY_PICK：每句 1 个候选（选项 = 朝代名，无需 pos）。
  - 题型混合权重（心流"有张有驰"）：`rankId < 3` 仅基础 3 型（低阶不混入，容量与体验优先）；`rankId >= 3` 起 FILL_CHAR/DYNASTY_PICK 各按 30% 概率追加（rand 判定，seed 确定可复现）。**注（review B9）**：30% 是素材追加的名义概率；DYNASTY_PICK 的 prompt 与同素材 GUESS_POET/GUESS_TITLE 同题干，局内 seenPrompts 去重会吃掉一部分，实际混入率略低——测试断言一律写"seed 固定下的精确值"，不断言 30% 区间。
- `materializeRound` 新增两分支：
  - **FILL_CHAR**：`prompt = line 挖字为「□」`（保留原句其余文字）；`correct = 被挖字`；干扰项池 = 同诗其余 CJK 字 + 同朝代其他诗的 CJK 字（`distractors.ts` 新增 `charDistractorPool(pool, item, char)`：去重、≠correct、取 3；不足 3 判该素材无效跳过）。
  - **DYNASTY_PICK**：`prompt = pickQuote(item, lineIndex)`；`correct = item.dynasty`；干扰项池 = **真实朝代白名单**（见 §3.3，review A1）中 ≠ correct 的朝代按语料出现频次降序、白名单补位，取 3。
- **容量审计同步**（capacity.ts）：`ALL_TYPES` 数组（capacity.ts:23-27）加两型，`distinctFacesByGrade/totalDistinctFaces` 自动同口径；FILL_CHAR 的 faceKey 含 pos 意味着理论题面数按 pos 展开——审计脚本 `poetry-capacity-audit.ts` 重跑时须在报告注明"新题型题面含挖字位维度，总数与旧口径不可直接对比"。
- 判题/结算/已见/答案记录路径**零改动**（PoetryRound 结构不变：prompt + 4 options + answerIndex；meta 增 lineIndex/pos 为服务端专用字段，`toRoundView` 已剥离 meta，视图契约不变）。

### 3.3 干扰项质量红线

- FILL_CHAR 干扰字不得与 correct 同字（含异体字不处理，公版语料以字面为准）；单字选项 UI 样式与句选项一致（choice-list 不感知题型差异）。
- **DYNASTY_PICK 干扰朝代口径（review A1 修订）**：原红线"干扰朝代必须真实存在于语料"在当前语料下不可行——实测 48 首仅唐(27)/宋(18)/清(3) 三朝代，`strictOptions=true` 下正确 1 + 语料内干扰 3 永远凑不齐，题型上线即全素材判废（死代码）。修订为：**干扰项取自固定「真实朝代白名单」**（纯逻辑层常量：`["唐","宋","元","明","清","汉","魏晋","南北朝"]`，全部真实存在过的朝代，不违背"不可能选项送分感"的原始动机——该动机针对的是虚构朝代）；池内优先语料出现频次降序，不足 3 个从白名单补位。D0 扩容达成 ≥5 朝代后，语料内干扰项自然成为主流，白名单退居兜底。单测：构造仅 2 朝代的小语料断言 DYNASTY_PICK 仍可素材化（白名单补位生效）；构造 5 朝代语料断言干扰项优先取语料内高频朝代。
- 两题型均走 `strictOptions=true`（ranked 模式既有严格口径：白名单补位后仍不足 3 干扰即弃素材——只对 FILL_CHAR 可能发生，如全诗 CJK 字过少）。

---

## 4. D4 · 问同窗 + 剪影竞猜

### 4.1 问同窗（每局 1 次提示）

**规则**：一局一次；代价 = 本局最终功名 ×0.8（结算时应用，`GameSession.hintUsed` 标记）；效果 = 移除 2 个错误选项（剩 3 选 1，**不泄答案**：响应只含被移除索引，客户端灰置）；仅对当前未答轮次有效（下一题自动失效，服务端按 `roundIndex` 校验：提示针对请求时的当前题）。

**schema diff**：`GameSession` 增三字段——`hintUsed Boolean @default(false)`、`hintRoundIndex Int?`（**review A9：提示作用于第几题必须持久化**，否则 resume 恢复时客户端无法判断灰置该套在哪一题：hint 后答完该题再刷新，resume 回到下一题，仅凭 hintRemoved 会把灰置错误套到新题的选项上）、`hintRemoved Json @default("[]")`（被移除选项索引数组）。

**API**：`POST /api/games/poetry/rank/hint`（withCrypto）：

```ts
// 入参 { gameSessionId: string, roundIndex: number }
// 出参 { removedIndexes: number[] }   // 恒 2 个，均 ≠ answerIndex
// 错误：404 对局不存在 / 410 已结束或超时 / 409 本局已用过提示 / 400 轮次已答
```

**服务端时序**（单事务）：
1. 校验会话 ACTIVE、未超时、`roundIndex` 无 AnswerRecord、`hintUsed === false`；
2. `rounds[roundIndex].options` 中排除 `answerIndex` 的索引集合，rand（`Math.random` 一次性消费，无复现需求）取 2；
3. `updateMany({ where: { id, hintUsed: false }, data: { hintUsed: true, hintRoundIndex: roundIndex, hintRemoved } })` 原子抢占，count===0 即 409。

**resume 视图**：`RankedResumeView` 增 `hint: { roundIndex: number; removedIndexes: number[] } | null`——客户端**仅当 `hint.roundIndex === currentIndex` 时灰置**（review A9）；答过该题后 hint 自然失效不再渲染。

**结算应用**：`settleRankedSession` 功名记账处：`const exp = hintUsed ? Math.round(sessionScore * 0.8) : sessionScore`；`RankSummary.expGained` 用折后值；`RankSummary` 增 `hintUsed: boolean`。**落库口径（review B4）**：`GameSession.score` 统一写**折后值**（= 实际入账功名）——recentGames / 功名簿柱状图直接取 score，不再聚合 AnswerRecord，全站一个口径。

**合规校验**：`hintRemoved` 全 ≠ answerIndex（单测断言 1000 次随机全过）。

### 4.2 剪影竞猜（每日 1 次小彩蛋）

**规则（review A3 重设计）**：IDLE 页"猜猜**再下一阶**（迷雾阶）的官衔是什么"。

> 原设计猜 `rankId+1` 有三重硬伤，全部废弃：① D1 迷雾规定下一阶**称号可见**（只虚化副标题），抬头看路线图就有答案；② RANKS 是客户端可 import 的纯逻辑常量，判据 `RANKS[rankId+1].label` 是完全公开信息，+100 功名/日退化为无脑点击脚本可刷；③ rankId=9 时选项会露出"皇帝"，破坏"拜相结算才揭晓登极大考"的叙事红线。
> 改为猜 **rankId+2（迷雾阶，称号被 ？？？ 遮住的阶）**——这才是真正被隐藏的信息，竞猜与迷雾互相成就。
> 诚实定位：RANKS 仍是客户端常量，硬核玩家翻代码仍可查——本机制定位是**每日点击奖励 + 探索心理锚定**（"猜猜上面是什么"），不是防作弊挑战；+100 功名/日金额小、单玩家自娱，可接受。文档不再宣称"竞猜挑战"。

- 选项 4 个：`RANKS[rankId+2].label`（真答案）+ 3 个干扰称号（从 RANKS 其他阶取，客户端渲染池，服务端不下发选项）；
- 边界：`rankId >= 8`（侍郎及以上）时 rankId+2 越界或触及皇帝 → **竞猜入口整体隐藏**（服务端 GET 视图 `guess = null` + 前端不渲染；皇帝信息在拜相前绝不从任何入口露出）；
- 每日 1 次；猜中 +100 功名（不走 0.8 折价——提示代价只作用对局）；**不晋升、不解锁任何门禁**。

**schema diff**：

```prisma
/// 剪影竞猜（一玩家一日一次；猜 rankId+2 迷雾阶称号）
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
- 错误：409 今日已猜 / 403 `rankId >= 8`（无迷雾下两阶可猜，含皇帝保护）。
- 服务端判据：`guessLabel === RANKS[playerRank.rank + 2].label`（结算时刻读当前官阶，事务内占位 RankGuess 唯一键幂等）；功名记账走 `playerRank.update`（+100）。
- 前端：IDLE 路线图下方小卡片（仅 `rankId < 8` 渲染），当日已猜显示结果（GET 视图 `RankView.guess`，见 §2.3）。

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
/** 虚拟榜位（5 个公版名人，固定官衔/功名；架空，不宣称真实官制）。
 *  功名利值（review C3）：落在对应官阶 expToReach 附近，保证"官阶为主排序"下功名与官衔自洽——
 *  翰林(expToReach 48000)→52000 / 侍郎(108000)→112000 / 知府(72000)→76000 /
 *  举人(10000)→12000 / 秀才(5000)→6000。 */
export const VIRTUAL_ENTRIES: LeaderboardEntry[]; // 李白·翰林·52000 / 苏轼·侍郎·112000 / 辛弃疾·知府·76000 / 王勃·举人·12000 / 孟浩然·秀才·6000

/** 合并排序：官阶 → 功名 → name（虚拟与真实同规则；rankLabel 由 rank id 查 RANKS 表回填） */
export function mergeLeaderboard(
  real: Array<{ name: string; avatar: string; rank: number; totalExp: number }>,
  limit = 100,
): LeaderboardEntry[];

/** 我的追赶卡（review B6）：从「虚拟+真实合并后的完整排序列表」计算，
 *  而非只查真实玩家表——虚拟位压在头上时，追赶目标必须与列表所见一致。
 *  me = { rank, totalExp }；merged = mergeLeaderboard(real, +∞)（不截断）；
 *  above = merged 中严格排在我前面的第一位（同 rank 同 exp 时虚拟位在前、name 序稳定）；
 *  返回 { aboveCount, aboveName, aboveLabel, aboveExp } 或 null（我是榜首）。 */
export function myChaseTarget(
  me: { name: string; rank: number; totalExp: number },
  merged: LeaderboardEntry[],
): { aboveCount: number; aboveName: string; aboveLabel: string; aboveExp: number } | null;
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
    /** 我前面的人数（含虚拟位；名次 = 该值 + 1） */
    aboveCount: number;
    /** 追赶叙事目标（review B6：合并列表中我前面最近一位，虚拟位也可能是目标） */
    aboveName: string;
    aboveLabel: string;
    aboveExp: number;
  } | null;                               // playerId 缺失/未注册/我是榜首时 null 或 above 字段省略
}
```

- 服务端：`prisma.playerRank.findMany({ include: { player: { select: { nickname, avatar } } }, orderBy: [{ rank: "desc" }, { totalExp: "desc" }], take: 200 })` → `mergeLeaderboard` 截 100；`my` = `playerRank.findUnique` + `myChaseTarget`（纯函数，合并列表内计算，**不再用 count 查询**——count 只数真实玩家，会与含虚拟位的展示列表矛盾）。
- 前端 `src/app/play/poetry-rank/leaderboard/page.tsx`：金榜样式（琥珀金主题，与 indigo 主调形成"金殿"反差）；列表 Top 100（前三名 🥇🥈🥉 或印章标记，虚拟位带名人小传一句话 hover/点击）；底部我的追赶卡片（§4.5 叙事文案）。IDLE 页右上 🏮 入口旁加 📜「皇榜」。
- 测试：
  - 单测：`mergeLeaderboard` 官阶/功名排序、虚拟位混排、limit 截断、同官阶同功名不抖动（稳定排序，加 name 作第三键）；
  - 集成：leaderboard 路由（空库 → 全虚拟位；注入玩家 → 排序与 aboveCount/gap 正确；playerId 缺失 → my=null 200）。
  - 浏览器：空库渲染虚拟榜；注入后名次与追赶文案；窄屏。

---

## 5. API 与路由清单（汇总）

| 路由 | 方法 | 加密 | 新增/改造 |
| --- | --- | --- | --- |
| `/api/games/poetry/rank` | GET | 明文 | 改造：RankView + seenCount/recentGames（D1 交付）+ badges/daily/guess/corpusTotal（D2-D4） |
| `/api/games/poetry/rank/start` | POST | withCrypto | 改造：kind 放行 DAILY；视图 + persona/opening |
| `/api/games/poetry/rank/answer` | POST | withCrypto | 改造：视图 + feedback；结算 + settleLine/newBadges/hintUsed 折名 |
| `/api/games/poetry/rank/resume` | POST | withCrypto | 改造：视图 + persona/opening + hint（roundIndex+removedIndexes，按轮灰置恢复，review A9） |
| `/api/games/poetry/rank/ledger` | GET | 明文 | 新增：功名簿数据 |
| `/api/games/poetry/rank/gallery` | GET | 明文 | 新增：诗词阁分页 |
| `/api/games/poetry/rank/hint` | POST | withCrypto | 新增：问同窗 |
| `/api/games/poetry/rank/guess` | POST | withCrypto | 新增：剪影竞猜（猜 rankId+2 迷雾阶） |
| `/api/games/poetry/rank/makeup` | POST | withCrypto | 新增：每日题补签（review A10） |
| `/api/games/poetry/rank/leaderboard` | GET | 明文 | 新增：皇榜（Top 100 + 我的追赶卡，D6） |

新增路由全部薄壳（`withCrypto` 包装 + 参数校验），业务落 `rank-service.ts`（同文件新增分区，保持官阶业务单点）；gallery/ledger 的只读查询可独立 `gallery-service.ts`（避免 rank-service 继续膨胀）。

---

## 6. 前端状态机与组件清单

**rank-store.ts 增量**（现有字段不动）：
- `persona: PersonaKey | null`、`opening: string`、`lastJudge.feedback: string`、`lastSummary.settleLine/newBadges/hintUsed`；
- `hint: { roundIndex: number; removedIndexes: number[] } | null`（resume/start 下发；仅 `roundIndex === currentIndex` 时 choice-list 灰置，翻题即失效，review A9）；
- IDLE 新增数据：`daily: DailyView | null`、`guess: GuessView | null`、`recentGames`、`seenCount`、`badges: string[]`（来自 GET rank 视图）。

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

**美术引用约定**：`/art/q_hero_rank00_buyi.png` … `/art/q_hero_rank10_emperor.png`（**11 张**，RANKS 0..10 共 11 条；review B7 勘正原文"12 张"——rank00..rank10 恰 11 个文件，"12"是 v2 的贯穿性 off-by-one）、`/art/q_npc_examiner.png`、`/art/q_npc_tutor.png`、`/art/q_expr_{npc}_{happy|surprised|sad}.png`（**6 张**；normal 表情复用立绘本体不单出，2 NPC × 3 变体 + 2 立绘 = 核心 NPC 资产 8 件，review B8 勘正命名模式与"8 张表情"的口径冲突）、封面 `/art/cover_v1.png`。D5 前全部占位 emoji，引用处统一走常量表 `src/lib/art-assets.ts`（D5 只改这张表，组件不动）。

---

## 7. 测试计划（每期必过：tsc 0 错 + lint 0 警 + 全量单测 + 构建）

**D1**：
- `tests/games/poetry/persona.test.ts`：同 seed 同句（确定性）；**红线断言（review B1 修正）**——原"反馈句不含答案"不成立（GUESS_POET/GUESS_TITLE 的 explanation 判后揭晓本就含正确答案，如"出自《X》· 李白"，这是既有合规行为），改为：**判前视图（start/resume 下发的 rounds）不含 answerIndex/正确选项序**（构造 100 个 round 断言 toRoundView 输出无泄漏）；feedbackLine 断言"不含**未作答轮**的答案信息"；personaFor 映射（DAILY→TUTOR、EXAM+10→EMPEROR）。
- `tests/db/rank-integration.test.ts` 增：start 视图含 persona/opening；answer 视图含 feedback；结算 settleLine 三分支（PROMOTED/EXAM_FAILED/KIND_NOT_EXAM）；RankView.recentGames/seenCount（D1 交付字段：构造 3 局断言数组序与均值口径；seenCount 只数 sourceKey 行——构造含 faceKey 行的库断言不翻倍，review A5）。
- 浏览器：IDLE 身份卡/迷雾/估算行；对话气泡走一局；结算擢升动画与台词。

**D2**：
- 纯逻辑：`evaluateAchievements` 10 条条件表驱动单测（每条正/反例）；`localDate` 边界（UTC+8 与 UTC 日期切换日）；`countFor(10,"DAILY")===1`（review A6）；`completedWeeks` 跨月/跨年/补签混合数据（review B3）。
- 集成：DAILY 幂等（同日二次 start 409；结算前二次 start 返回可恢复）；**DAILY 会话过期后重开成功（review A2 死锁回归用例：占位存在 + 会话 EXPIRED → 新会话建成、当日不卡死）**；DAILY 出题窗口 = 当前官阶（rank 3 断言 grade ∈ [3,7]，review A7）；start/answer/resume 三视图 kind="DAILY"（kindOfStage，review A7）；DAILY 不晋升；周奖幂等键补记（构造跨周 + 8 周窗外不补，review B3）；补签（上月 missing 日成功、本月配额二次拒绝、非上月拒绝、不加功名，review A10）；成就落库幂等（重复结算不重复发）；badges 视图。
- 浏览器：月历渲染（真实天数 + 补签格）；功名簿页；每日题 1 题闭环；皇帝阶每日题仍 1 题。

**D3**：
- 引擎：FILL_CHAR/DYNASTY_PICK 素材化单测（seed 复现；挖字位 CJK 过滤；干扰项 ≠ correct；strictOptions 弃素材）；**四段 materialKey 解析链（review A4）**——`faceKeyOfKey` 对 FILL_CHAR 四段 key 的往返断言（materialKey → faceKeyOfKey ≡ faceKey(item, i, type, pos) 直算）、同句不同 pos 的 faceKey 互异、`collectSeenKeys` 对四段 sourceKey 产出 faceKey（非静默丢弃）；**DYNASTY_PICK 白名单兜底（review A1）**——2 朝代小语料可素材化、5 朝代语料优先语料内高频干扰；`rankId<3` 不混入新题型（断言 200 局无 FILL_CHAR）；`rankId>=3` 混入断言 seed 固定精确值（不断言 30% 区间，review B9）。
- **容量审计重跑**（`poetry-capacity-audit.ts`，以 D0 扩容后语料为准）：新题型纳入后各窗口容量报告更新，报告注明 FILL_CHAR 题面含 pos 维度、与旧口径不可直接对比；缺口数字复核。
- 集成：PlayerPoem 落库（答对/答错都入阁；mastered 仅答对置位；poemId 去重）；gallery 分页/分组。
- 浏览器：诗词阁过滤与诗卡；新题型走一局（题面 □ 渲染）。

**D4**：
- 集成：hint 原子抢占（并发双请求仅 1 成功）；removedIndexes 全 ≠ answerIndex（1000 次随机断言）；结算功名 ×0.8 且 GameSession.score 落折后值（review B4）；resume 恢复灰置**按 hintRoundIndex 套题**（构造"hint 第 3 题 → 答完第 3 题 → resume 到第 4 题"断言第 4 题无灰置，review A9）；guess 每日幂等、+100 功名、猜 rankId+2 判据、`rankId>=8` 时 403 + GET 视图 guess=null（review A3）。
- 浏览器：问同窗灰置 2 项；竞猜卡片当日状态；侍郎及以上玩家无竞猜入口。

**D5**：
- 资产入库后：**11 张**主角立绘一致性目视（对照 v2 §2.2 装束表逐阶核对道具；review B7）；全浏览器回归（原 15 项 + D1-D4 新增项）。

**D6**：
- 单测：`mergeLeaderboard`（官阶/功名/name 三键稳定排序、虚拟位混排、limit 截断、空 real 返回全虚拟）；**`myChaseTarget`（review B6）**——虚拟位压顶时追赶目标 = 虚拟位（aboveName/aboveLabel 正确）、同阶同功名边界、我是榜首返回 null。
- 集成：路由（空库 → 全虚拟位且 `my=null`；注入 3 玩家 → 排序/aboveCount/aboveExp 精确断言，含"玩家被虚拟位夹住"用例；playerId 缺失 → 200 + my=null）。
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
