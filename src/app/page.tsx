"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BRAND } from "@/lib/brand";
import { HERO_AVATARS } from "@/lib/art-assets";
import { localPlayerId } from "@/store/player-store";
import { ArtAvatar } from "@/components/rank/art-avatar";
import { Modal, PagedText } from "@/components/game-ui";

export default function Home() {
  const [returning, setReturning] = useState(false);
  const [about, setAbout] = useState(false);
  useEffect(() => setReturning(!!localPlayerId()), []);
  return (
    <main className="game-shell home-shell">
      <header className="home-header">
        <span className="wordmark">
          诗词逆命 <i>·</i> 一卷新生
        </span>
        <button className="quiet-button" onClick={() => setAbout(true)}>
          游玩须知
        </button>
      </header>
      <section className="home-stage">
        <div className="home-title">
          <span className="rebirth-stamp">重 生</span>
          <p className="eyebrow">以诗为阶 · 以词为路</p>
          <h1 aria-label={BRAND.name}>
            我靠诗词
            <br />
            <em>问鼎天下</em>
          </h1>
          <p className="home-tagline">{BRAND.tagline}</p>
        </div>
        <div className="landscape" aria-hidden="true">
          <span className="sun-disc" />
          <span className="mountain mountain-back" />
          <span className="mountain mountain-front" />
          <span className="journey-line" />
        </div>
        <ArtAvatar
          src={HERO_AVATARS[0]}
          alt="从一介布衣开始这一世"
          containerClassName="home-hero"
        />
        <span className="vertical-verse" aria-hidden="true">
          一卷诗书
          <br />
          重写平生
        </span>
        <span className="chapter-label">
          序章 <span>一介布衣，万般可能</span>
        </span>
      </section>
      <footer className="home-footer">
        <p>答诗词，积功名，从布衣一步步登高。</p>
        <Link className="button gold enter-button" href="/play/poetry-rank">
          {returning ? "续写这一世" : "开启这一世"}
          <span aria-hidden="true"> →</span>
        </Link>
        <span className="fine-print">研习十题 · 随时续写 · 架空成长</span>
      </footer>
      {about && (
        <Modal title="游玩须知" onClose={() => setAbout(false)}>
          <PagedText
            text={`重活一世，以诗词改命。\n\n研习答诗词、积功名，达到门槛后参加科考，一步步走向更大的天地。每日题每天一题，答过的诗会收进诗词阁。\n\n这是架空成长故事，不代表真实官制。功名保留，科考未中可以再试。\n\n游戏使用本机保存的匿名身份记录进度。清除浏览器数据或更换设备可能无法找回原进度，请保留当前浏览器数据。\n\n游戏需要联网。进行中的对局可在有效期内恢复；每题有作答时限。`}
          />
        </Modal>
      )}
    </main>
  );
}
