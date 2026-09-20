# 诗词升官 · 阶段 B（数据层 + 接口）实施记录

日期：2026-09-20。分支：feature/poetry-rank。依据 `2026-09-17-poetry-rank-review-and-next.md` §阶段B。

## 完成范围

| 项 | 实现 | 验证 |
| --- | --- | --- |
| PlayerRank 持久化 | `prisma/schema.prisma` 新增模型（一玩家一条，rank + totalExp，只增不减） | 集成测试 |
| 已见 sourceKey/faceKey | 新增 `PlayerSeenKey`（playerId+key 唯一）；出题即占用，双维度落库（素材 key + 题面 faceKey），原素材删除/换 ID 后同题面仍被排除 | 集成测试「出题即占用已见」 |
| 事务选题 | `rank-service.startRankedSession`：单事务内读官阶 → 读已见 → `buildRankedRounds` 选题 → 占用已见 → 建局；并发冲突（P2002）换随机种子重试（上限 3 次） | 集成测试「双开并发不重复」（6 局并发零重叠） |
| 会话结算标记 | `GameSession` 加 `kind`(STAGE/RANKED)、`rankId`、`settleKey`；结算 = `updateMany(status ACTIVE + settleKey null → FINISHED + 占位)` 原子抢占 | 集成测试「并发双开最后一题：功名只加一次」 |
| 一次性结算 | 结算单事务：占位 → 末题答案落库（含 gained 判分）→ 功名累加（= 本局判分之和，DB 求和可恢复）→ 晋升再校验；`AnswerRecord` 新增 `gained` 列 | 集成测试「重复结算不加分」（410/409 两路径） |
| 晋升再校验 | 复用 `evaluatePromotion` 纯函数：目标官阶 = 当前 + 1、功名达标、正确率 ≥60%；客户端 rankId 显式传入时服务端强制比对（越级/错位 → 403） | 集成测试「晋升闭环」「科考失败」「无资格考试被拒绝」 |
| API | `POST /api/games/poetry/rank/start`、`POST /api/games/poetry/rank/answer`（withCrypto 加密信封，保留服务端判题与答案永不下发）；`GET /api/games/poetry/rank?playerId=` 只读官阶视图（明文，同 /api/leaderboard 惯例） | tsc + lint + 集成测试 |
| DB 不可用 | 官阶模式直接 503，**不做内存兜底**（功名/已见必须持久化，兜底会破坏红线） | 设计约束（代码路径） |
| 旧存档保留 | `GameSession.kind` 默认 STAGE；学段会话（kind=STAGE）不受官阶判题入口影响；PlayerProgress / 学段 LRU 已见完全不动 | 集成测试「旧存档保留」 |

## 计分口径（与容量报告对齐）

- 逐题计分复用 `score.ts` `computeScore` 纯函数（基础 100 × 连击倍率 + 速度奖励），与容量审计 `expPerPractice/expPerExam` 同口径。
- 功名 = 每局结算时 `totalExp += 本局全部判分之和`（答错 0 分；失败/弃局保留已得功名，只增不减）。
- 功名与对局总分同源；排行榜仍只统计学段局（`getLeaderboard` 按 mode+stage 查，未过滤 RANKED 会话的 stage 值为 PRACTICE/EXAM，与学段标签天然不同名，无串榜）。

## 验证结果

- `npx vitest run tests/db/rank-integration.test.ts`：16/16 通过（临时隔离库，`prisma db push --skip-generate` 现场建库）。
- `npm test` 全量：241/241 通过（21 个文件，含本轮新增 16 项）。
- `tsc --noEmit`：0 错；新增文件 ESLint：0 错 0 警。
- 覆盖阶段 B 验收五项：双开并发不重复、重启不遗忘（重建客户端后已见仍可排除）、重复结算不加分、无资格考试被拒绝（403 三路径）、旧存档保留。

## 边界与遗留

- **未做浏览器验收**（阶段 C）：前端界面（路线图/功名条/研习与科考入口/失败重考/缺题提示）未开发；真实浏览器验证首次晋升、刷新恢复、重复请求、移动布局留待阶段 C。
- 集成测试「重启不遗忘」以「重建 Prisma 客户端实例」近似进程重启；已见记录在库文件中，语义等价。
- `prisma generate` 在本机偶发 EPERM（dev server 占用 query engine dll），重跑即成功；测试内用 `db push --skip-generate` 规避。
- 皇帝大考（rankId=10，15 题）走同一入口；当前语料 g12 仅 3 首，容量不足时按 409「容量不足」如实上报（行为已覆盖）。
- 未迁移真实数据库、不提交推送由用户决定；本轮仅提交本记录与代码变更。
