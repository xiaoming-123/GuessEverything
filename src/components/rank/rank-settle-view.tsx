"use client";
import { useState } from "react";
import { heroAssetFor } from "@/lib/art-assets";
import { ACHIEVEMENT_BY_KEY } from "@/lib/games/poetry/achievements";
import type { RankSummary } from "@/lib/db/rank-service";
import { ArtAvatar } from "./art-avatar";
import { Modal, PagedText } from "@/components/game-ui";

export function RankSettleView({
  summary,
  onBack,
  onRetry,
}: {
  summary: RankSummary;
  onBack: () => void;
  onRetry?: () => void;
}) {
  const [details, setDetails] = useState(false);
  const promoted = summary.promotion.promoted;
  const title = promoted
    ? `擢升 · ${summary.rank.label}`
    : summary.kind === "EXAM"
      ? "此番未中，来日再试"
      : summary.kind === "DAILY"
        ? "今日一诗，已入行囊"
        : "笔下有所得，前路进一步";
  const badges = summary.newBadges
    .map((key) => ACHIEVEMENT_BY_KEY.get(key))
    .filter(Boolean);
  return (
    <section className="settle-screen">
      <div className="settle-art">
        <span className="eyebrow">
          {promoted ? "命运新章" : "这一卷 · 已落笔"}
        </span>
        <ArtAvatar
          src={heroAssetFor(
            summary.rank.rankId,
            summary.rank.skins?.equipped ?? null,
          )}
          alt={summary.rank.label}
          containerClassName="settle-hero"
        />
        <h1>{title}</h1>
        <p>
          {promoted
            ? "重来一世，终于走到新的天地。"
            : "所获功名已记下，每一步都算数。"}
        </p>
      </div>
      <div className="settle-stats">
        <div>
          <span>正确率</span>
          <strong>
            {summary.accuracy}
            <small>%</small>
          </strong>
        </div>
        <div>
          <span>本局功名</span>
          <strong>+{summary.expGained}</strong>
        </div>
        <div>
          <span>累计功名</span>
          <strong>{summary.totalExp}</strong>
        </div>
      </div>
      <button
        className="quiet-button settle-details"
        onClick={() => setDetails(true)}
      >
        {badges.length ? `新获 ${badges.length} 枚成就 · ` : ""}查看本局详情 〉
      </button>
      <div className="settle-actions">
        {onRetry && (
          <button className="button gold" onClick={onRetry}>
            再赴科考
          </button>
        )}
        <button
          className={`button ${onRetry ? "secondary" : "primary"}`}
          onClick={onBack}
        >
          返回官途
        </button>
      </div>
      {details && (
        <Modal title="这一卷的收获" onClose={() => setDetails(false)}>
          <PagedText
            text={[
              summary.settleLine,
              `答对 ${summary.correctCount} / ${summary.totalRounds} 题`,
              summary.hintUsed ? "本局已问同窗，功名按规则折算。" : "",
              summary.event
                ? `${summary.event.name} · ${summary.kind === "EXAM" ? "科考不享功名加成" : `功名倍率 ×${summary.event.expMultiplier}`}`
                : "",
              ...badges.map((a) => `${a!.label}：${a!.desc}`),
              "功名保留，继续书写下一章。",
            ]
              .filter(Boolean)
              .join("\n\n")}
          />
        </Modal>
      )}
    </section>
  );
}
