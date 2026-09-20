# 诗词升官优化 · 新窗口开工提示词（2026-09-20）

> 用法：整段复制给新会话（编码代理窗口）。设计已冻结（review 修订全部应用），新窗口职责是**实现**，不是再评估。

---

## 提示词正文（从这里开始复制）

项目：`D:\Ai\GuessEverything`，分支 `feature/poetry-rank`（本分支只含诗词升官玩法）。

任务：按详细设计分期实现诗词升官优化。**设计已冻结**（评估 A1–A10/B/C 级修订已全部落文档，正文以「review Xn」标注）——不要推翻设计；若发现设计与代码/自身判断矛盾，停下来报告，不要自行改设计。

### 开工前必读（按顺序）

1. `docs/design/2026-09-20-poetry-rank-detailed-design.md` —— 落地依据（D0–D6：schema diff / 纯逻辑接口 / API 契约 / 时序 / 测试计划，全部以这份为准）
2. `docs/design/2026-09-20-poetry-rank-optimization-and-art.md`（v2.1）—— 玩法与美术策略（人物/迷雾/成就/美术纪律）
3. `docs/design/2026-09-20-poetry-rank-design-review.md` —— 评估记录（了解修订原因即可，不必复评）
4. `docs/design/2026-09-20-poetry-corpus-plan.md` —— 语料扩容计划（仅当执行 D0 时）

### 执行顺序（一期一验收一提交，验收不过不进下期）

| 序 | 期 | 要点（详见详设对应章节） |
| --- | --- | --- |
| 1 | **D1** | `persona.ts` 纯逻辑层 + 单测（同 seed 同句）→ `rank-service` 视图接线（start 视图 +persona/opening；judge 视图 +feedback；结算 +settleLine；**RankView +recentGames(近3局)/seenCount 本期交付**）→ 前端（persona-bubble、身份卡、rank-road 迷雾重写、结算仪式感）。红线测试断言是**「判前视图（start/resume 的 rounds）不含答案」**，不要写已废弃的"反馈句不含答案"（详设 §7 D1）。 |
| 2 | **D6**（可与 D1 并行） | `leaderboard.ts` 纯逻辑层（`mergeLeaderboard` + `myChaseTarget`；虚拟位 5 个功名利值见 §4.5：李白·翰林·52000 / 苏轼·侍郎·112000 / 辛弃疾·知府·76000 / 王勃·举人·12000 / 孟浩然·秀才·6000）→ `GET /api/games/poetry/rank/leaderboard`（明文）→ 皇榜页。零 schema。 |
| 3 | **D0**（并行轨，D2/D3 的硬前置） | 语料扩容，目标门槛：全库题面并集 **≥1500**、朝代 **≥5**；逐批 `poetry-corpus-audit.ts` 结构验收 + 人工校对原文/作者/难度 → `db:seed` 幂等入库 → `poetry-capacity-audit.ts` 重跑至 60% 正确率全路径回放可行。 |
| 4 | **D2**（等 D0 达标） | DAILY 每日题 + 月历 + 成就 + 功名簿。关键改造点：`countFor` DAILY 提级（§2.1 代码）；`kindOfStage` 单点化三站点（§2.1 表，含 :147 越级修复）；PlayerDaily 过期重建分支；补签 madeUp + makeup 路由；GameSession 加 accuracy 字段；score 落**折后**值。 |
| 5 | **D3**（等 D0 达标） | 诗词阁 + FILL_CHAR/DYNASTY_PICK。关键改造点：faceKey 加 pos 参数；`faceKeyOfKey` 四段 key 解析；`collectSeenKeys` 改 meta 反查（§3.2 三处解析链）；DYNASTY_PICK 用**真实朝代白名单**（§3.3 常量）；capacity `ALL_TYPES` 加两型。 |
| 6 | **D4**（依赖 D2 的 kindOfStage/PlayerDaily） | hint（hintUsed/hintRoundIndex/hintRemoved 三字段 + resume 按轮灰置 + 结算 ×0.8）+ 剪影竞猜（猜 **rankId+2** 迷雾阶，rankId≥8 入口隐藏）+ makeup 路由若 D2 未含则本期补。 |
| 7 | **D5** | 美术资产入库（11 张主角立绘 + 2 NPC 立绘 + 6 张表情变体）+ 全量浏览器回归。D5 前占位 emoji，引用统一走 `src/lib/art-assets.ts` 常量表。 |

### 铁律（违反即停）

- `src/lib/games/` 零依赖纯函数：不 import `next/*`、`@prisma/client`、`react`、任何 IO；语料/随机数/配置参数注入（mulberry32 口径复用 `sampling.ts`/`distractors.ts`）。
- 答案永不下发：任何 API 响应不得含 `answerIndex`/正确选项序；判题只在服务端（`rank-service.ts`）。
- 业务 Route Handler 一律 `withCrypto` 包装；明文接口仅限 GET 视图（rank/ledger/gallery/leaderboard）。
- 防作弊（会话 TTL/nonce/时间戳）在加密层统一处理，业务层不重复实现；官阶/功名门禁服务端强制；结算幂等沿用 settleKey 占位风格。
- 架空称号不宣称真实官制；本分支不引入新玩法模式、不引入好友/账号体系；语料仅公版。
- 功名 totalExp 只增不减——任何机制不得扣减（hint 用 ×0.8 折价局末结算，不直接扣）。

### 代码基线（2026-09-20 核实）

- `rank-service.ts` 678 行 / `engine.ts` 375 行 / `schema.prisma` 121 行 / 页面 348 行；详设里的行号是基线快照，**以符号定位为准**。
- `RANKS` 共 **11 条**（id 0..10 = 布衣 + 9 官衔 + 皇帝；旧文档"12 阶"是勘误对象）。
- 语料 48 首（唐 27 / 宋 18 / 清 3），grade 1–12 全覆盖；全库题面并集 693（D0 扩容前）。
- `Poem.lines` 是 Json 数组；`PlayerSeenKey` 同时存 sourceKey 行（冒号分隔）与 faceKey 行（竖线分隔）——统计已见题数只数 sourceKey 行。

### 每期验收门禁（全过才提交）

1. `npm test`（Vitest）全绿，含本期新增用例（详设 §7 逐条）；
2. `npm run lint` 0 警告；
3. `npm run build` 通过（tsc strict）；
4. 浏览器验收：`npm run dev` 起服务后走 IDLE / 对局 / 结算 / 刷新恢复 + 本期新功能。**本机 Hermes browser_exec 缺 Chromium 不可用**——用 playwright-core（scratch 目录 npm 装）+ 项目已下载的 Chromium（`C:/Users/Administrator/AppData/Local/ms-playwright/chromium-*/chrome-win64/chrome.exe`，executablePath 自写脚本）验收；dev server 反复重启易致 `.next` 缓存损坏全页 500：停进程树 + `rm -rf .next` + 重启即愈。

### 提交纪律

- 一期一个 commit（中文 message，引用详设期号，如「D1：人设对话系统 + 主页重做 + 结算仪式感」）；schema 变更随当期一并提交（`db:push` 后验证）。
- 只加不改既有表结构（新增字段/表，不动旧字段）。
- 未经授权不 push、不 rebase、不清理工作区；`.env` 永不入库；报告中不写凭据/密钥。
- 每完成一期汇报：改了什么（文件清单）/ 验证了什么（真实测试、构建、浏览器输出）/ 遗留什么（阻塞、需人工决策项）。

（到这里结束复制）
