# P2 预留项 · 详细设计方案（2026-09-21）

> 分支：`feature/poetry-rank-p2`（从 `feature/poetry-rank` HEAD 切出）
> 依据：详设 v1 §25 / §592「P2（内侍/同窗/说书人立绘、限时事件框架、分享卡、外观）仅预留接口位」。
> 本文是 P2 三期的设计冻结源（外观系统不在本期，顺延 P3）。
> 红线继承 v1：答案/answerIndex/sourceKey 绝不下发；纯逻辑层零 IO；业务接口一律 withCrypto；
> 随机/时间可确定性注入；美术引用只走 `art-assets.ts`；语料不动。

## 范围与分期（一期一 commit）

| 期 | 内容 | 交付 |
| --- | --- | --- |
| P1 | 内侍/同窗/说书人立绘（Q 版） | ComfyUI 生图 3 张入库 `public/art/` + art-assets 常量表 + 三个挂载点（问同窗按钮/事件横幅/每日题按钮） |
| P2 | 限时事件框架 | 纯逻辑事件引擎（确定性窗口）+ 结算功名加成（服务端）+ 官途页事件横幅 + 赛季钩子（seasonKey 接口位） |
| P3 | 分享卡 | 结算页「生成分享图」入口，canvas 长图（纯客户端，零新增接口），playwright 验收下载产物 |

顺序依赖：P3 分享卡画布用到 P1 立绘（同窗立绘入卡）；P2 事件横幅用内侍立绘。P1 → P2 → P3。

---

## P1 · 内侍 / 同窗 / 说书人立绘

### 1.1 资产规格

- 风格沿用 D5 定稿：Q 版、2.5 头身、靛蓝底 + 琥珀金点缀、半身立绘 PNG。
- 生成：ComfyUI 远程链路（Z-Image Turbo，`remote-gpu-server-comfyui` 技能），prompt 见 `art-prompts-p2.md`（附后）。
- 文件命名（`public/art/`）：
  - `q_npc_classmate.png` 同窗（Q 版学童，持书卷，友善微笑）
  - `q_npc_inattendant.png` 内侍（Q 版宫廷内侍，青袍，捧圣旨卷轴）
  - `q_npc_storyteller.png` 说书人（Q 版说书人，持折扇，醒木）
- 一致性验收：与 `q_npc_tutor.png`/`q_npc_examiner.png` 并排目视对比（同底、同比例、同线宽）。

### 1.2 代码接入（`src/lib/art-assets.ts`）

```ts
export type ExtraNpcKey = "CLASSMATE" | "INATTENDANT" | "STORYTELLER";
export const EXTRA_NPC_AVATARS: Record<ExtraNpcKey, string> = {
  CLASSMATE: "/art/q_npc_classmate.png",
  INATTENDANT: "/art/q_npc_inattendant.png",
  STORYTELLER: "/art/q_npc_storyteller.png",
};
```

挂载点（仅 UI，不改玩法逻辑）：
1. **问同窗按钮**（`page.tsx` 对局区）：按钮左侧加 32px 同窗头像（ArtAvatar）。
2. **每日题按钮**（`page.tsx` 主页）：左侧加 20px 说书人头像（每日题 = 说书人每日讲一段）。
3. **事件横幅**（P2 交付；无事件时不渲染，内侍头像占位留待 P2 接入）。

### 1.3 测试与验收

- 单测：art-assets 常量表导出形状（3 key → 字符串且以 `/art/` 开头）。
- 浏览器：三挂载点 img 解码 + 并排对比截图。

---

## P2 · 限时事件框架

### 2.1 纯逻辑层 `src/lib/games/poetry/events.ts`（零依赖）

```ts
export interface EventSpec {
  id: string;            // 稳定 id："poetry-moon" | "imperial-exam"
  name: string;          // 「诗月圆」|「钦天大比」
  tagline: string;       // 一句话文案（架空，不涉真实历法宣称）
  expMultiplier: number; // 功名倍率：诗月圆 1.2 / 钦天大比 1.5
  /** 窗口（上海时区，日期粒度；startMs/endsAt 为精确毫秒） */
  startMs: number;
  endsAt: number;
}

/** 当前生效事件（无则 null）。dateKey = Asia/Shanghai 日期串（YYYY-MM-DD）注入，保证可测。 */
export function activeEvent(nowMs: number, dateKey?: string): EventSpec | null;
/** 事件窗口判定纯函数：给定日期串返回该日生效事件（确定性，可单测） */
export function eventForDate(dateKey: string): EventSpec | null;
```

窗口规则（固定排期，无 DB、无开关，确定性）：
- **诗月圆**：每周二 ~ 周四 00:00:00.000 ~ 23:59:59.999（Asia/Shanghai），`expMultiplier = 1.2`。
- **钦天大比**：每月 15 日全天，`expMultiplier = 1.5`（15 日恰为周二~四时与诗月圆重叠，**取倍率高的**，id 记为 `imperial-exam`）。
- 日期计算全部走注入的 `dateKey`（由服务端 `new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" })` 生成，与 D2 月历同口径）。

### 2.2 服务端接入（`rank-service.ts`，判题/结算同文件收口）

- **快照口径**：事件按对局 `GameSession.createdAt` 所在日期判定（开局时刻锁定，中途跨日不变）——无 schema 变更（GameSession.createdAt 已有），结算时 `eventForDate(dateKeyOf(session.createdAt))` 重算，确定性可复算。
- **功名加成**：`settleRankedSession` 内 `expGained = round(baseExpGained × event.expMultiplier)`（四舍五入取整；PRACTICE/DAILY 适用，EXAM 晋升判定不受加成影响——科考只比正确率，功名加成仅影响入账）。
- **settleLine 追加**：命中事件时结算台词尾部拼内侍播报句 `「内侍宣：${event.name}赐功 ×${event.expMultiplier}。」`（persona 文案池扩展，纯逻辑层 `persona.ts` 新增 `eventLine`，不泄答案红线不变）。
- **接口视图**（全部 withCrypto，不下发答案）：
  - `RankView` 增字段 `event: { id, name, tagline, expMultiplier, endsAt } | null`（`buildRankView` 内 `activeEvent(Date.now())` 计算）；
  - `RankedStartView` 增 `event: string | null`（开局锁定的事件 id，客户端横幅一致性）；
  - `RankSummary` 增 `event: { id, name, expMultiplier } | null`（结算实际套用的事件）。
- **防作弊**：事件判定纯服务端（客户端不传事件参数）；功名入账以服务端结算为唯一权威（既有不变量）。

### 2.3 前端

- **事件横幅**（`page.tsx` 主页，rank.event ≠ null 时）：琥珀金描边卡片，内侍头像（P1 资产）+ 事件名 + tagline + 倍率 + 倒计时（到 endsAt，客户端倒计时纯展示）。
- **HUD 角标**：对局中 `RankedStartView.event ≠ null` 时 HUD 右侧显示事件小徽标（id → 文案查纯逻辑表）。
- 结算视图：`summary.event` 存在时在功名入账行下追加一行「${event.name}赐功 ×${expMultiplier}」。

### 2.4 赛季钩子（接口位，不实现重置）

- `LeaderboardView` 增 `season: string`（v1 恒 `"v1"`，纯派生常量）；`rank-service.buildLeaderboard` 内生成。
- 赛季重置（快照落库 + 榜单重置 + 结算定格）明确**不在本期**：需要 `SeasonBoard` 表与定格事务，留 P3 与外观一并设计，避免现在引入时间轴复杂度（详设 §443 原意）。

### 2.5 测试

- 纯逻辑单测（`tests/games/poetry/events.test.ts`）：
  - 周二/周三/周四命中诗月圆；周一/周五/周六/日 null；
  - 15 日命中钦天大比；15 日 ∩ 周二~四 → `imperial-exam`（高倍率优先）；
  - 边界：15 日 23:59 命中、16 日 00:00 不命中（同 dateKey 口径）；
  - `expMultiplier` 精确值断言。
- 集成（`tests/db/rank-integration.test.ts` 扩展）：
  - 构造 createdAt 落在事件日的会话 → 结算功名 = round(base × 倍率)（精确断言）；
  - 事件外加权 0 倍（不变量回归）；
  - EXAM 晋升不受加成影响（正确率判定口径不变）；
  - RankView.event 命中/未命中两态；RankSummary.event 与结算入账自洽。
- 浏览器：命中日横幅渲染 + 结算加成行 + 非命中日无横幅。

---

## P3 · 分享卡

### 3.1 形态

- 结算页（`RankSettleView`）底部新增按钮「📸 生成分享图」→ 客户端 canvas 绘制 750×1200 PNG（无新增 API、零服务端参与，数据源 = 既有 `lastSummary` + `rank` 视图，全部已脱敏）。
- 产出：下载 `mihe-share-<rankKey>.png`（a.download + canvas.toBlob）；页内同时展示预览 `<img>`（toDataURL）。
- **红线**：卡面文本仅含——游戏名「谜盒 · 诗词升官」、当前官衔称号 + Q 版立绘、正确率、本局功名、累计功名、新达成成就（≤3 个 label）、日期、架空声明「架空称号 · 非真实官制」。**绝不出现**：具体题目、答案、correctAnswer、sourceKey。

### 3.2 代码

- 纯函数 `src/lib/share-card.ts`（客户端可用，零 IO）：
  ```ts
  export function buildShareCardLines(input: {
    rankLabel: string; accuracy: number; expGained: number;
    totalExp: number; newBadges: string[]; dateKey: string;
  }): { title: string; lines: string[]; footer: string };
  ```
  （文案拼装纯函数可单测；canvas 绘制在组件内。）
- 组件 `src/components/share-card-view.tsx`：
  - 立绘 `drawImage`（`/art/q_hero_rankNN_*.png` 经 art-assets 常量表；图片需先 `img.crossOrigin` 无需——同源 `/art`，canvas 不污染）；
  - 背景：靛蓝渐变 + 琥珀金描边框（与美术风格一致）；
  - 绘制失败（img 未就绪）→ 按钮置灰重试，不静默。
- `RankSettleView` 传参：`heroAsset`（art-assets 常量）+ summary 字段。

### 3.3 测试与验收

- 单测：`buildShareCardLines`（字段拼接、badges 截断 3 个、无答案字段泄漏——用含答案的入参断言输出不含该串）。
- 浏览器（playwright）：结算后点「生成分享图」→ 预览 img 出现（naturalWidth ≥ 700）→ 触发下载（acceptDownloads）→ 下载文件存在且 > 100KB → 截图目视。

---

## 验收纪律（每期）

纯逻辑层单测 + 集成 + `tsc --noEmit` + eslint 改动文件 + `npm run build` + playwright 浏览器验收 + VISION 布局检查，全过后一期一个 commit，首行引用本方案期号（P1/P2/P3）。

## 明确不做（P2 边界）

- 外观/皮肤系统（P3 另行设计）；
- 赛季重置与榜单定格（接口位 season 字段除外，见 §2.4）；
- 付费/广告/账号体系（v1 边界声明不变）;
- 事件的动态开关/运营后台（固定排期纯函数，零运维）；
- 分享卡社交渠道接入（仅本地图下载，微信等渠道不做）。
