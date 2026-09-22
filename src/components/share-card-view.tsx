"use client";
/* eslint-disable @next/next/no-img-element -- Canvas data URL 预览需支持手机长按保存。 */
import { useEffect, useRef, useState } from "react";
import { heroAssetFor } from "@/lib/art-assets";
import { buildShareCardLines } from "@/lib/share-card";
import type { RankSummary } from "@/lib/db/rank-service";
import { Modal, StatusView } from "@/components/game-ui";

export function ShareCardView({
  summary,
  badgeLabels,
}: {
  summary: RankSummary;
  badgeLabels: string[];
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const badges = badgeLabels.join("\n");
  const heroSrc = heroAssetFor(
    summary.rank.rankId,
    summary.rank.skins?.equipped ?? null,
  );
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setUrl("");
    setError("");
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      try {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx)
          throw new Error("当前设备暂不支持分享图，请稍后重试。");
        const width = 750,
          height = 1200;
        const lines = buildShareCardLines({
          rankLabel: summary.rank.label,
          accuracy: summary.accuracy,
          expGained: summary.expGained,
          totalExp: summary.totalExp,
          newBadges: badges ? badges.split("\n") : [],
          dateKey: new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Asia/Shanghai",
          }).format(new Date()),
        });
        ctx.fillStyle = "#f5f0e5";
        ctx.fillRect(0, 0, width, height);
        ctx.strokeStyle = "#b39662";
        ctx.lineWidth = 2;
        ctx.strokeRect(28, 28, width - 56, height - 56);
        ctx.textAlign = "center";
        ctx.fillStyle = "#a46842";
        ctx.font = "24px serif";
        ctx.fillText("重 生 · 以诗为阶", width / 2, 96);
        ctx.fillStyle = "#30394e";
        ctx.font = "bold 46px serif";
        ctx.fillText("我靠诗词", width / 2, 162);
        ctx.fillText("问鼎天下", width / 2, 224);
        const scale = Math.min(380 / image.width, 420 / image.height);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(185, 670);
        ctx.lineTo(185, 440);
        ctx.arc(375, 440, 190, Math.PI, 0);
        ctx.lineTo(565, 670);
        ctx.closePath();
        ctx.fillStyle = "#25394e";
        ctx.fill();
        ctx.clip();
        ctx.drawImage(
          image,
          (width - image.width * scale) / 2,
          250,
          image.width * scale,
          image.height * scale,
        );
        ctx.restore();
        ctx.fillStyle = "#9b773e";
        ctx.font = "bold 62px serif";
        ctx.fillText(summary.rank.label, width / 2, 750);
        let y = 818;
        for (const line of lines.lines) {
          let size = 30;
          ctx.font = `${size}px sans-serif`;
          while (ctx.measureText(line).width > 630 && size > 18)
            ctx.font = `${--size}px sans-serif`;
          ctx.fillStyle = "#616359";
          ctx.fillText(line, width / 2, y);
          y += 48;
        }
        ctx.font = "22px sans-serif";
        ctx.fillStyle = "#827c70";
        ctx.fillText(lines.footer, width / 2, 1132);
        setUrl(canvas.toDataURL("image/png"));
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "分享图生成失败，请重试。",
        );
      }
    };
    image.onerror = () => {
      if (!cancelled) setError("人物图片未能载入，请重试。");
    };
    image.src = heroSrc;
    return () => {
      cancelled = true;
    };
  }, [
    open,
    attempt,
    heroSrc,
    summary.rank.label,
    summary.accuracy,
    summary.expGained,
    summary.totalExp,
    badges,
  ]);
  return (
    <>
      <button className="share-entry" onClick={() => setOpen(true)}>
        ↗ 分享这一世
      </button>
      {open && (
        <Modal title="把这一卷，留作纪念" onClose={() => setOpen(false)}>
          {!url ? (
            <StatusView
              error={error}
              loading="正在落款成画…"
              onRetry={() => setAttempt((x) => x + 1)}
            />
          ) : (
            <>
              <img className="share-preview" src={url} alt="本局成长分享图" />
              <a
                className="button gold"
                href={url}
                download={`诗词逆命-${summary.rank.label}.png`}
              >
                保存分享图
              </a>
              <p className="fine-print">也可长按图片保存，再分享给好友。</p>
            </>
          )}
          <canvas hidden ref={canvasRef} width={750} height={1200} />
        </Modal>
      )}
    </>
  );
}
