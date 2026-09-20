# Zcode P0/P1 执行进展

日期：2026-09-18。工作目录 D:\Ai\GuessEverything，分支 feature/poetry-rank。

## 接收确认

- 已读取 `docs/design/2026-09-18-zcode-p0-p1-task.md`（任务书）。
- 已读取 `CLAUDE.md`（项目规约）与 `docs/design/2026-09-18-agent-question-bank-engine.md`（设计稿）。
- 范围确认：仅实现 P0（类型合同、状态机、来源证据规范、预算规则、模拟 provider、固定正确/错误样本）与 P1（临时 SQLite 测试库、持久化任务队列、模板命题、校验、模拟审核、发布/回滚、CLI 演示与交付报告）。不启动 P2/P3/P4。
- 约束确认：保留当前全部未提交工作（engine.ts / types.ts 已修改，capacity/promote/rank 等未跟踪文件均保留）；不删除/重置已有代码；不提交推送；不联网采集诗词；不修改真实游戏数据库、不运行真实 db:push/db:seed；不读取 .env 或其他凭据；不操作桌面或向外部聊天发消息；不修改 zcode.json 或启动脚本；不降低权限模式。

## 授权范围（本轮用户批准）

- 可编辑目录：`src/lib/question-bank/`、`src/lib/db/question-bank-*`、`tests/question-bank/`、`scripts/question-bank/`、`docs/design/`、`prisma/question-bank/`。
- 测试命令：`npm.cmd test`、`npm.cmd run lint`、`npx.cmd --no-install tsc --noEmit --incremental false`、`npx.cmd --no-install vitest run tests/question-bank`。
- 演示打包额外使用：`npx.cmd --no-install esbuild ... --bundle`（项目已有 esbuild 0.28.2，产物写入 `node_modules/.cache/`，不新增依赖、不改 package.json）。

## 代码状态核查（2026-09-18 续跑，模型断连恢复后）

上次会话模型断连，仅留下源码，**未运行过任何测试**。首次核查时以下"已实现"均为未验证状态，现已全部验证通过（见"验证结果"）。

### 源码清单（现已验证）

| 文件 | 内容 | 状态 |
| --- | --- | --- |
| `src/lib/question-bank/contracts/types.ts` | P0 全部类型合同：来源/快照/证据、作品与版本、题目与版本、审核记录、任务队列、预算、发布、provider 接口、固定样本标签 | 已实现，已验证 |
| `src/lib/question-bank/contracts/state-machine.ts` | 候选题状态机（DRAFT→VALIDATING→REVIEWING→APPROVED，分流 NEEDS_REVISION/QUARANTINED/REJECTED）与任务状态机（QUEUED/RUNNING/RETRY_WAIT/SUCCEEDED/FAILED/PAUSED） | 已实现，已验证 |
| `src/lib/question-bank/sources/evidence.ts` | 内容哈希、规范化（繁简小表）、快照构建、span 回溯、注入特征识别、证据完整性校验 | 已实现，已验证 |
| `src/lib/question-bank/validators/rules.ts` | 规则校验器：来源/证据/选项/答案模板/多解/别名/泄漏/去重，各 issue code 独立 | 已实现，已验证 |
| `src/lib/question-bank/pipeline/budget.ts` | 预算准入/结算/退避/失败决策（TRANSIENT 重试上限、耗尽 PAUSE） | 已实现，已验证 |
| `src/lib/question-bank/providers/simulated.ts` | 模拟 provider：REVIEW 独立作答、REVISE 确定性修订、注入双保险 | 已实现，已验证 |
| `src/lib/question-bank/infra/question-bank-db.ts` | 临时 SQLite：任务队列（幂等入队、原子租约领取、心跳、过期重领、旧租约拒绝、暂停/恢复、批次预算）+ 候选区（batches/sources/snapshots/works/work_versions/question_versions/reviews）+ 发布层（不可变清单、原子激活、回滚、审计） | 已实现，已验证 |
| `src/lib/question-bank/infra/sqlite-ambient.d.ts` | node:sqlite 最小类型声明 | 已实现，已验证 |
| `src/lib/question-bank/samples/fixed.ts` | **本次新增** P0 固定样本集：10 条样本覆盖 正确×3、异文、别名冲突、多答案、歧义选项、重复题面、答案泄漏、来源提示注入 | 已实现，已验证 |
| `src/lib/question-bank/pipeline/composer.ts` | **本次新增** 模板命题器：题干选取（倒数第二句/中间句）、四选项、干扰项池过滤、证据映射、题目身份（questionIdentityKey）、确定性洗牌 | 已实现，已验证 |
| `src/lib/question-bank/pipeline/review.ts` | **本次新增** 审核/修订闭环（ReviewPipeline）：校验→独立审核→修订（创建新版本从 VALIDATING 重跑）；审核绑定 inputHash；修订轮次上限→QUARANTINED | 已实现，已验证 |
| `src/lib/question-bank/pipeline/publisher.ts` | **本次新增** 确定性发布器：buildManifest（验收 APPROVED + 审核哈希一致）、确定性 manifestHash、publishBatch（验收门控→幂等写清单→可选原子激活）、rollbackTo | 已实现，已验证 |
| `src/lib/question-bank/pipeline/orchestrator.ts` | **本次新增** 编排器/worker 主循环：createBatch/ingestWork/planComposeTasks、workOnce（COMPOSE→REVIEW→PUBLISH）、drain、崩溃恢复、预算预留/结算、回滚封装 | 已实现，已验证 |

### 核查结论

- Node v24.14.0，`node:sqlite` 可用（DatabaseSync，`:memory:` 与临时文件均可）。
- esbuild 0.28.2 在项目 node_modules 中，用于演示脚本打包。
- `git diff` 中 `src/lib/games/poetry/engine.ts`、`types.ts` 的改动属于既有官阶（rank）工作，与本任务无关，保持原样未动。

## 计划步骤

1. [x] 探查现有代码结构（`src/lib/games/poetry/`、`tests/`、vitest 配置、依赖）。
2. [x] 核查断连前代码，更新本进度文档（标记已实现/未验证/缺失）。
3. [x] P0：固定样本集（异文、别名、多答案、重复、答案泄漏、来源提示注入、正确样本）→ `samples/fixed.ts`。
4. [x] P1：候选区持久化表（batches/sources/snapshots/works/work_versions/question_versions/reviews）→ `question-bank-db.ts`。
5. [x] P1：模板命题器（猜诗人/猜诗名/补下句，四选项、证据映射、题目身份）→ `pipeline/composer.ts`。
6. [x] P1：审核/修订闭环（审核绑定 inputHash、修改后失效、修订后重新验证、轮次上限→待核验）→ `pipeline/review.ts`。
7. [x] P1：发布清单构建 + 哈希一致性 + 幂等发布/原子激活/回滚 → `pipeline/publisher.ts`。
8. [x] 测试：`tests/question-bank/`（样本验收、队列集成、审核绑定、发布回滚、端到端管线、纯函数单测）。
9. [x] CLI 演示脚本 + 验收报告（模拟模型 + 隔离测试库全链路）→ `scripts/question-bank/demo.ts`。
10. [x] 验证：`npm test`、`npx tsc --noEmit`、相关文件 lint；失败修复重跑（见"验证结果"）。

## 新增测试（tests/question-bank/，共 74 用例，全绿）

| 文件 | 覆盖维度 | 用例数 |
| --- | --- | --- |
| `fixed-samples.test.ts` | 歧义、多答案、作者别名、重复题、答案泄漏、提示词注入、异文、正确；维度完整性断言 | 14 |
| `queue-integration.test.ts` | 幂等入队、并发领取、领取顺序、心跳续租、租约超时回收（崩溃恢复）、过期不回收、有限重试（TRANSIENT→RETRY_WAIT→退避→重领；达上限 FAILED）、PERMANENT→FAILED、旧租约迟到拒绝、暂停/恢复、预算不超卖、reserveAndEnqueue 幂等 | 12 |
| `review-binding.test.ts` | 审核通过→哈希一致；inputHash≠contentHash→不视为通过；审核后修改→发布拒绝（NO_PASS_REVIEW）；修订创建新版本独立审核；修订轮次上限→QUARANTINED | 5 |
| `release-integration.test.ts` | 幂等发布（同 batchKey 不产生第二份）、清单哈希敏感、原子激活（旧指针拒绝）、回滚（切回 + ROLLBACK 审计 + 清单保留）、回滚至 null、验收门控（非 ok 不写清单 + REJECTED 审计）、审核哈希≠发布哈希→验收失败 | 8 |
| `e2e-pipeline.test.ts` | 全链路（采集→命题→审核→发布→激活，12 题）、崩溃恢复、重复任务幂等、发布后回滚、坏作品（WORK_NOT_IN_SNAPSHOT）被隔离不入清单 | 5 |
| `pure-functions.test.ts` | 状态机合法/非法迁移、预算规则、模板命题器（三题型/证据回溯/干扰项不足/种子复现/题目身份）、证据规范化/哈希/定位/注入、规则纯函数（题面指纹/内容哈希/相似度/模板答案）、模拟 provider（独立作答/修订/注入双保险/故障注入） | 30 |

## 演示脚本（scripts/question-bank/demo.ts）

- 使用 `SimulatedProvider`（纯模拟，**非真实模型**）+ 临时文件隔离 SQLite 库（`os.tmpdir()` 下一次性目录，运行后删除；崩溃恢复段另开 `:memory:` 独立库使"4 题发布"自洽）。
- 全链路：采集 4 首公版诗 → 3 题型×4 作品=12 个 COMPOSE → 审核/修订 → 发布激活 → 幂等重发 → 修订闭环 → 崩溃恢复（领取后崩溃→过期回收→完成）→ 回滚。
- 输出结构化验收报告（9 项），任一失败退出码 1。
- 运行方式（项目根）：
  ```
  npx --no-install esbuild scripts/question-bank/demo.ts \
    --bundle --platform=node --format=esm \
    --outfile=node_modules/.cache/question-bank-demo.mjs \
    && node node_modules/.cache/question-bank-demo.mjs
  ```

## 验证结果（实际执行）

| 命令 | 结果 |
| --- | --- |
| `npm.cmd test`（全量） | **225/225 通过**（20 个测试文件，含既有 151 + 新增 74） |
| `npx.cmd --no-install vitest run tests/question-bank` | **74/74 通过**（6 个文件） |
| `npx.cmd --no-install tsc --noEmit --incremental false` | **0 错误**（全仓，含测试与脚本） |
| `npm.cmd run lint` | 本任务新建/修改的 question-bank 文件 **0 error / 0 warning**；剩余 error 全部位于 `.research/`、`.research_tmp/`（任务开始前即存在的未跟踪调研脚本，非本任务代码，按"保留已有未提交修改"约束未改动） |
| 演示脚本（esbuild 打包 + node 运行） | **9/9 验收通过**，退出码 0 |

### 演示报告关键结论

- 采集：4/4 入库。
- 命题+审核+发布：12/12 APPROVED 并激活，清单 12/12（GUESS_POET 4 / GUESS_TITLE 4 / COMPLETE_NEXT 4），失败步骤 0。
- 审核哈希 = 发布哈希：12/12 条一致。
- 预算结算：spent=4340，reserved=0（已结算无残留）。
- 幂等：重复 drain 返回 0 步；同 batchKey 重复发布返回既有清单（idempotent=true，不可变）。
- 修订闭环：v1(重复选项)→NEEDS_REVISION→v2 独立审核 APPROVED，v2 审核 inputHash 绑定 v2 contentHash。
- 崩溃恢复：过期回收 1 项后管线完成，清单 4/4。
- 回滚：切回无激活清单，清单保留（不可变，不删除）。

## 实现过程中发现并修复的关键缺陷（记录，供后续参考）

1. **任务队列幂等键缺 batchId（跨批次污染）**：COMPOSE/REVIEW 的幂等键原为全局唯一且不含 batchId，导致不同批次对同一作品×题型生成相同幂等键，后建批次 `reserveAndEnqueue` 命中前批次已 SUCCEEDED 的任务而静默不建任务（崩溃恢复演示中批次 B2 入队 0 任务）。修复：幂等键加 batchId 前缀，任务队列幂等改为"批次作用域"；候选题全局去重由 question_versions/题面指纹独立承担，与任务层正交。
2. **PUBLISH 时序竞争**：PUBLISH 原在首个 REVIEW 通过时即被领取执行，清单只含 1 题。修复：`claimTask` 增加发布门控——批次内仍有未完结非发布任务时 PUBLISH 不可领，确保清单含批次全部已批准题。
3. **题面去重自误报**：修订只换选项、题面不变，原 `existingFaceFingerprints` 仅排除"当前版本自身"，修订版本会与自身前版误报 DUPLICATE_FACE。修复：按 questionId 排除整个知识点所有版本（题面由知识点身份决定）。
4. **入队 SQL 参数/占位符不匹配**、**activateRelease 审计 id 确定性冲突**（同清单二次激活撞 UNIQUE）、**getActiveRelease 指针清空后未返回 null**、**existingFaceFingerprints SQL 缺 AND**、**繁简表缺 静**、**COMPLETE_NEXT 选项同质性判定反了**——均已修复。
5. 测试数据修正：e2e 作品版本需登记 snapshot 定位证据（`evidence` 非空）且 sourceId 与快照一致；崩溃恢复需用可推进时钟（冻结时钟下回收任务的 available_at 落在未来永不可领）。

## 里程碑记录

- [x] M0 任务接收，创建进展文件（2026-09-18）
- [x] M1 代码结构探查完成（含断连恢复核查）
- [x] M2 P0 合同与模拟 provider 完成并通过单测
- [x] M3 P0 固定样本集完成并通过单测
- [x] M4 临时 SQLite 测试库与 schema 就绪
- [x] M5 任务队列实现并通过集成测试
- [x] M6 命题/校验/模拟审核/修订闭环完成并通过测试
- [x] M7 发布/激活/回滚完成并通过测试
- [x] M8 CLI 演示与交付报告完成
- [x] M9 全量验证（test / tsc / lint）完成并汇总

## 状态说明

模拟 provider 的验证仅代表管线确定性逻辑正确，**不代表真实模型审核，也不代表正式入库**。
P0/P1 完成标准已达成：P0/P1 自动化测试通过（74 新增 + 225 全量）+ 隔离数据库端到端演示成功（9/9）+ 报告与实际结果一致。
未进入 P2（真实采集/付费模型/真实游戏接入）。
