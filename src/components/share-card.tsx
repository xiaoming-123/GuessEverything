"use client";

/**
 * 战绩分享卡片 · 纯前端 Canvas 绘制 PNG
 *
 * 750×1000 竖版卡片：渐变底 + 玩家信息 + 对局数据 + 星级 + 日期水印。
 * 支持下载 PNG / Web Share API（移动端）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface ShareCardData {
  nickname: string;
  avatar: string;
  modeLabel: string;
  stageLabel: string;
  score: number;
  accuracy: number;
  combo: number;
  stars: number;
  /** ISO 日期 */
  date: string;
}

const W = 750;
const H = 1000;

function drawStars(ctx: CanvasRenderingContext2D, stars: number, cx: number, y: number, size: number) {
  const gap = size * 2.2;
  const startX = cx - ((3 - 1) * gap) / 2;
  for (let i = 0; i < 3; i++) {
    const x = startX + i * gap;
    ctx.font = `${size}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(i < stars ? "⭐" : "☆", x, y);
  }
}

function drawCard(data: ShareCardData): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const cx = W / 2;

  // 背景：暖色渐变
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#fffbeb");
  bg.addColorStop(0.55, "#fef3c7");
  bg.addColorStop(1, "#fde68a");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 顶部装饰圆
  ctx.fillStyle = "rgba(245, 158, 11, 0.12)";
  ctx.beginPath();
  ctx.arc(90, 110, 150, 0, Math.PI * 2);
  ctx.arc(W - 80, H - 120, 170, 0, Math.PI * 2);
  ctx.fill();

  // 边框
  ctx.strokeStyle = "rgba(180, 83, 9, 0.35)";
  ctx.lineWidth = 4;
  ctx.strokeRect(28, 28, W - 56, H - 56);

  ctx.textAlign = "center";

  // 标题
  ctx.fillStyle = "#92400e";
  ctx.font = "600 34px system-ui, sans-serif";
  ctx.fillText("谜盒 · 万物皆可猜", cx, 110);

  // 玩家
  ctx.font = "72px system-ui, sans-serif";
  ctx.fillText(data.avatar, cx, 210);
  ctx.fillStyle = "#1c1917";
  ctx.font = "bold 44px system-ui, sans-serif";
  ctx.fillText(data.nickname, cx, 290);

  // 模式 / 关卡
  ctx.fillStyle = "#b45309";
  ctx.font = "500 30px system-ui, sans-serif";
  ctx.fillText(`${data.modeLabel} · ${data.stageLabel}`, cx, 350);

  // 得分
  ctx.fillStyle = "#1c1917";
  ctx.font = "900 150px system-ui, sans-serif";
  ctx.fillText(String(data.score), cx, 490);

  ctx.fillStyle = "#78716c";
  ctx.font = "26px system-ui, sans-serif";
  ctx.fillText("本局得分", cx, 560);

  // 数据行：正确率 / 最大连击
  const infoY = 650;
  const colX = [cx - 160, cx + 160];
  ctx.fillStyle = "#1c1917";
  ctx.font = "bold 56px system-ui, sans-serif";
  ctx.fillText(`${data.accuracy}%`, colX[0], infoY);
  ctx.fillText(`×${data.combo}`, colX[1], infoY);
  ctx.fillStyle = "#78716c";
  ctx.font = "24px system-ui, sans-serif";
  ctx.fillText("正确率", colX[0], infoY + 45);
  ctx.fillText("最高连击", colX[1], infoY + 45);

  // 星级
  drawStars(ctx, data.stars, cx, 790, 52);

  // 通关徽章
  if (data.stars > 0) {
    ctx.fillStyle = "#b45309";
    ctx.font = "bold 30px system-ui, sans-serif";
    ctx.fillText("🎉 挑战成功，关卡已点亮", cx, 870);
  }

  // 日期 + 水印
  ctx.fillStyle = "rgba(120, 113, 108, 0.9)";
  ctx.font = "24px system-ui, sans-serif";
  ctx.fillText(data.date, cx, 940);

  return canvas;
}

export function ShareCard({
  open,
  onClose,
  data,
}: {
  open: boolean;
  onClose: () => void;
  data: ShareCardData;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [shareTip, setShareTip] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const canvas = drawCard(data);
    canvasRef.current = canvas;
    setDataUrl(canvas.toDataURL("image/png"));
  }, [open, data]);

  const handleDownload = useCallback(() => {
    if (!canvasRef.current) return;
    const a = document.createElement("a");
    a.href = canvasRef.current.toDataURL("image/png");
    a.download = `谜盒战绩-${data.score}分.png`;
    a.click();
  }, [data.score]);

  const handleShare = useCallback(async () => {
    if (!canvasRef.current) return;
    try {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvasRef.current!.toBlob(resolve, "image/png"),
      );
      if (!blob) throw new Error("生成失败");
      const file = new File([blob], "mihe-score.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "谜盒战绩" });
      } else {
        setShareTip("当前浏览器不支持直接分享，已改为下载");
        handleDownload();
      }
    } catch {
      setShareTip("分享已取消");
    }
  }, [handleDownload]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-3xl bg-white p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-3 text-center font-semibold">战绩卡片</p>
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={dataUrl} alt="战绩卡片" className="w-full rounded-xl shadow" />
        ) : (
          <div className="py-40 text-center text-zinc-400">生成中…</div>
        )}
        {shareTip && <p className="mt-2 text-center text-xs text-zinc-500">{shareTip}</p>}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            onClick={handleDownload}
            className="rounded-xl bg-amber-500 py-3 font-bold text-white"
          >
            保存图片
          </button>
          <button onClick={handleShare} className="rounded-xl border border-zinc-300 py-3">
            分享
          </button>
        </div>
        <button
          onClick={onClose}
          className="mt-2 w-full rounded-xl py-2 text-sm text-zinc-500"
        >
          关闭
        </button>
      </div>
    </div>
  );
}
