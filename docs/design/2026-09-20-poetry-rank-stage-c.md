# 诗词升官 · 阶段 C（前端 + 浏览器验收）实施记录

日期：2026-09-20。分支：feature/poetry-rank。依据 `2026-09-17-poetry-rank-review-and-next.md` §阶段C 与 `2026-09-18-next-steps.md` 后续实施顺序第 4 条。

## 完成范围

| 项 | 实现 | 验证 |
| --- | --- | --- |
| 官途页 `/play/poetry-rank` | 官途主页（路线图 + 功名条 + 研习/科考入口，功名不足时科考置灰并显示缺口）；对局复用 quiz 组件（HUD 倒计时 / 选项 / 判题反馈 / 自动翻题，indigo 主题）；结算视图（功名入账 + 晋升结果） | 浏览器验收 7 组 |
| Zustand 状态 `src/store/rank-store.ts` | 仅持 UI 状态与脱敏轮次视图（答案永不下发）；功名/官阶权威值来自服务端 RankView/RankSummary；新增 `resume(view, rank)` 从首个未答轮次继续 | tsc + 浏览器验收 |
| 路线图/功名条 `src/components/rank/rank-road.tsx` | 架空称号路线图（当前节点高亮、皇帝终点用 `isEmperor` 特判）；功名进度 = totalExp / (totalExp + expToNext) | 浏览器验收（布衣→童生节点点亮） |
| 结算视图 `src/components/rank/rank-settle-view.tsx` | 研习完成（积功名不晋升）/ 科考通过擢升 / 科考失败保留功名可直接重考；文案不宣称真实官制 | 浏览器验收（首次晋升童生） |
| 判题解释 | `RankedJudgeView.explanation`：服务端持有 meta（客户端视图已剥离），拼「出自《诗题》·朝代·作者」，判题两个返回路径均下发 | tsc |
| 刷新恢复 | `POST /api/games/poetry/rank/resume`（withCrypto）：服务端取玩家最近一局 ACTIVE 且未超时的 RANKED 会话（含已答轮次索引与累计分），无则空对象；页面 mount 后异步调用，成功续到首个未答题，失败回落官途主页 | 浏览器验收（答 3 题刷新续到第 4 题） |
| 首页入口 | 首页卡片新增「诗词升官」（布衣 → 11 阶官衔 + 皇帝登极大考） | 构建路由注册 |

## 关键实现决策

- **resume 取 playerId 口径**：`usePlayerStore.getState().playerId ?? localPlayerId()`（与 loadRank / startGame 一致）。
  只读 store 会在刷新时拿到 null（`ensurePlayer` 落盘是异步的，store 初始为 null），导致 resume 请求静默不发、
  回落官途主页——这是浏览器验收首轮发现的真实 bug，已修并在验收中复验。
- **resume 安全边界**：会话必须满足 `status=ACTIVE` 且 `expiresAt > now`（复用服务端 TTL 红线，过期会话不可恢复）；
  下发 `answeredIndexes` + 已得 `score`，客户端跳过已答轮次继续；作答仍走 answer 路由服务端判题。
- **功名条进度**：`required = totalExp + expToNext`（未解锁时）；皇帝终点无下一场科考，进度条语义不适用，用 `isEmperor` 特判文案。
- **失败重考**：科考失败结算视图提供「直接重考」按钮（功名保留，不扣分）。

## 验证结果

- 真实浏览器验收（Chromium headless，真实 UI 点击 + secureFetch/WebCrypto 真实加密通信，脚本侧连 DB 读答案构造作答序列）：**15/15 通过**，覆盖：
  官途主页渲染（功名 0 / 路线图 / 科考门禁置灰）→ 研习全对一局（功名入账 >0、不晋升）→ 再一局达童生门槛 2000（科考解锁）
  → 科考全对（擢升童生 rank=1、功名只增不减）→ 路线图童生节点点亮 → 刷新恢复（答 3 题刷新续到第 4 题）→ 375px 移动布局无横向溢出。
- `tsc --noEmit`：0 错；新增/修改文件 ESLint：0 错 0 警。
- `npm test` 全量：241/241（阶段 B 的 16 项集成测试不受影响）。
- `npm run build`：通过，`/play/poetry-rank` 路由注册（10.5 kB / 125 kB）。

## 边界与遗留

- **刷新恢复的「重复请求」维度**未做浏览器压测（阶段 B 集成测试已覆盖判题重复提交 410/409 语义；resume 为只读查询，无副作用）。
- 验收脚本为一次性（依赖本机 Chromium 路径），已删除；复验需重新编写（或直接走上述流程）。
- **每日题（DAILY）**未开放：服务端拒绝（403），前端不出现入口；后续再做。
- 语料批次 2 未启动（前置：可核验来源文本；g10–12 需补 ≥112 题面才能打通 100% 全路径，瓶颈 g10–12）。
- 皇帝大考（rankId=10，15 题）当前语料容量不足（g12 仅 3 首），会 409「容量不足」如实上报——前端缺题提示分支已具备，待批次 2 后浏览器复验。
- 分支未推送远端。
