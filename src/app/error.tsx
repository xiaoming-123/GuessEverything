"use client";
import Link from "next/link";
import { GameShell, StatusView } from "@/components/game-ui";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <GameShell title="诗词逆命" back="/">
      <StatusView error="这一页暂未展开，已有进度会为你保留。" onRetry={reset}>
        <Link className="quiet-button" href="/">
          返回首页
        </Link>
      </StatusView>
    </GameShell>
  );
}
