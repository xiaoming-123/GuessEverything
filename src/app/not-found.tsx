import Link from "next/link";
import { GameShell } from "@/components/game-ui";

export default function NotFound() {
  return (
    <GameShell title="诗词逆命" back="/">
      <div className="status-view">
        <span className="status-mark">卷</span>
        <h1>这一页，尚未落笔</h1>
        <p>你要找的篇章不在这里，回去续写这一世吧。</p>
        <Link className="button primary" href="/play/poetry-rank">
          返回官途
        </Link>
      </div>
    </GameShell>
  );
}
