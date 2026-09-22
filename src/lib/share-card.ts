import { BRAND } from "./brand";

/**
 * 分享卡文案 · 纯逻辑层（P2 详设 §3.2）
 *
 * 红线：卡面只含展示字段（称号/正确率/功名/成就/日期），
 * **绝不拼入**题目文本、correctAnswer、sourceKey——
 * 入参即卡面全部数据源，函数只做拼装与截断。
 */

/** 分享卡入参（全部来自已脱敏的 RankSummary / RankView，服务端不下发答案） */
export interface ShareCardInput {
  /** 当前官衔称号（RankView.label） */
  rankLabel: string;
  /** 正确率（0-100 整数） */
  accuracy: number;
  /** 本局功名 */
  expGained: number;
  /** 累计功名 */
  totalExp: number;
  /** 新达成成就 label 数组（服务端 newBadges → 客户端查表后的文案） */
  newBadges: string[];
  /** 日期（YYYY-MM-DD，Asia/Shanghai 口径） */
  dateKey: string;
}

export interface ShareCardLines {
  title: string;
  lines: string[];
  footer: string;
}

/** 成就展示上限（卡面空间约束，纯展示截断） */
const BADGE_MAX = 3;

/**
 * 拼装分享卡文案（纯函数，可单测）：
 * - title：游戏名 + 玩法名；
 * - lines：称号 / 正确率 / 本局功名 / 累计功名 / 成就（≤3，超出折叠「…+N」）；
 * - footer：架空声明（红线：不宣称真实官制）。
 */
export function buildShareCardLines(input: ShareCardInput): ShareCardLines {
  const badgeLines: string[] = [];
  if (input.newBadges.length > 0) {
    const shown = input.newBadges.slice(0, BADGE_MAX);
    const extra = input.newBadges.length - shown.length;
    badgeLines.push(
      shown.join(" · ") + (extra > 0 ? ` · …+${extra}` : ""),
    );
  }
  return {
    title: BRAND.name,
    lines: [
      `官衔：${input.rankLabel}`,
      `正确率 ${input.accuracy}% · 本局功名 +${input.expGained}`,
      `累计功名 ${input.totalExp}`,
      ...badgeLines,
      `日期 ${input.dateKey}`,
    ],
    footer: "架空称号 · 非真实官制",
  };
}
