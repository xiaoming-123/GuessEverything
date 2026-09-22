"use client";
import { useState } from "react";
import type { RankView } from "@/lib/db/rank-service";
import { SKINS } from "@/lib/games/poetry/skins";
import { ACHIEVEMENT_BY_KEY } from "@/lib/games/poetry/achievements";
import { SKIN_ASSETS } from "@/lib/art-assets";
import { secureFetch } from "@/lib/crypto/secure-fetch";
import { requirePlayerId } from "@/lib/client-player";
import { ArtAvatar } from "@/components/rank/art-avatar";
import { GameShell, Pager, StatusView } from "@/components/game-ui";
import { useGameResource } from "@/components/use-game-resource";
export default function WardrobePage() {
  const {
    data: rank,
    error,
    loading,
    reload,
  } = useGameResource<RankView>("/api/games/poetry/rank");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const skin = SKINS[page];
  const owned = !!rank?.skins.owned.includes(skin.key);
  const equipped = rank?.skins.equipped === skin.key;
  const setSkin = async () => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await secureFetch("/api/games/poetry/rank/skin", {
        playerId: await requirePlayerId(),
        skinKey: equipped ? null : skin.key,
      });
      reload();
      setMessage(equipped ? "已换回常服" : "新衣已穿戴");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "操作失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <GameShell title="衣冠">
      {loading || error || !rank ? (
        <StatusView error={error} loading="正在打开衣匣…" onRetry={reload} />
      ) : rank.rankId < 9 ? (
        <StatusView loading="衣匣尚未开启，先去续写你的官途。" />
      ) : (
        <>
          <div className="book-heading">
            <p className="eyebrow">一身新衣，一段新程</p>
            <h1>{owned ? skin.label : "未启的衣匣"}</h1>
            <p>
              {owned
                ? skin.desc
                : skin.unlock.type === "ACHIEVEMENT"
                  ? `达成「${ACHIEVEMENT_BY_KEY.get(skin.unlock.achievementKey)?.label ?? "对应成就"}」后解锁`
                  : "等待机缘开启"}
            </p>
          </div>
          <div className="wardrobe-stage">
            {owned ? (
              <ArtAvatar
                src={SKIN_ASSETS[skin.key]}
                alt={skin.label}
                containerClassName="wardrobe-hero"
              />
            ) : (
              <span className="locked-wardrobe" aria-label="尚未解锁">
                衣
              </span>
            )}
          </div>
          <p className="fine-print">衣冠仅为妆点，不改变功名与课业。</p>
          {message && (
            <p role="status" className="muted">
              {message}
            </p>
          )}
          <button
            className="button gold"
            disabled={!owned || skin.rankId !== rank.rankId || busy}
            onClick={() => void setSkin()}
          >
            {busy
              ? "正在更衣…"
              : !owned
                ? "尚未解锁"
                : skin.rankId !== rank.rankId
                  ? "当前身份暂不可穿戴"
                  : equipped
                    ? "换回常服"
                    : "穿戴新衣"}
          </button>
          {SKINS.length > 1 && (
            <Pager page={page} count={SKINS.length} onChange={setPage} />
          )}
        </>
      )}
    </GameShell>
  );
}
