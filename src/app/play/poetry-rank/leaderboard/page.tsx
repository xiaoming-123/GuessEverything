"use client";
import { useState } from "react";
import type { LeaderboardView } from "@/lib/db/leaderboard-service";
import type { RankView } from "@/lib/db/rank-service";
import {
  GameShell,
  Modal,
  PagedItems,
  PagedText,
  StatusView,
  Tabs,
} from "@/components/game-ui";
import { useGameResource } from "@/components/use-game-resource";
const BIO: Record<string, string> = {
  李白: "诗仙，斗酒诗百篇。",
  苏轼: "东坡居士，一蓑烟雨任平生。",
  辛弃疾: "稼轩，醉里挑灯看剑。",
  王勃: "初唐四杰，《滕王阁序》。",
  孟浩然: "布衣之交，微云淡河汉。",
};
export default function LeaderboardPage() {
  const { data, error, loading, reload } = useGameResource<LeaderboardView>(
    "/api/games/poetry/rank/leaderboard",
  );
  const { data: rank } = useGameResource<RankView>("/api/games/poetry/rank");
  const [tab, setTab] = useState("本季皇榜");
  const [detail, setDetail] = useState("");
  const label = (text: string) =>
    text === "皇帝" && (rank?.rankId ?? 0) < 9 ? "隐世高人" : text;
  return (
    <GameShell title="皇榜">
      <div className="book-heading">
        <p className="eyebrow">与诗友同行</p>
        <h1>满卷诗才，榜上相逢</h1>
        <p>{data?.seasonLabel ?? "本季"} · 展示前 100 位，含虚拟诗人</p>
      </div>
      <Tabs options={["本季皇榜", "往期留名"]} value={tab} onChange={setTab} />
      {loading || error || !data ? (
        <StatusView error={error} loading="正在展开金榜…" onRetry={reload} />
      ) : (
        <>
          {tab === "本季皇榜" ? (
            <PagedItems resetKey={tab}>
              {data.items.map((entry, index) => (
                <button
                  key={`${entry.name}-${index}`}
                  className="list-card"
                  onClick={() =>
                    setDetail(
                      `${entry.name}\n${label(entry.rankLabel)} · 本季功名 ${entry.seasonExp}\n\n${entry.isVirtual ? `这是陪伴你成长的虚拟诗人。\n${BIO[entry.name] ?? "以诗会友，共赴前程。"}` : "以诗会友，共赴前程。"}`,
                    )
                  }
                >
                  <span className="list-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="poem-meta">
                    <strong>{entry.name}</strong>
                    <small>
                      {label(entry.rankLabel)} · {entry.seasonExp} 功名
                    </small>
                  </div>
                  {entry.isVirtual && <span className="mastery">诗人</span>}
                </button>
              ))}
            </PagedItems>
          ) : data.past.length ? (
            <PagedItems resetKey={tab}>
              {data.past.map((past) => (
                <div className="list-card" key={past.seasonKey}>
                  <div>
                    <strong>{past.label}</strong>
                    <small>
                      {label(past.rankLabel)} · {past.seasonExp} 功名
                    </small>
                  </div>
                </div>
              ))}
            </PagedItems>
          ) : (
            <StatusView loading="新的一季，等你写下第一笔。" />
          )}
          <div className="my-standing">
            <span>我的本季功名</span>
            <strong>{data.my?.seasonExp ?? 0}</strong>
            <small>
              {data.my
                ? `第 ${data.my.aboveCount + 1} 位`
                : "继续研习，积累功名"}
            </small>
          </div>
        </>
      )}
      {detail && (
        <Modal title="榜上相逢" onClose={() => setDetail("")}>
          <PagedText text={detail} />
        </Modal>
      )}
    </GameShell>
  );
}
