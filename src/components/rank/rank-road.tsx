"use client";

/**
 * 官途路线图 + 功名条（D1 重写，详设 §1.4）
 *
 * 迷雾规则（纯客户端逻辑，输入 = rank.ranks[] + rank.rankId）：
 * | 状态   | 条件                 | 渲染                                        |
 * | 已升   | r.id < rankId        | 顶部一行小圆点（「已过 N 阶」）               |
 * | 当前   | r.id === rankId      | 高亮脉冲 + 大节点                            |
 * | 下一阶 | r.id === rankId + 1  | 半剪影（brightness 0.4）+ 称号可见、副标题 —— |
 * | 迷雾   | r.id > rankId + 1    | 黑色剪影 + ？？？（称号/副标题全隐）          |
 * | 皇帝   | isEmperor 且 rankId<9| 节点整体不渲染（路线图以丞相为可见终点）；    |
 * |        | rankId >= 9 时按皇帝节点渲染（👑 + 登极大考） |
 *
 * 架空称号路线，文案不宣称为真实官制；功名权威值来自服务端 RankView。
 */

import { HERO_AVATARS } from "@/lib/art-assets";
import type { RankProgressView, RankView } from "@/lib/db/rank-service";

export function RankRoad({ rank }: { rank: RankView }) {
  const { ranks, rankId } = rank;

  // 功名进度 = 已得 / 所需；所需功名 = totalExp + expToNext（未解锁时）
  const required = rank.totalExp + rank.expToNext;
  const pct = rank.nextUnlocked
    ? 1
    : required > 0
      ? Math.max(0, Math.min(1, rank.totalExp / required))
      : 0;
  const isEmperorNow = ranks[rankId]?.isEmperor ?? false;

  // 已过官阶：收成顶部一行小圆点
  const passed = ranks.filter((r) => r.rankId < rankId);
  // 皇帝节点在 rankId < 9 时整体隐藏（不渲染）
  const visibleAll = ranks.filter(
    (r) => r.rankId >= rankId && !(r.isEmperor && rankId < 9),
  );
  // 迷雾节点截断（详设 §1.4：窄屏 ≤5 行 = 当前 1 + 下一阶 1 + 迷雾 3）
  const currentNode = visibleAll.find((r) => r.rankId === rankId);
  const nextNode = visibleAll.find((r) => r.rankId === rankId + 1);
  const fogNodes = visibleAll.filter((r) => r.rankId > rankId + 1);
  const fogShown = fogNodes.slice(0, 3);
  const fogHiddenCount = fogNodes.length - fogShown.length;

  return (
    <div>
      {/* 功名进度条（称号/副标题/功名已在上方面板身份卡展示，此处只保留进度） */}
      <div className="mb-4 rounded-2xl border border-indigo-200 bg-indigo-50 p-3">
        {isEmperorNow ? (
          <p className="text-sm text-amber-600">👑 位极人臣，已登天子（架空称号终点）</p>
        ) : rank.nextUnlocked ? (
          <p className="text-sm font-medium text-emerald-600">✓ 功名达标，可赴下一场科考</p>
        ) : (
          <>
            <div className="h-1.5 overflow-hidden rounded-full bg-indigo-100">
              <div
                className="h-full rounded-full bg-indigo-500 transition-[width]"
                style={{ width: `${pct * 100}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-indigo-400 tabular-nums">
              距下一场科考还差 {rank.expToNext} 功名
            </p>
          </>
        )}
      </div>

      {/* 已过官阶：顶部一行小圆点 */}
      {passed.length > 0 && (
        <div className="mb-3 flex items-center gap-2">
          <div className="flex flex-wrap gap-1.5">
            {passed.map((r) => (
              <span
                key={r.key}
                title={`${r.label} ✓`}
                className="flex h-6 w-6 items-center justify-center rounded-full border border-indigo-200 bg-indigo-100 text-xs"
              >
                {HERO_AVATARS[r.rankId]}
              </span>
            ))}
          </div>
          <span className="text-xs text-zinc-400">已过 {passed.length} 阶</span>
        </div>
      )}

      {/* 官途路线：当前 + 下一阶 + 迷雾（截断）+ 折叠行 */}
      <ol className="relative space-y-1 pl-4">
        <span className="absolute top-2 bottom-2 left-[11px] w-px bg-zinc-200" />
        {currentNode && (
          <RoadNode r={currentNode} current next={false} fog={false} playerRankId={rankId} />
        )}
        {nextNode && (
          <RoadNode r={nextNode} current={false} next fog={false} playerRankId={rankId} />
        )}
        {fogShown.map((r) => (
          <RoadNode
            key={r.key}
            r={r}
            current={false}
            next={false}
            fog
            playerRankId={rankId}
          />
        ))}
        {fogHiddenCount > 0 && (
          <li className="relative py-1">
            <span className="absolute -left-4 flex h-4 w-4 items-center justify-center rounded-full border border-dashed border-zinc-300 text-[9px] text-zinc-400">
              …
            </span>
            <span className="text-xs text-zinc-400">还有 {fogHiddenCount} 阶迷雾待揭</span>
          </li>
        )}
      </ol>
    </div>
  );
}

/** 路线图单节点（已升/当前/下一阶/迷雾/皇帝 五态） */
function RoadNode({
  r,
  current,
  next,
  fog,
  playerRankId,
}: {
  r: RankProgressView;
  current: boolean;
  next: boolean;
  fog: boolean;
  playerRankId: number;
}) {
  const isEmperorVisible = r.isEmperor && playerRankId >= 9;

  // 节点圆点
  const dotCls = current
    ? "h-6 w-6 border-2 border-indigo-500 bg-indigo-500 animate-rank-node-pulse"
    : fog
      ? "h-5 w-5 border border-zinc-400 bg-zinc-800"
      : "h-5 w-5 border-2 border-amber-300 bg-amber-100";

  return (
    <li className="relative flex items-center gap-3 py-1.5">
      <span
        className={`absolute -left-4 flex items-center justify-center rounded-full ${dotCls}`}
      >
        {isEmperorVisible ? "👑" : fog ? "？" : next ? HERO_AVATARS[r.rankId] : ""}
      </span>
      {current ? (
        // 当前阶：大节点 + 立绘 + 高亮
        <div className="flex flex-1 items-center gap-3 rounded-xl border border-indigo-300 bg-indigo-50/70 px-3 py-2">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-2xl">
            {HERO_AVATARS[r.rankId]}
          </span>
          <span>
            <span className="block text-base font-bold text-indigo-700">{r.label}</span>
            <span className="block text-xs text-indigo-400">{r.subtitle}</span>
          </span>
        </div>
      ) : next ? (
        // 下一阶：半剪影（称号可见、副标题 ——）
        <div className="flex flex-1 items-center gap-3 px-1">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-100 text-xl fog-half">
            {HERO_AVATARS[r.rankId]}
          </span>
          <span>
            <span className="block text-sm font-semibold text-zinc-600">{r.label}</span>
            <span className="block text-xs text-zinc-400">——</span>
          </span>
        </div>
      ) : (
        // 迷雾 / 皇帝终点：黑剪影 + ？？？（称号/副标题全隐；拜相前皇帝信息绝不露出）
        <div className="flex flex-1 items-center gap-3 px-1">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800 text-xl fog-full">
            {isEmperorVisible ? "👑" : "？"}
          </span>
          <span>
            <span className="block text-sm font-semibold text-zinc-400">
              {isEmperorVisible ? "皇帝" : "？？？"}
            </span>
            <span className="block text-xs text-zinc-400">
              {isEmperorVisible ? "登极大考" : "？？？"}
            </span>
          </span>
        </div>
      )}
    </li>
  );
}
