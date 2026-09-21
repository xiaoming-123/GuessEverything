"use client";

/**
 * 衣冠页（P3-1 详设 §1.5）
 *
 * 皮肤卡列表：立绘 + label + desc + 解锁条件。
 * - 已解锁 + 当前官阶匹配绑定 rankId → 「穿戴 / 卸下」按钮（POST /api/games/poetry/rank/skin，
 *   withCrypto 加密通道，合法性服务端裁决）；
 * - 已解锁但官阶不匹配 → 「官至 XX 方可穿戴」（不剧透资产细节以外信息，label 已拥有即展示）；
 * - 未解锁 → 剪影态（灰底 + ？？？ + 解锁条件文案，不露立绘）。
 * 皮肤纯装饰（Prodigy 原则）：不改任何数值；架空文案不宣称真实官制。
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { RankView } from "@/lib/db/rank-service";
import { SKINS } from "@/lib/games/poetry/skins";
import { ACHIEVEMENT_BY_KEY } from "@/lib/games/poetry/achievements";
import { RANKS } from "@/lib/games/poetry/rank";
import { SKIN_ASSETS, HERO_AVATARS } from "@/lib/art-assets";
import { secureFetch } from "@/lib/crypto/secure-fetch";
import { localPlayerId, usePlayerStore } from "@/store/player-store";

/** 解锁条件文案（ACHIEVEMENT 型查成就表；其余型接口位暂无实例） */
function unlockText(skin: (typeof SKINS)[number]): string {
  if (skin.unlock.type === "ACHIEVEMENT") {
    const ach = ACHIEVEMENT_BY_KEY.get(skin.unlock.achievementKey);
    return `达成成就「${ach?.label ?? skin.unlock.achievementKey}」解锁`;
  }
  if (skin.unlock.type === "EVENT") return "限时事件可得（敬请期待）";
  return "功名兑换可得（敬请期待）";
}

export default function WardrobePage() {
  const [rank, setRank] = useState<RankView | null>(null);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    let pid = usePlayerStore.getState().playerId ?? localPlayerId();
    if (!pid) {
      await usePlayerStore.getState().ensurePlayer();
      pid = usePlayerStore.getState().playerId;
    }
    if (!pid) {
      setError("玩家初始化失败，请刷新重试");
      return;
    }
    try {
      const res = await fetch(`/api/games/poetry/rank?playerId=${encodeURIComponent(pid)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? "衣冠加载失败");
      }
      setRank((await res.json()) as RankView);
    } catch (err) {
      setError(err instanceof Error ? err.message : "衣冠加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 穿戴/卸下（服务端裁决，403 文案直接展示） */
  const doSetSkin = async (skinKey: string | null) => {
    if (busyKey !== null) return;
    const pid = usePlayerStore.getState().playerId ?? localPlayerId();
    if (!pid) return;
    setBusyKey(skinKey ?? "__off__");
    setMsg("");
    try {
      await secureFetch<unknown>("/api/games/poetry/rank/skin", { playerId: pid, skinKey });
      await load();
      setMsg(skinKey ? "已穿戴" : "已卸下，换回常服");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyKey(null);
    }
  };

  const owned = rank?.skins?.owned ?? [];
  const equipped = rank?.skins?.equipped ?? null;
  const currentRankId = rank?.rankId ?? 0;

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/play/poetry-rank" className="text-sm text-zinc-500 hover:text-zinc-800">
          ← 官途
        </Link>
        <div className="text-sm font-bold text-indigo-600">👘 衣冠</div>
        <span className="w-10" />
      </div>

      {error && <p className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-500">{error}</p>}
      {msg && <p className="mb-4 rounded-xl bg-indigo-50 p-3 text-sm text-indigo-600">{msg}</p>}

      <p className="mb-4 text-xs text-zinc-400">
        衣冠纯为妆点，不改功名课业（架空服饰，非真实官制）。
      </p>

      <section className="grid gap-4">
        {SKINS.map((skin) => {
          const isOwned = owned.includes(skin.key);
          const isEquipped = equipped === skin.key;
          // 绑定官阶匹配才可穿（与 canEquipSkin 同口径，服务端仍会再裁决）
          const rankMatched = skin.rankId === currentRankId;
          const asset = SKIN_ASSETS[skin.key];
          const busy = busyKey === skin.key || busyKey === "__off__";
          return (
            <div
              key={skin.key}
              className={`rounded-2xl border p-4 ${
                isOwned
                  ? isEquipped
                    ? "border-amber-300 bg-amber-50"
                    : "border-indigo-200 bg-white"
                  : "border-zinc-200 bg-zinc-50"
              }`}
            >
              <div className="flex items-center gap-4">
                {isOwned ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={asset}
                    alt={skin.label}
                    className="h-24 w-20 shrink-0 rounded-xl border border-indigo-100 bg-indigo-50 object-contain"
                  />
                ) : (
                  // 未解锁：剪影态（默认立绘灰化 + ？？？遮罩，不露皮肤资产）
                  <span className="relative flex h-24 w-20 shrink-0 items-center justify-center rounded-xl border border-zinc-200 bg-zinc-200">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={HERO_AVATARS[skin.rankId] ?? HERO_AVATARS[0]}
                      alt=""
                      className="h-full w-full rounded-xl object-contain opacity-30 grayscale"
                    />
                    <span className="absolute text-2xl text-zinc-500">？</span>
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-base font-bold text-indigo-700">
                    {isOwned ? skin.label : "？？？"}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {isOwned ? skin.desc : unlockText(skin)}
                  </p>
                  {isOwned && !rankMatched && (
                    <p className="mt-1 text-xs text-zinc-400">
                      官至「{RANKS[skin.rankId]?.label ?? "？"}」方可穿戴
                    </p>
                  )}
                  {isOwned && rankMatched && (
                    isEquipped ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void doSetSkin(null)}
                        className="mt-2 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-50 disabled:opacity-50"
                      >
                        {busy ? "…" : "卸下"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void doSetSkin(skin.key)}
                        className="mt-2 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
                      >
                        {busy ? "…" : "穿戴"}
                      </button>
                    )
                  )}
                  {isEquipped && (
                    <span className="ml-2 text-xs font-medium text-amber-600">穿戴中</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </section>
    </main>
  );
}
