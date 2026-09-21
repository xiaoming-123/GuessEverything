"use client";

/**
 * 分享卡视图（P2 详设 §3）：结算后 canvas 长图（750×1200），纯客户端零接口。
 *
 * - 文案拼装走纯函数 buildShareCardLines（可单测）；
 * - 立绘走 art-assets 常量表（同源 /art，canvas 不污染）；
 * - 红线：卡面不含题目 / 答案 / sourceKey（数据源仅 RankSummary 脱敏字段）。
 * - 立绘未就绪时按钮置灰重试，不静默。
 */

import { useEffect, useRef, useState } from "react";
import { HERO_AVATARS } from "@/lib/art-assets";
import { buildShareCardLines } from "@/lib/share-card";
import type { RankSummary } from "@/lib/db/rank-service";

interface ShareCardViewProps {
  summary: RankSummary;
  /** 新达成成就 label（服务端 newBadges 查表后文案） */
  badgeLabels: string[];
}

const W = 750;
const H = 1200;

/** Asia/Shanghai 日期串（与 D2 月历同口径） */
function todayKey(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function ShareCardView({ summary, badgeLabels }: ShareCardViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  const lines = buildShareCardLines({
    rankLabel: summary.rank.label,
    accuracy: summary.accuracy,
    expGained: summary.expGained,
    totalExp: summary.totalExp,
    newBadges: badgeLabels,
    dateKey: todayKey(),
  });
  const heroSrc = HERO_AVATARS[summary.rankId] ?? HERO_AVATARS[0];

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setReady(false);
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // 背景：靛蓝渐变
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#1e1b4b");
      bg.addColorStop(1, "#312e81");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // 琥珀金描边框
      ctx.strokeStyle = "rgba(251,191,36,0.85)";
      ctx.lineWidth = 6;
      roundRect(ctx, 24, 24, W - 48, H - 48, 28);
      ctx.stroke();
      ctx.strokeStyle = "rgba(251,191,36,0.35)";
      ctx.lineWidth = 2;
      roundRect(ctx, 40, 40, W - 80, H - 80, 20);
      ctx.stroke();

      // 标题
      ctx.fillStyle = "#fbbf24";
      ctx.font = "bold 54px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(lines.title, W / 2, 150);

      // 立绘（圆角方形底 + 居中）
      const hx = W / 2 - 180;
      const hy = 220;
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      roundRect(ctx, hx, hy, 360, 420, 24);
      ctx.fill();
      const scale = Math.min(360 / img.width, 420 / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, W / 2 - dw / 2, hy + (420 - dh) / 2, dw, dh);

      // 官衔大标题
      ctx.fillStyle = "#fde68a";
      ctx.font = "bold 84px sans-serif";
      ctx.fillText(summary.rank.label, W / 2, 760);

      // 数据行（最坏 5 行：称号/正确率功名/累计/成就/日期；行距 56 保证与 footer 不重叠）
      ctx.font = "40px sans-serif";
      ctx.fillStyle = "#e0e7ff";
      let ly = 830;
      for (const l of lines.lines) {
        ctx.fillText(l, W / 2, ly);
        ly += 56;
      }

      // 架空声明（footer，与最后一行数据保持 ≥60px 间距）
      ctx.fillStyle = "rgba(224,231,255,0.55)";
      ctx.font = "28px sans-serif";
      ctx.fillText(lines.footer, W / 2, H - 80);

      if (!cancelled) {
        setDataUrl(canvas.toDataURL("image/png"));
        setReady(true);
      }
    };
    img.onerror = () => {
      if (!cancelled) setReady(false);
    };
    img.src = heroSrc;
    return () => {
      cancelled = true;
    };
  }, [heroSrc, summary.rank.label, summary.rankId, summary.accuracy, summary.expGained, summary.totalExp, lines]);

  const download = () => {
    const a = document.createElement("a");
    a.href = dataUrl ?? canvasRef.current?.toDataURL("image/png") ?? "";
    a.download = `mihe-share-${summary.rank.label}.png`;
    a.click();
  };

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={download}
        disabled={!ready}
        className={
          ready
            ? "w-full rounded-2xl bg-amber-500 py-3 text-base font-bold text-white shadow active:scale-[0.99]"
            : "w-full rounded-2xl border border-zinc-200 bg-zinc-50 py-3 text-sm text-zinc-400"
        }
      >
        📸 {ready ? "生成分享图" : "分享图生成中…"}
      </button>
      {/* canvas 生成的 data URL：next/image 对超大 dataURL 有内存开销，用原生 img 渲染 */}
      {dataUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={dataUrl}
          alt="分享卡预览"
          className="mt-3 w-full rounded-xl border border-zinc-200"
        />
      )}
      <canvas ref={canvasRef} width={W} height={H} className="hidden" />
    </div>
  );
}
