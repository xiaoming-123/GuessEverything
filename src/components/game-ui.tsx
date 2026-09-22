"use client";

import Link from "next/link";
import {
  Children,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export function GameShell({
  title,
  back = "/play/poetry-rank",
  action,
  children,
  className = "",
}: {
  title: string;
  back?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <main className={`game-shell ${className}`}>
      <header className="game-header">
        <Link className="quiet-button" href={back} aria-label="返回">
          〈 返回
        </Link>
        <span className="header-title">{title}</span>
        <div className="header-action">
          {action ?? (
            <span className="seal-small" aria-hidden="true">
              诗
            </span>
          )}
        </div>
      </header>
      {children}
    </main>
  );
}

export function StatusView({
  error,
  loading = "正在翻开这一页…",
  onRetry,
  children,
}: {
  error?: string;
  loading?: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="status-view" role={error ? "alert" : "status"}>
      <span className="status-mark" aria-hidden="true">
        {error ? "↻" : "书"}
      </span>
      <p>{error || loading}</p>
      {error && onRetry && (
        <button className="button primary" onClick={onRetry}>
          重新载入
        </button>
      )}
      {children}
    </div>
  );
}

export function Pager({
  page,
  count,
  onChange,
  busy = false,
}: {
  page: number;
  count: number;
  onChange: (p: number) => void;
  busy?: boolean;
}) {
  return (
    <nav className="pager" aria-label="分页">
      <button
        className="quiet-button"
        disabled={busy || page <= 0}
        onClick={() => onChange(page - 1)}
      >
        上一页
      </button>
      <span aria-live="polite">
        {page + 1} / {Math.max(1, count)}
      </span>
      <button
        className="quiet-button"
        disabled={busy || page >= count - 1}
        onClick={() => onChange(page + 1)}
      >
        下一页
      </button>
    </nav>
  );
}

/** 按真实可用高度分页，测量区不参与焦点和可访问树。 */
export function PagedItems({
  children,
  resetKey = "",
}: {
  children: ReactNode;
  resetKey?: string | number;
}) {
  const items = Children.toArray(children);
  const measure = useRef<HTMLDivElement>(null);
  const [ranges, setRanges] = useState<[number, number][]>([[0, 1]]);
  const [page, setPage] = useState(0);
  useLayoutEffect(() => {
    const node = measure.current;
    if (!node) return;
    const update = () => {
      const height = node.clientHeight;
      if (!height) return;
      const next: [number, number][] = [];
      let start = 0,
        used = 0;
      Array.from(node.children).forEach((child, index) => {
        const h = child.getBoundingClientRect().height + 10;
        if (used && used + h > height) {
          next.push([start, index]);
          start = index;
          used = 0;
        }
        used += h;
      });
      if (node.children.length) next.push([start, node.children.length]);
      setRanges((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    Array.from(node.children).forEach((child) => observer.observe(child));
    update();
    return () => observer.disconnect();
  }, [children]);
  useEffect(() => setPage(0), [resetKey]);
  const current = Math.min(page, Math.max(0, ranges.length - 1));
  const [start, end] = ranges[current] ?? [0, items.length];
  return (
    <div className="paged-items">
      <div className="page-area">
        <div className="page-measure" ref={measure} aria-hidden="true" inert>
          {items}
        </div>
        <div className="page-items">{items.slice(start, end)}</div>
      </div>
      <Pager page={current} count={ranges.length} onChange={setPage} />
    </div>
  );
}

/** 超长正文按真实字形测量分页，保持文本完整，不通过 line-clamp 截断。 */
export function PagedText({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const [parts, setParts] = useState([text]);
  const [page, setPage] = useState(0);
  useLayoutEffect(() => {
    const el = box.current,
      test = probe.current;
    if (!el || !test) return;
    const update = () => {
      const height = el.clientHeight;
      if (height < 20 || !el.clientWidth) return;
      const chars = Array.from(text);
      const next: string[] = [];
      let start = 0;
      while (start < chars.length) {
        let lo = 1,
          hi = chars.length - start,
          fit = 1;
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          test.textContent = chars.slice(start, start + mid).join("");
          if (test.scrollHeight <= height + 1) {
            fit = mid;
            lo = mid + 1;
          } else hi = mid - 1;
        }
        next.push(chars.slice(start, start + fit).join(""));
        start += fit;
      }
      setParts((prev) =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();
    return () => observer.disconnect();
  }, [text]);
  useEffect(() => setPage(0), [text]);
  const current = Math.min(page, Math.max(0, parts.length - 1));
  return (
    <div className={`paged-text ${className}`}>
      <div className="text-page" ref={box}>
        <div className="text-probe" ref={probe} aria-hidden="true" />
        <div className="text-visible">{parts[current] ?? text}</div>
      </div>
      {parts.length > 1 && (
        <Pager page={current} count={parts.length} onChange={setPage} />
      )}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="game-modal"
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="modal-inner">
        <header className="modal-header">
          <h2 id={id}>{title}</h2>
          <button
            className="quiet-button"
            autoFocus
            onClick={onClose}
            aria-label="关闭"
          >
            关闭 ×
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </div>
    </dialog>
  );
}

export function Tabs({
  options,
  value,
  onChange,
}: {
  options: readonly string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <nav className="tabs" aria-label="内容分类">
      {options.map((option) => (
        <button
          key={option}
          className={value === option ? "active" : ""}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </nav>
  );
}
