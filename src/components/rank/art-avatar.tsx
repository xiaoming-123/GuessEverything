"use client";

/**
 * 美术头像渲染器（详设 §6 约定：常量表返回字符串，本组件统一分支）。
 * - 以 `/` 或 `http` 开头 → <img>（D5 真实立绘）
 * - 否则 → emoji 文本（占位 / 未入库兜底）
 * 容器尺寸由调用方 className 决定；图片 object-contain 居中铺满容器。
 */

import { useEffect, useState } from "react";

interface ArtAvatarProps {
  src: string;
  /** 容器类（尺寸/圆角/背景） */
  containerClassName?: string;
  /** 图片类（叠加在 object-contain 之上） */
  imgClassName?: string;
  /** emoji 占位字号 */
  emojiClassName?: string;
  alt?: string;
}

export function ArtAvatar({
  src,
  containerClassName = "",
  imgClassName = "",
  emojiClassName = "text-2xl",
  alt = "立绘",
}: ArtAvatarProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const isImage = src.startsWith("/") || src.startsWith("http");
  if (isImage && !failed) {
    return (
      <div
        className={`flex items-center justify-center overflow-hidden ${containerClassName}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          onError={() => setFailed(true)}
          className={`h-full w-full object-contain ${imgClassName}`}
        />
      </div>
    );
  }
  return (
    <div className={`flex items-center justify-center ${containerClassName}`}>
      <span
        className={emojiClassName}
        role={failed ? "img" : undefined}
        aria-label={failed ? alt : undefined}
      >
        {failed ? "✧" : src}
      </span>
    </div>
  );
}
