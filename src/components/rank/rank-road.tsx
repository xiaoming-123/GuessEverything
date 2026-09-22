"use client";
import { useState } from "react";
import type { RankView } from "@/lib/db/rank-service";
import { Modal, PagedItems } from "@/components/game-ui";

export function RankRoad({ rank }: { rank: RankView }) {
  const [open, setOpen] = useState(false);
  const visible = rank.ranks.filter((r) => !r.isEmperor || rank.rankId >= 9);
  const next = visible.find((r) => r.rankId === rank.rankId + 1);
  return (
    <>
      <button
        className="road-strip"
        onClick={() => setOpen(true)}
        aria-label="查看官途"
      >
        <span>
          <i className="road-dot current" />
          {rank.label}
        </span>
        <span className="road-line" />
        <span>
          <i className="road-dot" />
          {next?.label ?? "功成名就"}
        </span>
        <span className="road-more">{next ? "前路待启" : "回望来路"} 〉</span>
      </button>
      {open && (
        <Modal title="这一世的来路" onClose={() => setOpen(false)}>
          <PagedItems>
            {visible.map((r) => (
              <div className="list-card" key={r.key}>
                <span className="list-number">
                  {r.rankId < rank.rankId
                    ? "✓"
                    : r.rankId === rank.rankId
                      ? "◉"
                      : "○"}
                </span>
                <div>
                  <strong>
                    {r.rankId <= rank.rankId + 1 ? r.label : "未揭晓"}
                  </strong>
                  <small>
                    {r.rankId === rank.rankId
                      ? r.subtitle
                      : r.rankId < rank.rankId
                        ? "已走过的路"
                        : "再进一步，揭开新的篇章"}
                  </small>
                </div>
              </div>
            ))}
          </PagedItems>
        </Modal>
      )}
    </>
  );
}
