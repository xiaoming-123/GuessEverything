/**
 * 飞花令语料构建 · 纯函数
 *
 * 直接复用诗词猜猜语料（PoemCorpusItem）：
 * - 按行拆成单句（语料中 lines 已是五言/七言单句或词句）
 * - 过短残句（<4 字）与重复句剔除
 * - 句难度由原诗 grade 推导（1-6→1 / 7-9→2 / 10-12→3）
 * - 建令字倒排索引（令字 → 含该字的句子），只收录含句量足够的令字
 */

import type { PoemCorpusItem } from "@/lib/games/poetry/types";
import type { FeihuaSentence } from "./types";

/** 短于该长度的句子视为残句剔除（如"浪淘尽"三字句） */
export const MIN_SENTENCE_LEN = 4;

/**
 * 候选令字表：均为诗词高频意象字。
 * 最终是否可用还需通过语料索引校验（含句数 ≥ LING_MIN_CONTAINS）。
 */
export const LING_CHARS = [
  "春", "花", "月", "风", "雨", "山", "水", "云",
  "夜", "酒", "人", "天", "日", "江", "雪", "梅",
  "柳", "草", "树", "鸟", "愁", "秋", "星", "霜",
  "舟", "乡", "城", "玉", "烟", "莲", "莺", "燕",
  "荷", "霞", "归", "白", "青", "红", "黄", "绿",
  "龙", "剑", "歌", "泪", "心", "情", "梦",
] as const;

/** 令字至少命中这么多句才可入索引（保证挑白题能凑齐 3 个含字选项） */
export const LING_MIN_CONTAINS = 3;

/** 学段 grade → 飞花令难度档 */
export function gradeToDifficulty(grade: number): 1 | 2 | 3 {
  if (grade <= 6) return 1;
  if (grade <= 9) return 2;
  return 3;
}

/** 诗词语料 → 去重后的句子素材 */
export function buildSentences(poems: PoemCorpusItem[]): FeihuaSentence[] {
  const sentences: FeihuaSentence[] = [];
  const seenText = new Set<string>();
  for (const poem of poems) {
    poem.lines.forEach((text, lineIndex) => {
      if (text.length < MIN_SENTENCE_LEN) return;
      if (seenText.has(text)) return;
      seenText.add(text);
      sentences.push({
        id: `${poem.id}#${lineIndex}`,
        text,
        poemId: poem.id,
        poemTitle: poem.title,
        poet: poem.poet,
        dynasty: poem.dynasty,
        difficulty: gradeToDifficulty(poem.grade),
        famous: poem.famous,
      });
    });
  }
  return sentences;
}

/** 句中是否含某令字 */
export function sentenceContains(sentence: FeihuaSentence, char: string): boolean {
  return sentence.text.includes(char);
}

/**
 * 构建令字倒排索引：令字 → 含该字的句子（仅保留含句数达标的令字）
 */
export function buildLingIndex(
  sentences: readonly FeihuaSentence[],
): Map<string, FeihuaSentence[]> {
  const index = new Map<string, FeihuaSentence[]>();
  for (const char of LING_CHARS) {
    const hits = sentences.filter((s) => s.text.includes(char));
    if (hits.length >= LING_MIN_CONTAINS) index.set(char, hits);
  }
  return index;
}
