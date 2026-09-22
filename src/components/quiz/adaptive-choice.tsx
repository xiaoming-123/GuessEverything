"use client";
import { useLayoutEffect, useRef, useState } from "react";

/** 常规选项直接作答；极长选项先完整阅读，再由面板显式确认。 */
export function AdaptiveChoice({
  text,
  index,
  marker,
  className,
  disabled,
  onChoose,
  onRead,
}: {
  text: string;
  index: number;
  marker: string;
  className: string;
  disabled: boolean;
  onChoose: () => void;
  onRead: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [needsReader, setNeedsReader] = useState(false);
  useLayoutEffect(() => {
    const node = button.current,
      probe = measure.current;
    if (!node || !probe) return;
    const update = () =>
      setNeedsReader(
        probe.getBoundingClientRect().height > node.clientHeight - 16,
      );
    const observer = new ResizeObserver(update);
    observer.observe(node);
    observer.observe(probe);
    update();
    return () => observer.disconnect();
  }, [text]);
  return (
    <button
      ref={button}
      data-testid={`choice-${index}`}
      className={className}
      disabled={disabled}
      onClick={needsReader ? onRead : onChoose}
    >
      <span className="choice-key">{marker}</span>
      <span>{needsReader ? "长选项 · 展开全文" : text}</span>
      <span ref={measure} className="choice-measure" aria-hidden="true">
        {text}
      </span>
    </button>
  );
}
