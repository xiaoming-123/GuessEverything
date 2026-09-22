"use client";
import { heroAssetFor } from "@/lib/art-assets";
import { ArtAvatar } from "./art-avatar";
import type { RankView } from "@/lib/db/rank-service";

export function RankIdentityCard({ rank }: { rank: RankView }) {
  const required = rank.totalExp + rank.expToNext;
  const progress =
    rank.nextUnlocked || rank.rankId === 10
      ? 100
      : required
        ? Math.min(100, (rank.totalExp / required) * 100)
        : 0;
  return (
    <section className="identity-scene" aria-label="当前身份">
      <div className="identity-copy">
        <span className="eyebrow">这一世 · 我的官途</span>
        <h1>{rank.label}</h1>
        <p>{rank.subtitle}</p>
        <div className="identity-exp">
          <strong>{rank.totalExp.toLocaleString()}</strong>
          <span>功名</span>
        </div>
      </div>
      <div className="hero-halo" aria-hidden="true" />
      <ArtAvatar
        src={heroAssetFor(rank.rankId, rank.skins?.equipped ?? null)}
        alt={`${rank.label}形象`}
        containerClassName="identity-hero"
      />
      <div className="identity-progress">
        <div
          className="progress-track"
          role="progressbar"
          aria-label="晋升功名进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
        >
          <span style={{ width: `${progress}%` }} />
        </div>
        <p>
          {rank.rankId === 10
            ? "这一世，已写下新的传奇"
            : rank.nextUnlocked
              ? "功名已足，可以赴考"
              : `再积 ${rank.expToNext.toLocaleString()} 功名，即可赴考`}
        </p>
      </div>
    </section>
  );
}
