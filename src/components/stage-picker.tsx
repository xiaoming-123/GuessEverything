"use client";

/**
 * 关卡选择器 · 展示某模式的三个关卡（星级/最高分/解锁状态）
 */

import { summarizeStages, STAGE_LABEL, type GameMode } from "@/lib/games/stages";
import type { PlayerProgress } from "@/store/player-store";

export function StagePicker({
  mode,
  progresses,
  selected,
  onSelect,
}: {
  mode: GameMode;
  progresses: PlayerProgress[];
  selected: string;
  onSelect: (stage: string) => void;
}) {
  const stages = summarizeStages(mode, progresses);

  return (
    <div className="grid gap-2">
      {stages.map((s) => {
        const locked = !s.unlocked;
        return (
          <button
            key={s.stage}
            disabled={locked}
            onClick={() => onSelect(s.stage)}
            className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition ${
              locked
                ? "border-zinc-100 bg-zinc-50 opacity-60"
                : s.stage === selected
                  ? "border-amber-500 bg-amber-50"
                  : "border-zinc-200 bg-white hover:border-amber-400"
            }`}
          >
            <span className="text-xl">{locked ? "🔒" : `第${s.index + 1}关`}</span>
            <span className="flex-1">
              <span className="block font-medium">{STAGE_LABEL[s.stage]}</span>
              <span className="block text-xs text-zinc-400">
                {s.bestScore > 0 ? `最高 ${s.bestScore} 分` : locked ? "通关上一关后解锁" : "未挑战"}
              </span>
            </span>
            <span className="text-sm tracking-tighter">
              {"⭐".repeat(s.stars)}
              {"☆".repeat(3 - s.stars)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
