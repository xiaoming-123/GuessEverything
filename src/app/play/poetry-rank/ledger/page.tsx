"use client";
import { useState } from "react";
import type { LedgerView, RankView } from "@/lib/db/rank-service";
import { ACHIEVEMENTS } from "@/lib/games/poetry/achievements";
import { secureFetch } from "@/lib/crypto/secure-fetch";
import { requirePlayerId } from "@/lib/client-player";
import {
  GameShell,
  Modal,
  PagedItems,
  PagedText,
  StatusView,
  Tabs,
} from "@/components/game-ui";
import { useGameResource } from "@/components/use-game-resource";
const STATE: Record<string, string> = {
  done: "已答",
  made: "已补",
  pending: "今日",
  missing: "未答",
  future: "未至",
};
export default function LedgerPage() {
  const { data, error, loading, reload } = useGameResource<LedgerView>(
    "/api/games/poetry/rank/ledger",
  );
  const { data: rank } = useGameResource<RankView>("/api/games/poetry/rank");
  const [tab, setTab] = useState("总览");
  const [detail, setDetail] = useState("");
  const [makeup, setMakeup] = useState(false);
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const doMakeup = async () => {
    if (busy || !date) return;
    setBusy(true);
    setMessage("");
    try {
      await secureFetch("/api/games/poetry/rank/makeup", {
        playerId: await requirePlayerId(),
        date,
      });
      setMessage("补签已记下，不增加功名。");
      reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "补签失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const badges = ACHIEVEMENTS.filter(
    (a) =>
      (rank?.rankId ?? 0) >= 9 || !["EMPEROR", "EMPEROR_HARD"].includes(a.key),
  );
  return (
    <GameShell title="功名簿">
      <div className="book-heading">
        <p className="eyebrow">每一步，都有回响</p>
        <h1>把努力，写进这一世</h1>
      </div>
      <Tabs options={["总览", "月历", "成就"]} value={tab} onChange={setTab} />
      {loading || error || !data ? (
        <StatusView error={error} loading="正在翻阅功名簿…" onRetry={reload} />
      ) : (
        <>
          {tab === "总览" && (
            <PagedItems>
              <div className="ledger-total paper-card">
                <span className="eyebrow">累计功名</span>
                <strong>{data.totalExp.toLocaleString()}</strong>
                <p>
                  已见 {data.seenCount} 道诗题 · 已获 {data.badges.length}{" "}
                  枚成就
                </p>
              </div>
              <div className="paper-card">
                <p className="muted">
                  最近 {data.recentBars.length} 局 · 每一次落笔都有所得
                </p>
                <div className="exp-chart">
                  {data.recentBars.map((b, i) => (
                    <div key={i}>
                      <span
                        style={{
                          height: `${Math.max(5, (b.exp / Math.max(1, ...data.recentBars.map((r) => r.exp))) * 65)}px`,
                        }}
                      />
                      <small>{b.exp}</small>
                    </div>
                  ))}
                </div>
                <p className="fine-print">功名只增不减，科考未中可再试。</p>
              </div>
            </PagedItems>
          )}
          {tab === "成就" && (
            <PagedItems resetKey={tab}>
              {badges.map((a) => {
                const earned = data.badges.includes(a.key);
                return (
                  <button
                    className="list-card"
                    key={a.key}
                    onClick={() =>
                      setDetail(
                        `${a.label}\n\n${a.desc}\n\n${earned ? "已达成，记入这一世的行囊。" : "尚未达成，前路仍有惊喜。"}`,
                      )
                    }
                  >
                    <span className={`badge-icon ${earned ? "earned" : ""}`}>
                      ✧
                    </span>
                    <div>
                      <strong>{a.label}</strong>
                      <small>{earned ? "已达成" : "待点亮"}</small>
                    </div>
                  </button>
                );
              })}
            </PagedItems>
          )}
          {tab === "月历" && (
            <>
              <p className="muted">
                {data.daily.cells.find(Boolean)?.date.slice(0, 7)} · 周连满{" "}
                {data.daily.weeksCompleted} · 本周奖励 {data.daily.weeklyBonus}
              </p>
              <PagedItems resetKey={tab}>
                {Array.from(
                  { length: Math.ceil(data.daily.cells.length / 7) },
                  (_, week) => (
                    <div className="calendar-week" key={week}>
                      {data.daily.cells
                        .slice(week * 7, week * 7 + 7)
                        .map((cell, i) =>
                          cell ? (
                            <div
                              className={`calendar-cell ${cell.state}`}
                              key={cell.date}
                            >
                              <small>
                                {["一", "二", "三", "四", "五", "六", "日"][i]}
                              </small>
                              <strong>{Number(cell.date.slice(8))}</strong>
                              <span>{STATE[cell.state]}</span>
                            </div>
                          ) : (
                            <span key={i} />
                          ),
                        )}
                    </div>
                  ),
                )}
              </PagedItems>
              <button
                className="button secondary"
                disabled={!data.daily.makeupLeft}
                onClick={() => {
                  setMessage("");
                  setMakeup(true);
                }}
              >
                补记上月 · 剩余 {data.daily.makeupLeft} 次
              </button>
            </>
          )}
        </>
      )}
      {detail && (
        <Modal title="这一世的成就" onClose={() => setDetail("")}>
          <PagedText text={detail} />
        </Modal>
      )}
      {makeup && (
        <Modal title="补记一日" onClose={() => setMakeup(false)}>
          <p className="muted">
            仅限上一自然月的未答日期，每月一次。补签不增加功名。
          </p>
          <label className="field">
            补签日期
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <button
            className="button primary"
            disabled={!date || busy || !data?.daily.makeupLeft}
            onClick={() => void doMakeup()}
          >
            {busy ? "正在记入…" : "确认补签"}
          </button>
          {message && <p role="status">{message}</p>}
        </Modal>
      )}
    </GameShell>
  );
}
