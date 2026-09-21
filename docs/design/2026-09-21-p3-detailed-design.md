# P3 详细设计方案：外观系统 + 赛季重置与榜单定格（2026-09-21）

> 分支：master（诗词升官主线，阶段 1-6 已闭环）。
> 依据：P2 详设 §2.4「赛季重置（快照落库 + 榜单重置 + 结算定格）留 P3 与外观一并设计」、
> P2 方案「明确不做：外观/皮肤系统（P3 另行设计）」、优化方案 §5.8（外观纯装饰）。
> 红线继承：答案永不下发；纯逻辑层零 IO；业务接口一律 withCrypto；美术引用只走 art-assets.ts；
> 架空文案不宣称真实官制；功名只增不减（**赛季只重置榜单维度 seasonExp，totalExp/rank 常青不清零**）。

## 范围与分期（一期一 commit）

| 期 | 内容 | 交付 |
| --- | --- | --- |
| P3-1 | 外观/皮肤系统 | 皮肤纯逻辑表 + 首批 1 件资产（皇帝龙袍金边变体，ComfyUI 生图）+ 解锁/装备服务端权威 + 衣冠页 + 身份卡/结算/分享卡穿戴渲染 |
| P3-2 | 赛季重置与榜单定格 | 季度赛季键纯函数 + PlayerRank.seasonKey/seasonExp + SeasonBoard 快照表（惰性定格幂等）+ 皇榜按赛季功名重排 + 往期战绩页 |

顺序：P3-1 → P3-2（互不依赖，但衣冠页入口与皇榜改动都在官途页，串行避免冲突）。

---

## P3-1 · 外观/皮肤系统

### 1.1 产品语义

- **纯装饰**（Prodigy 原则，优化方案 §5.8）：皮肤不改任何数值/判定/出题，只换立绘资产。
- 首批 1 件：**「龙袍 · 金边织」**（rank 10 皇帝形象变体）——解锁条件 = 成就 `EMPEROR`（登极）。
- 解锁类型框架预留三种：`ACHIEVEMENT`（本期实现）/ `EVENT`（限时事件参与，接口位）/ `EXCHANGE`（功名兑换，接口位）——未实现类型在表中不出现，纯逻辑 `unlockable` 只认 ACHIEVEMENT。
- 装备规则：皮肤绑定 rankId，**只有当前官阶 = 绑定 rankId 时可视**（皇帝皮肤登极后永远是当前阶，天然可穿）；服务端校验拥有 + rank 匹配才准装备（防伪造）。

### 1.2 资产

- ComfyUI 远程生图（Z-Image Turbo，`remote-gpu-server-comfyui` 技能）；角色模板逐字复用 rank10 prompt，只加金边变体描述；seed 台账 `docs/design/art-seeds-p3.md`。
- 文件：`public/art/q_skin_rank10_gold.png`（896×1152 竖版，与立绘同规格）。
- VISION 质检：无伪汉字/印章、与 `q_hero_rank10_diwang.png` 并排同底同比例。

### 1.3 纯逻辑层 `src/lib/games/poetry/skins.ts`（零依赖）

```ts
export interface SkinSpec {
  key: string;            // 稳定 key："DRAGON_GOLD"
  label: string;          // 「龙袍 · 金边织」
  desc: string;           // 一句话架空文案
  rankId: number;         // 绑定官阶（10）
  unlock: { type: "ACHIEVEMENT"; achievementKey: string }
        | { type: "EVENT"; eventId: string }        // 接口位，本期无实例
        | { type: "EXCHANGE"; costExp: number };     // 接口位，本期无实例
}
export const SKINS: SkinSpec[];
export const SKIN_BY_KEY: ReadonlyMap<string, SkinSpec>;
/** 本期可解锁路径：结算后按新达成成就评估（纯函数，可单测） */
export function skinsUnlockedByBadges(newBadges: string[], ownedKeys: string[]): string[];
/** 装备合法性（纯函数）：拥有 + rankId 匹配当前官阶 */
export function canEquipSkin(skinKey: string, ownedKeys: string[], currentRankId: number): boolean;
```

- art-assets.ts 增 `SKIN_ASSETS: Record<string, string>`（key → `/art/q_skin_*.png`）与
  `heroAssetFor(rankId, equippedSkinKey)`：rankId 匹配且有皮肤资产 → 皮肤路径，否则回退 `HERO_AVATARS[rankId]`（美术红线：组件只认常量表返回值）。

### 1.4 Schema 与服务端

```prisma
/// 玩家已解锁皮肤（幂等唯一；解锁判定在服务端结算事务，详设 P3 §1）
model PlayerSkin {
  playerId String
  skinKey  String
  earnedAt DateTime @default(now())
  @@unique([playerId, skinKey])
  @@index([playerId])
}
```

- `PlayerRank` 增 `equippedSkin String?`（当前穿戴皮肤 key；null = 默认立绘）。
- **解锁时点**：结算事务内 `evaluateAchievements` 之后，`skinsUnlockedByBadges(newBadges, owned)` → 逐条 `playerSkin.create`（幂等：唯一键冲突吞掉，与成就同风格）。
- **装备接口**：`POST /api/games/poetry/rank/skin`（withCrypto）`{ skinKey: string | null }`；
  服务端 `canEquipSkin` 校验（null = 卸下，恒合法），不过 → `ApiError(403, "无权穿戴此衣冠")`。
- **视图**：`RankView` 增 `skins: { owned: string[]; equipped: string | null }`（buildRankView 内查 PlayerSkin）；文案客户端查 SKINS 表渲染（与成就同模式，服务端只发 key）。
- 防作弊：拥有集/装备位全部服务端权威；客户端传 skinKey 只做「选择」，合法性服务端裁决。

### 1.5 前端

- **衣冠页** `/play/poetry-rank/wardrobe`：皮肤卡列表（立绘 + label + desc + 解锁条件；未解锁 = 剪影 + 条件文案，不剧透资产细节），当前阶可穿的显示「穿戴/卸下」按钮；官途页功名簿入口旁加「衣冠」入口。
- **穿戴渲染**（全部经 `heroAssetFor`）：身份卡、路线图当前节点、结算晋升视图、分享卡画布。其他玩家不可见皮肤（皇榜/虚拟位不动，零社交暴露）。

### 1.6 测试与验收

- 单测 `tests/games/poetry/skins.test.ts`：SKINS 表形状（key 唯一/rankId 合法/首批仅 ACHIEVEMENT 型）；`skinsUnlockedByBadges`（EMPEROR 达成解锁、重复不解锁、无关 badge 不解锁）；`canEquipSkin`（未拥有拒/rank 不匹配拒/合法通过）；art-assets `SKIN_ASSETS` 形状 + `heroAssetFor` 回退逻辑。
- 集成（rank-p2-integration 同风格扩展 `tests/db/rank-p3-integration.test.ts`）：结算达成 EMPEROR → PlayerSkin 落行 + RankView.skins.owned 含 key；装备未拥有 → 403；装备合法 → equippedSkin 落库 + RankView 回显；卸下 → null。
- 浏览器（playwright）：衣冠页渲染（未解锁剪影态）、装备接口闭环（构造已登极档）、身份卡立绘切换、截图 VISION 目视。

---

## P3-2 · 赛季重置与榜单定格

### 2.1 赛季语义（拍板）

- **赛季 = 自然季度**（Asia/Shanghai），键 `YYYY-Qn`（如 `2026-Q3`）——纯函数派生，零运维零开关（与限时事件同纪律）。
- **只重置榜单维度，不清玩家进度**：`totalExp`/`rank`/成就/诗阁/皮肤全部常青；新增 `seasonExp`（本赛季功名增量）为皇榜排序键。功名只增不减红线不破——seasonExp 是独立计数，不是 totalExp 的扣减。
- 皇榜 v2 排序：`seasonExp DESC → rank DESC → name ASC`（赛季初大家 seasonExp=0，rank 仍兜底展示官阶成就）；虚拟位改为按赛季功名口径重设（固定值，纯逻辑表内更新）。
- `SEASON_KEY` 常量（leaderboard-service）退役 → 视图 `season` 字段改为当前赛季键（接口形状不变，前端零改动兼容）。

### 2.2 纯逻辑层 `src/lib/games/poetry/season.ts`（零依赖）

```ts
/** dateKey（YYYY-MM-DD，Asia/Shanghai 口径）→ 赛季键 "YYYY-Qn" */
export function seasonKeyForDate(dateKey: string): string;
/** 赛季键 → 展示文案（「丙午年 · 第三季」风格架空纪年？——拍板：朴素「2026 年第三季度」，不造历法宣称） */
export function seasonLabel(seasonKey: string): string;
/** 赛季键比较（字典序即时间序：YYYY-Qn 定宽） */
export function isSeasonBefore(a: string, b: string): boolean;
```

### 2.3 Schema

```prisma
model PlayerRank {
  // ...既有字段不动
  /// 当前赛季键（YYYY-Qn；结算/视图惰性迁移，详设 P3 §2）
  seasonKey String @default("v1")
  /// 本赛季功名增量（皇榜排序键；跨赛季定格后清零，totalExp 常青不动）
  seasonExp Int @default(0)
}

/// 赛季定格快照（惰性写入，幂等唯一）
model SeasonBoard {
  seasonKey String
  playerId  String
  rank      Int
  seasonExp Int
  frozenAt  DateTime @default(now())
  @@unique([seasonKey, playerId])
  @@index([seasonKey, seasonExp])
}
```

### 2.4 定格与迁移（零 cron，惰性双路径，全部幂等）

1. **结算事务内**（settleRankedSession，功名入账处）：读 `playerRank.seasonKey`，若 ≠ `seasonKeyForDate(localDate())` → 同事务先写 `SeasonBoard.upsert`（旧 seasonKey, rank, 旧 seasonExp）再把 `seasonKey` 更新为当前、`seasonExp` 置 0，然后 `seasonExp += expGained`。
2. **皇榜视图内**（getLeaderboardView，事务）：对取回的 realRows 中 `seasonKey ≠ 当前` 的行批量补定格（upsert）+ 重置——覆盖「跨赛季后不再结算但打开皇榜」的惰性路径；不活跃且从不打开皇榜的玩家不进快照（可接受：快照语义 = 定格时可见的活跃档；SeasonBoard 只增不改，历史可溯）。
3. 定格行 `seasonExp = 0` 的也写（参与过赛季即留痕）；upsert 幂等，两路径并发撞唯一键吞冲突。

### 2.5 皇榜服务与前端

- `getLeaderboardView`：当前榜 = `seasonKey == 当前` 的行按 §2.1 排序；`my` 追赶卡改用 seasonExp 口径；视图增 `seasonLabel`（前端头部显示「2026 年第三季度榜」）与 `past: SeasonSnapshotView[] | null`（我的往期定格：seasonKey/rank/seasonExp，最多 8 条，倒序）。
- 皇榜页：头部赛季标签 + 功名列改「本季功名」+ 底部「我的往期战绩」折叠区（无快照不渲染）。
- 虚拟位（VIRTUAL_ENTRIES）字段增 `seasonExp`（固定值，与新排序自洽：如李白 38000/苏轼 52000…量级压在真实玩家赛季可达区间）；冷启动语义不变。

### 2.6 测试与验收

- 单测 `tests/games/poetry/season.test.ts`：季度边界（1/1、3/31、4/1、12/31）；键格式定宽；isSeasonBefore 跨年；seasonLabel。
- 集成（扩展 rank-p3-integration）：结算跨赛季 → SeasonBoard 落行 + seasonExp 清零重计 + totalExp 不变（常青断言）；皇榜惰性迁移（构造旧 seasonKey 行 → 打开视图 → 定格）；当前榜排序 seasonExp 优先；重复定格幂等。
- 浏览器：皇榜页赛季标签 + 本季功名列 + 往期区渲染；playwright 闭环。

---

## 验收纪律（每期）

纯逻辑层单测 + 集成 + `tsc --noEmit` + eslint 改动文件 + `npm run build` + playwright 浏览器验收 + VISION 布局检查，全过后一期一个 commit，首行引用本方案期号（P3-1 / P3-2）。

## 明确不做（P3 边界）

- 皮肤不做的：多件资产批量上新（首批 1 件跑通框架，后续资产 = 生图 + 表行）、EVENT/EXCHANGE 解锁实例、他人可见皮肤（社交暴露零）；
- 赛季不做的：赛季专属徽章/皮肤联动奖励（框架留了 EVENT 解锁接口位）、全量历史玩家强制迁移（惰性双路径已覆盖活跃面）、赛季预告/结算推送；
- 付费/账号体系边界不变。
