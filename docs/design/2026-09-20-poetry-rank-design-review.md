# 诗词升官 · 方案与详细设计评估（2026-09-20）

> **状态（2026-09-20 晚更新）**：A1–A10、B1–B10、C1–C5 修订已全部应用到两份目标文档
> （`optimization-and-art.md` 升级为 v2.1 勘误版；`detailed-design.md` 头部含修订记录，正文以「review Xn」标注落点）。
> 本文保留为评估依据与决策记录；§5 修订清单逐项勾销状态见文末。

> 评估对象：
> - `2026-09-20-poetry-rank-optimization-and-art.md`（v2：人物体系 / 可玩性 / 官阶解锁 / 吸引力对照 / 美术规划）
> - `2026-09-20-poetry-rank-detailed-design.md`（D1–D6：schema diff / 纯逻辑接口 / API 契约 / 时序 / 测试计划）
>
> 评估方法：逐条对照当前代码事实（rank-service.ts 678 行、engine.ts 375 行、schema.prisma 121 行、rank.ts、
> types.ts、capacity.ts、page.tsx 348 行、48 首种子语料、2026-09-17 容量审计报告），验证设计声明与代码基线的一致性。
> 严重度：A = 照文档实现必出 bug / 机制自相矛盾；B = 健壮性与口径缺口；C = 文档一致性。

## 0. 总评

**结论：方向正确、纪律扎实，修订 A 级问题后可开工。**

做得好的：

- 基线行数引用与代码逐一吻合（678/375/121/348），设计是对着真实代码写的，不是空中楼阁。
- 架构红线贯穿始终：新玩法判定全部落纯逻辑层或服务端；newBadges 只下发 key、文案查纯逻辑表（与 RANKS 同模式）；
  hint 响应只含被移除索引；persona seed 确定性可单测。
- D6 皇榜是零 schema 派生视图 + 虚拟榜位解冷启动 + 追赶叙事降压，成本/收益比最好的一期。
- 测试计划具体到性质断言（hint 1000 次随机全过、seed 复现、容量审计重跑），不是"写点单测"的空话。
- 美术管线已实证（三样本验证 Q 版无伪汉字）、一致性策略（固定角色句逐字复用 + seed 台账）是无角色一致性模型下的正确做法。
- 吸引力对照表（v2 §6）每条要素都落到了具体机制，不是调研堆砌。

问题集中在：**新题型与既有去重/解析链的耦合点漏改**、**每日题的边界状态机不完整**、**竞猜与迷雾设计自相矛盾**、
**多处数量/口径不一致**。全部可修，无需推翻分期结构。

---

## 1. A 级问题（实现前必须修订）

### A1. DYNASTY_PICK 在当前语料下不可行

- 事实：48 首种子语料仅 唐(27)/宋(18)/清(3) 三个朝代（实测）。
- 详设 §3.2/§3.3 要求：干扰朝代"必须真实存在于语料" + `strictOptions=true`（干扰不足即弃素材）。
- 推论：正确 1 + 干扰 3 永远凑不齐 → DYNASTY_PICK 全部素材判废，题型上线即死代码；
  §7 测试"rankId>=3 混入率 ≈30%"也无法达成。
- 修法（二选一，写进详设）：
  1. 放宽红线为"干扰项是真实朝代即可（含语料外的明/元/汉等）"——"不可能选项送分感"的原始动机针对的是虚构朝代，真实朝代不违背；
  2. 把语料扩容（≥5 个朝代）列为 D3 硬前置。

### A2. 每日题死锁：占位未结算 + 会话 TTL 过期无恢复路径

- 详设 §2.1 时序：start DAILY 先事务内 create PlayerDaily 占位；"存在且未结算 → 409 + 返回可恢复会话"。
- 事实：会话 TTL 10 分钟（SESSION_TTL_MS），超时后 status → EXPIRED。
- 推论：玩家开每日题后 10 分钟内没答完 → 会话 EXPIRED、PlayerDaily 永远 settled=false →
  当日再 start 恒 409，且无可恢复会话，**当日每日题永久卡死**。
- 修法：start DAILY 分支增加状态——"占位存在且关联会话已 EXPIRED/FINISHED 之外 → 删除旧占位重建（或 update sessionId 复用占位）"。
  占位表建议直接存 sessionStatus 判定所需的 sessionId 查询，并在集成测试加"过期后重开"用例（§7 D2 测试计划补一条）。

### A3. 剪影竞猜：答案公开 + 与迷雾设计自相矛盾 + 泄露皇帝

三重问题：

1. **答案是完全公开信息**：服务端判据 `guessLabel === RANKS[rankId+1].label`，而 RANKS 是客户端可 import 的纯逻辑常量、
   rankId 在 GET 视图里——任何玩家（或脚本）都能每天稳定 +100 功名。"判定服务端收口"防不了答案本身公开。
2. **与 D1 迷雾矛盾**：§1.4 路线图规定"下一阶 = 半剪影 + **称号可见**、副标题虚化"。竞猜问的恰是"下一官衔（称号）是什么"——
   抬头看一眼路线图就有答案，机制自拆。
3. **泄露皇帝终点**：rankId=9（丞相）时竞猜选项含 `RANKS[10].label = "皇帝"`，破坏 D1/v2 §4.3
   "拜相结算时钦差才揭晓登极大考"的叙事红线。
- 修法：竞猜对象改为**迷雾阶（rankId+2）的称号**（这才是真正被隐藏的信息），rankId>=8 时禁用或改猜副标题/典故；
  +100 功名保留（金额小、单玩家自娱，公开答案的风险可接受，但要在文档里明说这是"每日点击奖励"而非"竞猜挑战"）。

### A4. FILL_CHAR 四段 materialKey 破坏既有解析链（三处漏改）

- 详设 §3.2 只改了 `materialKey` → `poemId:lineIndex:FILL_CHAR:pos`（四段），但：
  1. **engine.ts `faceKeyOfKey`**（354-375 行）：`parts.pop()` 取 type、再 pop 取 lineIndex——四段 key 会 pop 出
     `pos` 当 type、`FILL_CHAR` 当 lineIndex → NaN → return undefined → **已见 FILL_CHAR 素材的 faceKey 排除静默失效**；
     且 366-372 行题型白名单也不含新题型。
  2. **rank-service.ts `collectSeenKeys`**（269-292 行）：byKey 映射按三段格式 `${id}:${i}:${type}` 构建，
     四段 sourceKey 查不到 → faceKey 不落库 → 换 poemId 绕过去重的防线对新题型失效。
  3. **engine.ts `faceKey(item, lineIndex, type)` 签名没有 pos**：同句不同挖字位的两个 FILL_CHAR 素材
     faceKey 相同 → 局内 seenFaces 去重误杀 + 跨局 face 排除把没出过的字位也挡掉。
     materialKey 加 pos 的动机（"防同句不同字位互斥"）恰恰要求 faceKey 也带 pos，文档自相矛盾。
- 修法：faceKey 增加可选 pos 参数（或 FILL_CHAR 分支内嵌 pos）；faceKeyOfKey、collectSeenKeys 同步改造并列入 D3 改动清单；
  §7 D3 单测补"四段 key 的 faceKeyOfKey 往返"用例。

### A5. seenCount 口径翻倍（成就与展示全错）

- 事实：`collectSeenKeys` 把 **sourceKey 行和 faceKey 行都写进 PlayerSeenKey**（两道 key 一道题）。
- 详设 §2.3 `seenCount` = `PlayerSeenKey.count` → 约 2× 真实已见题数。
- 影响：SEEN_100（学富五车）/SEEN_500（诗词阁主）成就提前一半触发；主页"已见 N 题"翻倍虚高。
- 修法：seenCount 按 key 格式过滤（sourceKey 含 `:` 分隔、faceKey 含 `|` 分隔，`key contains ':'` 即可判别），
  或改为 `PlayerPoem.count`（D3 诗词阁天然按诗去重）——两个口径选一个并在文档写明。

### A6. 皇帝阶每日题变 15 题 + 两天烧干窗口

- 事实：rank.ts `countFor` 中 `if (r.isEmperor) return EMPEROR_COUNT` **先于 kind 判断**（119-124 行）。
- 推论：rank 10 玩家开 DAILY → 出 15 题；且 rank 10 窗口 [12,12] 仅 3 首诗、有效池 22（容量报告实测）→
  每天消耗 15 个已见键，**不到两天皇帝阶每日题断粮**，还挤占登极大考本就只有 22 题的池子。
- 修法（写进 §2.1）：DAILY 恒 1 题（countFor 把 `kind === "DAILY"` 判断提到 isEmperor 之前），
  或皇帝阶禁用每日题（前端隐藏 + 服务端 403）。推荐前者——皇帝玩家也该有每日回归钩子。

### A7. DAILY 的 kind 推导改动点未列全（三处静默降级）

- 事实：rank-service.ts 有三处会把 DAILY 静默当别的 kind：
  1. :357 `const kind = (session.stage === "EXAM" ? "EXAM" : "PRACTICE")`——结算摘要 kind、persona 映射全错；
  2. :670 resume 视图同款三元——恢复的每日题显示成研习；
  3. :147 `targetId = kind === "PRACTICE" ? currentRankId : currentRankId + 1`——DAILY 会取 current+1（越级出题！）。
- 详设 §2.1 只说"入参联合类型扩为三元"，未列这三个改造站点。:147 那处如果不改，DAILY 直接违反"不越级"红线。
- 修法：三处改为显式 switch/映射函数（建议抽 `kindOfStage(stage)` 单点），D2 改动清单补齐，集成测试断言 DAILY 出题窗口 = 当前官阶。

### A8. RankView.recent 单对象 vs "最近 3 局均值" + D1/D2 排期倒挂

- §1.4（D1）功名估算：`avgExp = 最近 3 局 expGained 均值，数据源 RankView.recent`；
  §2.3（D2）定义的 `recent` 却是**单个对象** `{kind, expGained, accuracy} | null`。
- 且 recent/seenCount 字段定义在 D2，首个使用方在 D1——排期倒挂。
- 修法：`recent` 改为 `recentGames: Array<{kind, expGained, accuracy}>`（近 3 局，`gameSession.findMany FINISHED take 3`），
  字段交付挪进 D1；accuracy 库中无字段，需从 AnswerRecord 聚合（或结算时把 accuracy 落到 GameSession 新字段——顺手把 B4 一起解决）。

### A9. hint 缺 roundIndex 持久化，resume 灰置套错题

- 详设 §4.1：`hintRemoved Json` 存 GameSession，"resume 恢复时下发，客户端灰置"。
- 推论：hint 作用于请求时的当前题（比如第 3 题），玩家刷新后 resume 回到第 3 题——但客户端无法知道 hintRemoved
  属于第几题；若玩家在 hint 后答完第 3 题再刷新，resume 回到第 4 题，灰置会错误套到第 4 题的选项上。
- 修法：schema 加 `hintRoundIndex Int?`；resume 视图下发 `{roundIndex, removedIndexes} | null`，客户端仅当
  `roundIndex === currentIndex` 时灰置。

### A10. 补签：无 schema 字段、无 API 路由

- §2.1 补签规则"每月 1 次将上月某未答日标记为'补'，只影响月历展示与周连满判定"——需要持久化：
  PlayerDaily 没有 madeUp 字段，cells 状态枚举（done/pending/future/missing）也没有"补"态；
  §5 路由清单没有补签端点；周连满"含补签"的判定数据来源悬空。
- 修法：PlayerDaily 加 `madeUp Boolean @default(false)`（补签 = 对 missing 行 update）；
  cells 状态加 `"made"`；新增 `POST /api/games/poetry/rank/makeup`（withCrypto，服务端校验"上月 + 本月配额 1 次"，
  配额可派生自 PlayerDaily madeUp 计数，零新表）；§5 清单补一行。

---

## 2. B 级问题（健壮性 / 口径）

### B1. D1 测试规格自相矛盾："反馈句不含答案"无法成立

- §7 D1：`feedbackLine` 断言"不含答案/选项文本"。
- 事实：GUESS_POET/GUESS_TITLE 的 explanation（`出自《X》· 朝代 · 作者`）**本身就是正确答案**（判后揭晓是既有合规行为，
  RankedJudgeView.correctAnswer 一直在下发）。feedbackLine = "对。" + explanation → 必含答案，测试写出来就是红的。
- 修法：红线收窄为"**判前视图**（start/resume 的 rounds）不含答案"；feedback 的断言改为"不含未揭晓轮的 answerIndex/选项序"之类可成立的性质。

### B2. 28 格月历 vs ISO 周幂等键口径不齐

- §2.1 cells 固定 28 格（4 周），周奖幂等键 `YYYY-WW`（ISO 周）。真实月份 29-31 日无处安放；
  28 格从哪天起排（1 号对齐周一？滚动 4 周？）未定义，"整周 7 格全 done"与 ISO 周边界对不上。
- 修法：二选一并写明——(a) 真实月历（当月天数，周一起排，首尾补空），周奖按 ISO 周判定；
  (b) 滚动 28 天窗口，周奖键改 `playerId:W{n}`（滚动周序号）。推荐 (a)，与"补签限上月"的自然月口径一致。

### B3. 周奖追溯规则未定义

- "任意一局结算事务中检查 weeklyBonusKeys 缺周时补记"——补记**哪些**周？全部历史缺周还是仅上一周？
  数据从哪推导（PlayerDaily 历史全量扫描？）未写。
- 修法：明确"仅补记 PlayerDaily 可证真实连满、且未发过的周"，推导范围限最近 N 周（如 8 周），防止老玩家一次结算触发全历史扫描。

### B4. hint 折价后 GameSession.score 口径未定

- §4.1 结算 `exp = hintUsed ? round(sessionScore*0.8) : sessionScore`，但 :530 现有代码把 sessionScore 写回
  `gameSession.score`。存折前还是折后未定 → 影响 `recentGames.expGained`（A8）与功名簿近 10 局柱状图的一致性。
- 修法：统一存**折后值**（score = 实际入账功名），文档写明。

### B5. maxCombo 推导缺排序前提

- §2.2 "按 answers 升序扫一遍"——现有结算事务的 findMany（:517）select 只有 correct/gained，**没有 roundIndex 也没有 orderBy**。
- 修法：select 加 roundIndex、orderBy roundIndex asc，改动清单列明。

### B6. 皇榜追赶目标应从合并列表取

- §4.5 `my.aboveCount/aboveExp` 只查 playerRank 表（真实玩家），但展示列表是虚拟+真实合并——
  虚拟位压在头上时，"与第 N 位只有一卷之差"指向的人与列表所见不符。
- 修法：aboveExp/aboveCount 在 mergeLeaderboard 之后从合并列表计算（纯函数内完成，正好可单测）；
  `my` 的 count 查询保留作真实玩家名次口径，两者分工写明。

### B7. "12 阶 / 12 张立绘"贯穿性 off-by-one

- 事实：RANKS 共 **11** 条（id 0..10 = 布衣 + 9 官衔 + 皇帝）；详设 §6 美术路径 `rank00…rank10` 恰 11 张。
- 错处：v2 §2.1 "主角 · 12 阶换装 / 12 张立绘"、v2 §4.2 "12 张全收集"、v2 §1 "11 阶官衔 + 皇帝（12 阶）"、
  详设 §7 D5 "12 张立绘一致性目视"。
- 影响：资产采购清单数量、成就文案（"官途全录 12 张"）、D5 验收项。
- 修法：全文统一为 **11 阶（11 张立绘、11 张档案卡）**，或明确"12"指别的计数并给出定义。

### B8. 表情包数量与命名模式不符

- v2 §2.1 "核心 NPC 各 4 表情"（2 NPC × 4 = 8 ✓ 与详设 D5 "表情包（8 张）"一致），
  但详设 §6 命名模式 `q_expr_{npc}_{happy|surprised|sad}` 只列 3 表情 = 6 张。normal 是复用立绘还是单出，未定。
- 修法：写明 normal 复用立绘（则命名模式 6 张 + 立绘 2 张 = 8），或模式加 normal（8 张）。

### B9. DYNASTY_PICK 题干碰撞压低实际混入率

- DYNASTY_PICK 的 prompt = pickQuote，与同素材 GUESS_POET/GUESS_TITLE 题干相同 → 局内 seenPrompts 去重会吃掉一部分。
- 影响：§7 "混入率 ≈30%±（seed 固定断言精确值）"的期望值需按去重后口径校准，否则测试写出来对不上。
- 修法：测试断言改为"seed 固定的精确值"（本来就是），文档把 30% 标注为"名义追加概率，实际混入率受题干去重影响略低"。

### B10. 新增 PlayerX 模型均无外键

- PlayerDaily/PlayerAchievement/PlayerPoem/RankGuess 都只有 playerId 字符串、无 relation（与既有 PlayerSeenKey 风格一致），
  玩家删除不级联清理。当前匿名体系下玩家几乎不删，可接受，但应在 schema 注释里写明这是**有意为之**，防后人"补全外键"引发迁移。

---

## 3. C 级问题（文档一致性）

- **C1** v2 §5.6 "问同窗消耗少量功名"与"功名只增不减"红线冲突；详设已正确改为局末 ×0.8 折价（不动 totalExp 单调性）。
  v2 加勘误注记，避免两份文档打架。
- **C2** v2 §6 吸引力对照表的调研引文（Trophy 2026-04、Gamigion 9 rules、Meta/GDC 2026、Octalysis、江南百景图案例）
  均无链接/出处，无法核验。建议补引用来源（URL 或文献名），否则"数据依据 33.96% vs 25.57%"这类关键数字是悬空的。
- **C3** D6 虚拟榜位 5 名人的固定 totalExp 数值未给（李白·翰林等只有官衔）。实现前定数，且数值应落在对应官阶
  expToReach 附近（如翰林 48000±），否则"官阶为主排序"下虚拟位功名与官衔不自洽。
- **C4** 详设 §2.4 功名簿"近 10 局小柱状图"数据源写的是 `gameSession 近 10 局 select kind+score+createdAt`——
  与 A8/B4 的 score 口径联动，修订后同步。
- **C5** v2 §4.1 迷雾"再往后 = 黑色剪影 + ？？？（只露难度暗示如'二品大员·???'）"——"二品大员"是侍郎 subtitle 的一部分，
  属真实官制词汇；与"架空文案不宣称真实官制"红线的边界建议明确（subtitle 本就含"二品大员"，若红线只限"不宣称整套官制真实"则无碍，写明即可）。

---

## 4. 计划级风险：语料扩容必须是 D2/D3 的前置或并行轨

- 容量审计（2026-09-17 报告，09-20 重生成）已判定：**48 首语料全路径不可行**——
  100% 正确率在知府→侍郎 EXAM 阻塞（需 805 题 > 供给 693）；60% 正确率在贡士→进士就阻塞。
- D2 每日题（每天烧 1 个已见键）、D3 新题型（加速消耗 + FILL_CHAR 的 pos 维度虽然扩池但同句位互斥）、
  D4 提示（不减消耗）都会**加剧**枯竭速度。
- 详设只把"审计重跑"当 D3 的验证项，没有扩容里程碑。corpus-plan（2026-09-20）已存在但两文档未互相引用。
- 建议：在详设 §0 分期表加一行 **D0（并行轨）：语料扩容**，明确 D2 上线前语料规模门槛（按审计模型反推：
  全路径 60% 正确率需 ≥1500 题面 ≈ 现量 2.2 倍；含每日题长期运营需更多），D3 审计重跑以扩容后语料为准。

---

## 5. 修订清单（按文档归位）——**已于 2026-09-20 全部应用**

**详设（detailed-design.md）：**

| # | 位置 | 修订 | 状态 |
| --- | --- | --- | --- |
| 1 | §2.1 | DAILY：A2 过期重建分支；A6 countFor 顺序修正；A7 三处 kind 推导站点（kindOfStage 单点化） | ✅ |
| 2 | §2.1/2.2 | A10 补签 madeUp 字段 + makeup 路由；B2 月历改真实天数 + ISO 周口径；B3 周奖追溯限最近 8 周 + completedWeeks 纯函数 | ✅ |
| 3 | §2.3 | A8 recent → recentGames 近 3 局数组、挪入 D1 交付；A5 seenCount 只数 sourceKey 行（contains ":"）；B4 score 落折后值 + GameSession.accuracy 字段 | ✅ |
| 4 | §3.2/3.3 | A4 faceKey 加 pos + faceKeyOfKey 四段解析 + collectSeenKeys 改造（推荐 meta 补 lineIndex/pos）；A1 DYNASTY_PICK 真实朝代白名单；B9 混入率测试口径注记 | ✅ |
| 5 | §4.1 | A9 hintRoundIndex 字段 + resume 按轮灰置；B4 score 折后口径 | ✅ |
| 6 | §4.2 | A3 竞猜改猜 rankId+2 迷雾阶，rankId>=8 入口隐藏（含皇帝保护），定位改"每日点击奖励" | ✅ |
| 7 | §4.5 | B6 myChaseTarget 从合并列表计算（弃 count 查询）；C3 虚拟位功名利值定数 | ✅ |
| 8 | §6/§7 | B7 全文 12→11 阶；B8 表情包 6 张口径；B5 maxCombo orderBy 前提；B1 D1 测试断言改"判前视图"；各期测试计划补 review 回归用例 | ✅ |
| 9 | §0 | 加 D0 语料扩容并行轨（≥1500 题面 / ≥5 朝代门槛） | ✅ |

**方案 v2（optimization-and-art.md，升级为 v2.1）：**

| # | 位置 | 修订 | 状态 |
| --- | --- | --- | --- |
| 1 | 头部/§1/§2.1/§2.2/§4.2/§6/§8 | B7 "12 阶/12 张"全部勘正 11 | ✅ |
| 2 | §4.4 | A3 剪影竞猜改猜迷雾阶（rankId+2），与 §4.1 迷雾规则自洽 | ✅ |
| 3 | §5.6 | C1 "消耗少量功名"勘误为局末折价 ×0.8（删除线保留原文） | ✅ |
| 4 | §6 | C2 引文出处标注（数字不可回溯核验、仅方向性参考、对外引用须重新核验） | ✅ |
| 5 | §4.1 | C5 难度暗示改"高阶大员·???"，避真实品级词 | ✅ |
| 6 | §5.4 | A1 朝代配对补白名单兜底与 D0 前置依赖注记 | ✅ |
| 7 | §2.1/§8 | B8 表情资产口径 6 张（normal 复用立绘）对齐详设 | ✅ |
| 8 | §8 | 并行轨注记（语料扩容为阶段 3 前置） | ✅ |

（B10 无外键"有意为之"注记已落详设 §2.1 schema 注释；C4 功名簿柱状图口径已落详设 §2.4。）

---

## 6. 结论

- 分期结构（D1–D6）、架构红线执行、测试与美术纪律：**通过**，不需要重构。
- A1–A10 修订完成前，**D2（每日题/成就）、D3（新题型）、D4（hint/竞猜）不应开工**；
  D1（persona/主页/结算）在修掉 A8（recentGames 挪期）与 B1（测试口径）后可以先行。
- D6（皇榜）修 B6/C3 后可随时并行，零 schema 风险最低。
- 语料扩容（§4）升格为显式并行轨，是全部玩法层扩充的物理前提。
