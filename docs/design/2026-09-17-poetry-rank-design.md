# 诗词升官玩法 · 详细设计 & 数据库设计（v2，已按评审修订）

> 分支 `feature/poetry-rank` · 初稿 2026-09-17 · **v2 修订 2026-09-17**
> 本分支**只保留古诗词玩法**，深度优化并铺垫后续商业化。
> 演员 / 物品 / 飞花令在本分支**冻结**（代码不动、不参与实现，保留现状）。
>
> **修订依据**：`2026-09-17-poetry-rank-review-and-next.md`（方案评审，8 条冲突）。
> v1 稿的「越级借题 / 题库耗尽自动晋升 / 科考回退复用已见题」等设计**已全部删除**，
> 本稿以「严格不重复 + 不越级 + 不自动晋升」为铁律。
>
> **阅读约定**：每个小节标注状态——
> ✅ **已实现（阶段 A，可运行 + 单测覆盖）** · 🔶 **已定设计、待实现（阶段 B/C）** · ❌ **已废弃（v1 方案，被评审否决）**

---

## 0. 一页速览（v2）

| 维度 | v1（已废弃） | v2（现行） |
| --- | --- | --- |
| 核心循环 | 会试刷功名 → 科考擢升 | **研习刷功名 → 科考擢升 → 登极**（命名修正，见 §2.1） |
| 难度 | 断言「越往后越难」 | 承诺**官阶难度档递增**（`difficulty` 字段单调），**不承诺逐题绝对递增**（§2.2） |
| 不重复 | 仅最近 40 条，旧题排后；科考可回退复用 | **研习/科考/每日题一律严格排除已见**，全局去重，**不回退**（§2.3） |
| 越级 | 窗口抽干「借更高官阶题」 | ❌ **删除**：只出本官阶窗口，绝不越级（§2.3） |
| 题量不足 | 抽干「特旨擢升」自动晋升 | ❌ **删除**：返回可识别结果，**保留进度、等待扩容**，不自动晋升（§2.3） |
| 容量 | 「800 首 / 每窗 150 素材」即够 | ❌ 不成立：须**全路径核算**，43 首现语料**不够**（§2.4 / 审计报告） |
| 商业化 | 广告加次 / 功名加成 + cosmetic | ❌ **暂缓**：「广告加功名」与「不卖数值」矛盾；先验证核心闭环（§5） |
| 叙事 | 布衣到皇帝「官途」 | **架空称号路线**，文案不宣称为真实官制（§2.5） |

---

## 1. 背景与目标

现有「诗词猜猜」是**闯关制**：小学/初中/高中三关，10 题一局，≥60% 通关，1/2/3 星，通过第 n 关解锁第 n+1 关。它解决了「出题—判题—防作弊」，但缺少一条**有文化的长线成长**和**重复游玩的理由**。

本次目标（不变）：

1. 把抽象的「星级 / 关卡」升级为「**布衣 → 皇帝**」的**架空称号路线**，让进度有故事、有传播点。
2. 用「**功名（经验值）**」做唯一成长货币，答题即积累，升官有仪式感。
3. 用「**不重复出题**」让每个玩家的答题路径唯一，治答题游戏「背题库就刷满」的通病。
4. 为**商业化**留好数据地基，但**商业化暂缓**（见 §5），先把答题升官闭环做扎实。

**设计四红线（v2 强化，不可破）**：

- 答案永不下发，判题只在服务端。
- 接口层混合加密（`withCrypto`）+ 防重放 + 会话 TTL，业务层不重复实现。
- 题库仅公版 / 开放数据（chinese-poetry 抽取）。
- **严格不重复 + 不越级 + 不自动晋升**：研习/科考/每日题一律排除已见；只出本官阶窗口；题量不足返回可识别结果并保留进度，绝不回退旧题 / 借高档题 / 自动跳阶。

---

## 2. 玩法设计

### 2.1 核心循环与命名 ✅（命名已定，逻辑已实现）

> **命名修正（review 第 8 条）**：普通练习不叫「会试」（会试是科举专有名词，不能所有阶段都叫），
> 改用**「研习」**（日常刷题攒功名）；晋升大考叫**「科考」**；隐藏终点叫**「登极」**。

```
        ┌─────────────────────────────────────────────┐
        │  研习（日常刷功名）                            │
        │  在当前官阶「研习窗口」答 10 题                 │
        │  答对 = 基础分 × 连击倍率 + 速度分（复用计分）   │
        └───────────────┬───────────────────────────────┘
                        │ 每局得分累加进「功名 totalExp」（只增不减）
                        ▼
        ┌────────────────────────────────────┐
        │ 功名 ≥ 下一官阶门槛 → 解锁【科考】入口  │
        └───────────────┬──────────────────────┘
                        ▼
        ┌──────────────────────────────────────────────┐
        │  科考（晋升大考）：10 题，难度取「科考窗口」      │
        │  正确率 ≥60% → 擢升到下一官阶                  │
        │  <60% → 留级（功名保留，可重考；不降级不扣功名） │
        └───────────────┬──────────────────────────────┘
                        ▼
   布衣→童生→秀才→举人→贡士→进士→翰林→知府→侍郎→丞相
                        │ 丞相之后出现【登极】入口
                        ▼
   皇帝（隐藏 Boss「登极」，15 题跨档高难，通过 = 天子称号 + 天梯榜）
```

**三条规则（v2）**：

1. **功名（EXP）= 累计对局得分**，只增不减。直接复用 `computeScore`（基础 100 × 连击倍率 + 速度奖励），**不另造计分**。研习 / 科考 / 每日题得分都计入功名。
2. **擢升 = 功名达标 ∧ 通过科考 ∧ 考试目标恰好是「当前官阶 + 1」**。功名达标只是「解锁科考资格」；`promote.ts` 强制校验考试目标必须是下一阶（越级拒绝）。
3. **留级不惩罚**：科考失败不降级、不扣功名，可无限重考。
4. **题库耗尽不自动晋升**：晋升只能由「通过科考」触发；题量不足时引擎返回 `INSUFFICIENT_CAPACITY`，保留进度等待扩容（§2.3）。

> 实现状态：功名/连击计分 ✅ 复用 `score.ts`；晋升判定 ✅ `promote.ts`；官阶表/窗口/功名门槛 ✅ `rank.ts`；出卷 ✅ `engine.buildRankedRounds`。**功名累计落库、科考入口资格的服务端编排属阶段 B**（🔶，见 §3.3）。

### 2.2 官阶 ↔ 难度档：承诺「档递增」，不承诺「逐题递增」 ✅

> **难度修正（review 第 3 条）**：不能仅凭 grade 断言「每一道都更难」。
> 保留 `grade` 作为**初始学段标签**；`RankSpec.difficulty`（1..11，单调递增）作为**官阶难度档**，
> 用于校准题型 / 干扰项质量 / 冷门加权 / 整首题。**首版承诺「官阶难度档递增」，不承诺逐题绝对递增**。

**官途表**（✅ 已实现于 `rank.ts`，`RANKS`，单测校验 `difficulty` 与功名门槛单调递增）：

| # | key | 名称 | 难度档 | 研习窗口(grade) | 科考窗口(grade) | 累计功名门槛 |
| -- | --- | --- | -- | --- | --- | --- |
| 0 | `BUYI` | 布衣 | 1 | 1–3 | 1–4 | 0（起点） |
| 1 | `TONGSHENG` | 童生 | 2 | 1–4 | 2–5 | 2,000 |
| 2 | `XIUCAI` | 秀才 | 3 | 2–5 | 3–6 | 5,000 |
| 3 | `JUREN` | 举人 | 4 | 3–7 | 4–8 | 10,000 |
| 4 | `GONGSHI` | 贡士 | 5 | 5–8 | 6–9 | 18,000 |
| 5 | `JINSHI` | 进士 | 6 | 7–9 | 7–10 | 30,000 |
| 6 | `HANLIN` | 翰林 | 7 | 8–11 | 9–11 | 48,000（冷门优先） |
| 7 | `ZHIFU` | 知府 | 8 | 10–12 | 10–12 | 72,000（冷门优先） |
| 8 | `SHILANG` | 侍郎 | 9 | 10–12 | 11–12 | 108,000（冷门优先） |
| 9 | `CHENGXIANG` | 丞相 | 10 | 11–12 | 12–12 | 156,000（冷门优先） |
| ∞ | `DIWANG` | **皇帝（登极）** | 11 | 12–12 | 12–12 | 丞相 + 触发（隐藏 Boss，15 题） |

> **窗口重叠是显式的**：低阶窗口在 grade 轴上高度重叠（如布衣 1–3、童生 1–4、秀才 2–5），
> 叠加「全局不重复」会使高阶窗口（知府/侍郎/丞相压在 grade 10–12）实际可用题远低于静态容量
> ——这正是容量瓶颈的根因，见 §2.4 审计报告。

### 2.3 「严格不重复」+ 不越级 + 不自动晋升 ✅（已实现 + 单测）

> **这是 v2 相对 v1 的核心修正。** v1 的「越级借题」「耗尽自动晋升」「科考回退复用」全部 ❌ 删除。

- **题目规范身份** ✅：稳定 `materialKey = poemId:lineIndex:questionType`。
  **同题面不可换 ID 绕过**：`faceKey = questionType|prompt|correctAnswer` 归一化题面，
  两首逐字相同的诗（不同 `poemId`）同句位同题型，视为**同一道题**一并去重。
  整首诗可在**不同知识点**（不同句位 / 题型）再出现——这是「同诗不同题」，**不算重复**；
  严格去重粒度是「素材 key + 题面」，**不是「同诗永不出现」**（`engine.faceKey` + 单测覆盖）。
- **严格排除** ✅：`buildRankedRounds` 的 `excludeKeys`（玩家全部已见素材 key）一律排除，
  且按 `faceKey` 一并排除同题面素材。**研习 / 科考 / 每日题同此规则**（不再有科考软排除）。
- **不越级** ✅：只从 `rankId` 对应的 grade 窗口取素材，**绝不借更高官阶的题**（单测：越级窗口不足时返回容量不足而非借题）。
- **不自动晋升** ✅：窗口内「排除已见后」可出新题 < 所需题数 → 返回
  `{ ok:false, reason:"INSUFFICIENT_CAPACITY", available, required }`（或 `EMPTY_CORPUS`），
  由上层「**保留进度、等待扩容**」；**绝不**返回不足题数的正常试卷、**绝不**自动跳阶、**绝不**回退旧题。
- **局内去重** ✅：同一局内同题面 / 同题干不重复出。

> 已见记录的**持久化**（`PlayerSeenMaterial` 表）属阶段 B（🔶）；阶段 A 是纯逻辑，
> `excludeKeys` 和 `excludeFaces` 由调用方注入（服务端在 B 阶段从 DB 读取）。
> 官阶模式在数据库不可用时停止开局；仅进程内记忆无法兑现跨重启不重复。

### 2.4 题库容量：全路径核算，当前语料**不够** ✅（审计脚本 + 报告已交付）

> **容量修正（review 第 4 条）**：v1 的「800 首 / 每窗 150 素材即充分」**不成立**。
> 有限题库不能同时承诺「永久不重复」和「无限游玩」。须按**完整晋升路径**核算。

✅ 交付：只读审计脚本 `scripts/poetry-capacity-audit.ts` + 报告 `2026-09-17-poetry-capacity-report.md`。
对真实语料（`poetry-seed.json`，**43 首**）统计：

- 全库理论题面并集 **621** 道；尚未过滤有效干扰项，不能当作正式可出题容量。
- 2026-09-18 修正：旧报告 **577** 是缺题后实际抽到的数量，不是完整需求，旧结论作废。
- **最乐观场景**（全对 + 满速度分 + 一次通过）到丞相需 **790** 道，到皇帝需 **805** 道；仅理论总量就至少缺 **184** 道。
- 正式出题器使用种子 1/42/2026 回放，全对场景在知府升侍郎前的研习阶段阻塞；60% 场景在贡士升进士前阻塞。详细表见容量报告。
- 消耗模型假设（每局 10 题出题即标记已见、失败/弃局同耗新题、功名复用 `computeScore`、
  每局功名按「N 题连对 + 满速度分」乐观估计）**全部在报告中显式列出**，不伪造用户模拟结论。

**结论（如实报告，不放宽规则假装通过）**：
> **当前 43 首语料不足以支撑完整「布衣 → 丞相」晋升路径。** 按红线，题量不足时引擎返回
> `INSUFFICIENT_CAPACITY`，保留进度、等待扩容，不回退 / 不越级 / 不自动晋升。
> 扩容建议（供 M0，本阶段不实现）：① 扩量——重点补 grade 10–12（高中档）；
> ② 调窗口——拉开高阶窗口、降低 grade 轴重叠，让每个窗口消耗落在自身容量内。

### 2.5 皇帝 = 隐藏 Boss（登极）✅（配置已实现）

- **架空称号路线**：布衣 → 皇帝是**游戏内称号**，文案（`RankSpec.subtitle`）已写成架空叙事，
  **不宣称为真实官制**（review 第 8 条）。
- **入口**：升到丞相后出现「登极」按钮（隐藏）。
- **大考**：15 题，grade 12 + 冷门优先（`preferCold` 已实现；整首/名句题型变体属阶段 B 🔶）。
- **通过**：解锁「天子」称号 + 专属分享卡 + 天梯榜资格；不通过不降丞相。

### 2.6 每日题 🔶（阶段 C，暂缓）

每日 1 题（当前官阶窗口）+ 连续天数 streak。**阶段 A 仅在 `rank.ts` 定义 `DAILY_COUNT=1`
与出卷入口（已可单测 1 题）**；streak / `PlayerDaily` 落库 / 补签属阶段 B/C。商业化前不实现补签。

### 2.7 失败 / 边缘情况（v2）

| 情况 | 处理 |
| --- | --- |
| 科考 <60% | 留级，功名保留，可重考；结算「落第」+ 差 X% 到 60%（`promote.ts` reason=`EXAM_FAILED`） |
| 窗口抽干（任何 kind） | 返回 `INSUFFICIENT_CAPACITY`，**保留进度、等待扩容**；**不**借题 / 不自动晋升 / 不回退 |
| 全库见底 | 同上，`available=0`；由产品提示「已阅遍天下诗，待扩容」，**不**特旨擢升 |
| 越级开科考（目标非下一阶） | `promote.ts` reason=`EXAM_TARGET_NOT_NEXT`，拒绝晋升 |
| 研习/每日题想晋升 | `promote.ts` reason=`KIND_NOT_EXAM`，永不晋升 |
| DB 不可用（内存模式） | 功名/升官/持久化已见不可用（同现排行榜/进度降级），单局答题闭环照常；**严格规则不放宽** |

---

## 3. 模块详细设计

> 架构铁律不变：`lib/games/` 纯函数（禁 `next/*`/`@prisma/client`/`react`/IO，语料随机数参数注入）；
> 判题在 `lib/db/`；业务 Route Handler 一律 `withCrypto`。

### 3.1 新增纯逻辑层 ✅（已实现 + 单测）

| 文件 | 状态 | 内容 |
| --- | --- | --- |
| `src/lib/games/poetry/rank.ts` | ✅ | `RANKS`（官阶表，含 `difficulty`/`gradeWindow`/`examWindow`/`expToReach`/`preferCold`）、`rankById`/`nextRank`/`canTakeExam`/`countFor`/`windowFor`/`preferColdFor`/`isRankId` |
| `src/lib/games/poetry/promote.ts` | ✅ | `evaluatePromotion`：仅 EXAM 通过且目标=当前+1 才擢升；功名只增；reason 互斥可断言 |
| `src/lib/games/poetry/capacity.ts` | ✅ | `distinctFacesByGrade`/`totalDistinctFaces`/`simulatePath`（全路径消耗核算，纯函数） |
| `src/lib/games/poetry/engine.ts` | ✅ 扩展 | 新增 `faceKey`/`materializeRound`（与审计同口径）、`buildRankedRounds`（严格官阶出卷）；**原 `buildRounds` 行为保持不变**（单测验证旧模式兼容） |
| `src/lib/games/poetry/types.ts` | ✅ 扩展 | `PoemCorpusItem.cold?`、`RankKind`、`RankBuildOptions`、`RankedBuildResult` |

**严格出卷入口签名（✅ 已实现）**：

```ts
buildRankedRounds(corpus, { rankId, kind, seed?, excludeKeys? })
  : { ok:true, rounds: PoetryRound[] }
  | { ok:false, reason:"EMPTY_CORPUS"|"INSUFFICIENT_CAPACITY", available, required }
```

- `kind="PRACTICE"` 取本官阶 `gradeWindow`、10 题；`kind="EXAM"` 取 `examWindow`、10 题；
  `kind="DAILY"` 取本官阶 `gradeWindow`、1 题；皇帝（rankId 10）一律 15 题。
- `excludeKeys` 严格排除（素材 key + 同题面）；高阶 `preferCold` 按 `cold` 加权（不改变可出卷集合）。
- 同 seed 同语料同排除集 → 输出逐字一致（✅ 单测）。

**`promote.ts` 判定（✅ 已实现 + 单测全边界）**：

```ts
evaluatePromotion({ currentRank, totalExp, kind, examPassed, examRank })
  : { promoted, newRank, expToNext, nextUnlocked,
      reason: PROMOTED|ALREADY_EMPEROR|KIND_NOT_EXAM|EXAM_TARGET_NOT_NEXT|EXP_INSUFFICIENT|EXAM_FAILED }
```

### 3.2 题型清单 ✅ / 🔶

| 题型 | 状态 |
| --- | --- |
| `GUESS_POET` 名句猜诗人 | ✅ 已实现（全程可用） |
| `GUESS_TITLE` 名句猜诗名 | ✅ 已实现（全程可用） |
| `COMPLETE_NEXT` 上句补下句 | ✅ 已实现（全程可用） |
| `COMPLETE_POEM` 补全联（整首挖末联） | 🔶 阶段 B（登极 Boss 用，数据结构复用 `PoetryRound.meta`） |
| `GUESS_LINE` 据句猜整句（挖句中一字） | 🔶 阶段 B（高阶冷门区分度） |

### 3.3 服务端编排层 🔶（阶段 B，未实现）

> 阶段 A **不动** `session-service.ts` / `player-service.ts` / DB，保证不破坏既有对局闭环。
> 以下为阶段 B 计划（细化，不在本阶段执行）：

- `poetry-rank-service.ts`：`getRankState` / 扩展 `startPoetrySession(kind,rankId)` / 结算钩子
  （功名服务端累加、调 `evaluatePromotion`、科考归档、每日题 streak）。
- **功名在服务端累加**（客户端只传 choice/timeMs，服务端算分），杜绝刷功名。
- **已见持久化**：`PlayerSeenMaterial` 表（L2）+ 进程内 L1；**L1 不得绕过 DB 的最终去重判断**（review 第 5 条）。
- **数据完整性（review 第 5 条）**：① 选题**原子占用**（避免并发/重开/刷新重复发同一题）；
  ② 并发冲突**重试**；③ 结算**一次性记账**（幂等，防重复提交）；④ 晋升条件**重新检查**；
  ⑤ 每日题**唯一约束**（每玩家每日 1 题）。
- **身份（review 第 6 条）**：匿名 `playerId` ≠ 身份凭证；现有接口加密 ≠ 授权。
  跨设备恢复需**额外机制**（如设备绑定 + 签名 token），**阶段 A 不宣称跨设备可用**。
  阶段 B 数据库变更先在**临时测试库**验证，保留真实用户数据。

### 3.4 接口层 🔶（阶段 B）

| 路由 | 状态 |
| --- | --- |
| `/api/games/poetry/session` 加 `kind`/`rankId` | 🔶 B |
| `/api/games/poetry/answer` 结算追加官阶/功名/擢升 | 🔶 B |
| `/api/player` 返 `rankState` | 🔶 B |
| `/api/poetry/rank`（拉官途状态） | 🔶 B |
| `/api/leaderboard` 双榜（功名/官阶）+ 天梯 | 🔶 B |

> 防作弊不变：答案不下发、TTL、nonce、判题服务端比对、耗时钳位。功名服务端累加。

### 3.5 前端 🔶（阶段 C，未实现）

- `poetry-rank-store`（Zustand）持 `rankState`。
- 主页「三关 StagePicker」→ **官途路线图**（布衣→…→丞相→🐲皇帝，功名进度条，研习/科考入口）。
- 结算 `SettleView` 擢升动画 + 「差 X 功名解锁科考」；**题库不足提示**（`INSUFFICIENT_CAPACITY` → 「已阅尽本阶诗，待扩容」）。
- 分享卡按官阶渲染称号/头像框/皮肤。
- 真实浏览器验收：初始到首次晋升、失败重考、刷新恢复、重复提交、移动布局（**阶段 C**，静态单测不算浏览器验收）。

---

## 4. 数据库设计

> 阶段 A **不改** `prisma/schema.prisma`、不动真实 DB、不跑 `db:push`/`db:seed`。
> 以下为**阶段 B 计划**的 schema（细化，待临时测试库验证）。

### 4.1 现有表变更（🔶 阶段 B）

```prisma
model Poem {
  id      String @id @default(cuid())
  title   String
  poet    String
  dynasty String
  grade   Int              // 学段 1-12（初始标签）
  tier    Int  @default(1) // 难度档 1-5（由 grade 映射，冗余便于出卷）
  famous  Boolean @default(false)
  cold    Int  @default(0) // 冷门度 0-3（高阶 preferCold 加权）
  lines   Json
  @@index([tier]) @@index([grade]) @@index([poet])
}

model GameSession {
  // …既有字段…
  kind       String @default("PRACTICE")  // PRACTICE | EXAM | DAILY
  rank       Int    @default(0)           // 本局对应官阶 id
}

model AnswerRecord {
  // …既有字段…
  sourceKey String?   // 结算/错题本按素材聚合
}
```

### 4.2 新增表（🔶 阶段 B）

```prisma
model PlayerRank {                 // 一人一行总账
  id String @id @default(cuid())
  playerId String @unique
  currentRank Int @default(0)
  totalExp Int @default(0)         // 功名，只增
  emperor Boolean @default(false)
  emperorAt DateTime?
  updatedAt DateTime @updatedAt
  player Player @relation(fields:[playerId], references:[id], onDelete:Cascade)
}

model PlayerRankProgress {         // 每官阶最佳战绩
  id String @id @default(cuid())
  playerId String
  rank Int
  stars Int @default(0)
  bestAccuracy Int @default(0)
  bestScore Int @default(0)
  examsPassed Int @default(0)
  practiceCount Int @default(0)
  firstPassedAt DateTime?
  lastAttemptAt DateTime @default(now())
  player Player @relation(fields:[playerId], references:[id], onDelete:Cascade)
  @@unique([playerId, rank]) @@index([playerId])
}

model PlayerSeenMaterial {         // 「不能重复」持久化（L2）
  id String @id @default(cuid())
  playerId String
  mode String @default("POETRY")
  sourceKey String
  firstSeenAt DateTime @default(now())
  player Player @relation(fields:[playerId], references:[id], onDelete:Cascade)
  @@unique([playerId, mode, sourceKey]) @@index([playerId, mode])
}

model PlayerDaily {                // 每日题 + streak
  id String @id @default(cuid())
  playerId String @unique
  date String @default("")         // YYYY-MM-DD（服务端本地时区）
  answered Int @default(0)
  correct Int @default(0)
  streak Int @default(0)
  bestStreak Int @default(0)
  player Player @relation(fields:[playerId], references:[id], onDelete:Cascade)
}

model PlayerAsset {                // 商业化挂载点（暂缓，schema 预留）
  id String @id @default(cuid())
  playerId String
  assetType String                 // TITLE | AVATAR_FRAME | CARD_SKIN | PRIVILEGE
  assetId String
  source String @default("ACHIEVE")
  acquiredAt DateTime @default(now())
  player Player @relation(fields:[playerId], references:[id], onDelete:Cascade)
  @@unique([playerId, assetType, assetId])
}
```

### 4.3 容量 / 完整性说明

- **`PlayerSeenMaterial`** 唯一线性增长表；`@@unique` 幂等 upsert。**唯一 upsert 不等于并发发题不重复**
  （review 第 5 条）→ 选题需**原子占用**（如事务内 `INSERT … WHERE NOT EXISTS` + 行锁 / 唯一约束冲突重试）。
- **功名/官阶** O(1) 读 `PlayerRank`。
- **排行榜**沿用 `GameSession.groupBy`，双榜只加 `kind`/`rank` 过滤。
- 扩容（M0）：`seed.mjs` 幂等 upsert，重跑即导；`tier`/`cold` 按 grade + 名句频率批量填充。

### 4.4 数据合规（继承红线）

- 题库**仅公版**（chinese-poetry）；不存 PII；`sourceKey` 不含用户输入；付费资产不记录任何数值型付费属性。

---

## 5. 商业化路径 ❌ 暂缓（v1 方案已否决）

> **商业化修正（review 第 7 条）**：v1 的「激励视频**额外次数 / 功名加成**」与「**不卖数值**」
> **直接矛盾**——看广告加功名就是卖数值。**商业化整体暂缓**，先验证答题升官闭环与留存，再重新设计。

**暂缓期内不做**：不接广告、不接支付、不加任何付费/加成入口、不动 `PlayerAsset` 写入。

**重开商业化前的硬前提**（阶段 C 核心闭环 + 留存数据验证之后）：
1. 只碰「外观 + 去广告」，**不碰功名/官阶/判题**（功名必须由答题获得）。
2. 排行榜不纳入任何付费权重（公平优先）。
3. 不卖答案、不卖私有题库、公版语料不变。
4. 未成年人保护、付费二次确认。

> `PlayerAsset` 表 schema 仅**预留**（§4.2），阶段 B 建表即可，**不写入、不实现付费逻辑**，
> 保证后续接支付不污染核心玩法。

---

## 6. 里程碑（按评审的阶段划分）

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| **A（本次，Zcode 执行）** | 修订本设计 ✅；题库容量审计脚本+报告 ✅；题目规范身份（materialKey/faceKey）✅；`rank.ts`/`promote.ts` 纯逻辑 ✅；严格官阶出题入口（不重复/不越级/不足可识别）✅；单测全覆盖 ✅；`npm test`/`lint`/`tsc` 报告 ✅。**不改真实 DB、不接广告支付、不扩未经核对题库、不提交推送、不删其他玩法、不改 .env/凭据。** | ✅ 已完成 |
| **B（数据与接口闭环）** | 按审计报告**扩充并校对语料**（重点 grade 10–12）；持久化已见；**事务选题 + 原子占用 + 一次性结算 + 并发重试**；`poetry-rank-service` + 接口；身份/授权机制；数据库变更先在**临时测试库**验证，保留真实数据。 | 🔶 待执行 |
| **C（前端与浏览器验收）** | 官途图/功名条/研习·科考入口/结算/题库不足提示；**真实浏览器**验证初始到首次晋升、失败重考、刷新恢复、重复提交、移动布局。核心闭环完成后再议每日题与商业化。 | 🔶 待执行 |

---

## 7. 风险与对策（v2）

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| **题库容量不足（43 首，621 理论题面，全对到皇帝需 805 新题）** | **高** | 总量与窗口分布均不足；正式出题回放见容量报告。不足返回 `INSUFFICIENT_CAPACITY`，保留进度等待扩容，不放宽规则。 |
| 难度「逐题递增」做不到绝对 | 中 | 只承诺**官阶难度档递增**（`difficulty` 单调，已单测），不承诺逐题；干扰项/题型/熟悉度在 B 阶段校准 |
| 并发/重开/刷新导致重复发题 | 中 | 阶段 B：原子选题占用 + 唯一约束冲突重试；L1 不绕过 DB 最终去重 |
| 匿名 playerId 被冒充 / 跨设备恢复 | 中 | 阶段 B：身份凭证（签名 token / 设备绑定）；A 阶段不宣称跨设备可用 |
| 商业化破坏公平 | — | 已暂缓（§5）；重开时只卖外观/去广告，不卖数值 |
| 内存兜底模式升官不可用 | 低 | 同现排行榜/进度降级；严格规则不放宽 |

---

## 8. 复用 vs 新增 vs 废弃 清单

**复用（不改）**：出题引擎骨架、干扰项、`computeScore`、`judgeClear`、加密层、判题服务端比对、`GameSession`/`AnswerRecord` 骨架、`secureFetch`。

**✅ 阶段 A 已新增/扩展**：
- 纯逻辑：`rank.ts`、`promote.ts`、`capacity.ts`、`engine.ts`（`faceKey`/`materializeRound`/`buildRankedRounds`）、`types.ts`（`RankKind`/`RankBuildOptions`/`RankedBuildResult`/`cold?`）。
- 审计：`scripts/poetry-capacity-audit.ts` + `docs/design/2026-09-17-poetry-capacity-report.md`。
- 单测：`tests/games/poetry/{rank,promote,rank-engine,capacity}.test.ts`（47 个新用例）。
- 原 `buildRounds`（学段模式）行为**保持不变**（单测验证旧模式兼容）。

**🔶 阶段 B/C 待实现**：`PlayerRank`/`PlayerRankProgress`/`PlayerSeenMaterial`/`PlayerDaily`/`PlayerAsset` 表 + `poetry-rank-service.ts` + 已见持久化 + 事务选题 + 身份机制 + 接口 + 官途图前端 + 每日题 streak + 天梯。

**❌ v1 已废弃**：越级借题、题库耗尽自动晋升（特旨擢升）、科考回退复用已见题、「800 首/每窗 150 即充分」、广告额外次数/功名加成、「会试」用于所有阶段。
