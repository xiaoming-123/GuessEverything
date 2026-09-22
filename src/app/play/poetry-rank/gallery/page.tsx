"use client";
import { useLayoutEffect, useRef, useState } from "react";
import {
  GameShell,
  Modal,
  PagedText,
  Pager,
  StatusView,
} from "@/components/game-ui";
import { useGameResource } from "@/components/use-game-resource";
import type { GalleryView } from "@/lib/db/rank-service";

export default function GalleryPage() {
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(3);
  const [dynasty, setDynasty] = useState("");
  const [grade, setGrade] = useState("");
  const [filters, setFilters] = useState(false);
  const [poem, setPoem] = useState<GalleryView["items"][number] | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const query = new URLSearchParams({
    page: String(page + 1),
    pageSize: String(size),
  });
  if (dynasty) query.set("dynasty", dynasty);
  if (grade) query.set("grade", grade);
  const { data, loading, error, reload } = useGameResource<GalleryView>(
    `/api/games/poetry/rank/gallery?${query}`,
  );
  useLayoutEffect(() => {
    const node = area.current;
    if (!node) return;
    const update = () => {
      const next = Math.max(1, Math.floor(node.clientHeight / 94));
      setSize((old) => {
        if (old !== next) setPage(0);
        return next;
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    update();
    return () => observer.disconnect();
  }, []);
  return (
    <GameShell
      title="诗词阁"
      action={
        <button className="quiet-button" onClick={() => setFilters(true)}>
          筛选
        </button>
      }
    >
      <div className="book-heading">
        <p className="eyebrow">读过的诗，都在这里</p>
        <h1>一诗一页，一路珍藏</h1>
        <p>
          {data ? `已收 ${data.total} 首` : "整理诗稿中"} ·
          答过即入阁，答对记为已通
        </p>
      </div>
      {(dynasty || grade) && (
        <button
          className="filter-reset"
          onClick={() => {
            setDynasty("");
            setGrade("");
            setPage(0);
          }}
        >
          {dynasty || "全部朝代"} · {grade ? `学段 ${grade}` : "全部学段"}　清除
          ×
        </button>
      )}
      <div ref={area} className="flex-fill gallery-list">
        {loading || error ? (
          <StatusView error={error} loading="正在整理诗稿…" onRetry={reload} />
        ) : !data?.items.length ? (
          <StatusView
            loading={
              page
                ? "这一卷已读尽，可返回上一页。"
                : "还没有诗稿。去研习一卷，把诗意带回来。"
            }
          />
        ) : (
          data.items.map((it, index) => (
            <button
              className="list-card poem-row"
              key={`${it.title}-${it.poet}-${index}`}
              onClick={() => setPoem(it)}
            >
              <span className="list-number">
                {String(page * size + index + 1).padStart(2, "0")}
              </span>
              <div className="poem-meta">
                <strong>{it.title}</strong>
                <small>
                  {it.dynasty} · {it.poet}
                </small>
              </div>
              <span className={`mastery ${it.mastered ? "earned" : ""}`}>
                {it.mastered ? "已通" : "已藏"}
              </span>
            </button>
          ))
        )}
      </div>
      <Pager
        page={page}
        count={page + (data?.items.length === size ? 2 : 1)}
        onChange={setPage}
        busy={loading}
      />
      {filters && (
        <Modal title="寻一首诗" onClose={() => setFilters(false)}>
          <label className="field">
            朝代
            <select
              value={dynasty}
              onChange={(e) => {
                setDynasty(e.target.value);
                setPage(0);
              }}
            >
              <option value="">全部朝代</option>
              {data?.byDynasty.map((d) => (
                <option key={d.dynasty} value={d.dynasty}>
                  {d.dynasty} · {d.count} 首
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            学段
            <select
              value={grade}
              onChange={(e) => {
                setGrade(e.target.value);
                setPage(0);
              }}
            >
              <option value="">全部学段</option>
              {data?.byGrade.map((g) => (
                <option key={g.grade} value={g.grade}>
                  学段 {g.grade} · {g.count} 首
                </option>
              ))}
            </select>
          </label>
          <button className="button primary" onClick={() => setFilters(false)}>
            翻开诗稿
          </button>
        </Modal>
      )}
      {poem && (
        <Modal title="诗稿" onClose={() => setPoem(null)}>
          <PagedText
            className="poem-reading"
            text={`${poem.title}\n${poem.dynasty} · ${poem.poet}\n\n${poem.lines.join("\n")}`}
          />
        </Modal>
      )}
    </GameShell>
  );
}
