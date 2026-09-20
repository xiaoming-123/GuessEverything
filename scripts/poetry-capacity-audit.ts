/** 只读语料审计；生成 Markdown 报告，不接触数据库。 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { distinctFacesByGrade, simulatePath, totalDistinctFaces } from "../src/lib/games/poetry/capacity";
import { buildRankedRounds, rankedRoundPool, roundFaceKey } from "../src/lib/games/poetry/engine";
import { RANKS } from "../src/lib/games/poetry/rank";
import { computeScore } from "../src/lib/games/poetry/score";
import type { PoemCorpusItem, RankKind } from "../src/lib/games/poetry/types";
import seedJson from "../src/lib/data/poetry-seed.json";

const corpus = seedJson as PoemCorpusItem[];
const byGrade = distinctFacesByGrade(corpus);
const totalFaces = totalDistinctFaces(corpus);
const lines: string[] = [];
const w = (text = "") => lines.push(text);

function score(count: number, accuracy: number): number {
  return Array.from({ length: Math.floor(count * accuracy) }, (_, i) =>
    computeScore({ correct: true, combo: i + 1, timeMs: 5000 }).gained,
  ).reduce((a, b) => a + b, 0);
}

/** 调用真实出卷器；缺题立即停止，绝不在失败后虚构晋升。 */
function replay(accuracy: number, seed: number, failures: number) {
  let exp = 0;
  let games = 0;
  let used = 0;
  const keys: string[] = [];
  const faces: string[] = [];
  for (let rank = 0; rank < 10; rank++) {
    const play = (rankId: number, kind: RankKind, passed: boolean): string | null => {
      const result = buildRankedRounds(corpus, {
        rankId, kind, seed: seed + games, excludeKeys: keys, excludeFaces: faces,
      });
      if (!result.ok) return RANKS[rank].label + "→" + RANKS[rank + 1].label + " " + kind +
        "：剩余 " + result.available + "/" + result.required;
      for (const round of result.rounds) {
        keys.push(round.sourceKey);
        // 由 round 直接重构题面（review A4-2 同口径）：四段 FILL_CHAR key
        // 不能再按 sourceKey 反解析（Number("FILL_CHAR")→NaN），用 roundFaceKey 免此坑。
        faces.push(roundFaceKey(round));
      }
      games++;
      used += result.rounds.length;
      if (passed) exp += score(result.rounds.length, accuracy);
      return null;
    };
    while (exp < RANKS[rank + 1].expToReach) {
      const blocked = play(rank, "PRACTICE", true);
      if (blocked) return { games, used, blocked };
    }
    for (let attempt = 0; attempt <= failures; attempt++) {
      const blocked = play(rank + 1, "EXAM", attempt === failures);
      if (blocked) return { games, used, blocked };
    }
  }
  return { games, used, blocked: "无（已登极）" };
}

w("# 诗词升官：修正后的题库容量审计");
w("\n生成时间：" + new Date().toISOString() + "。由 scripts/poetry-capacity-audit.ts 生成。");
w("\n## 统计边界与假设\n");
w("- 当前种子 " + corpus.length + " 首，理论题面并集 " + totalFaces + " 道；理论题面没有过滤干扰项，不等于实际可出题量。");
w("- **D3 新题型口径**：FILL_CHAR（选字填空）题面含「挖字位 pos」维度（每 CJK 字位一道独立题面，四段 key），DYNASTY_PICK（朝代配对）按句位计。理论题面总数因此随挖字位展开而增大，与 D3 之前的旧口径（仅 3 基础题型）**不可直接对比**。");
w("- 可用池调用正式 rankedRoundPool，必须四个唯一且同类型的选项，按正式局内题干规则去重。表中是种子 1 的单次候选池，不是永久容量保证。不同题型共用题干时，一局只选其中一个，其他题型可能在后续局出现。");
w("- 晋升 EXAM 的 rankId 指目标官阶；研习指当前官阶。皇帝考试十五题。");
w("- 功名估算将答对题连续放在前面，且每题五秒以内：这是给定正确率下的乐观连击排列，不是典型用户数据。");
w("- 失败/弃局压力场景：每阶一次零分考试消耗整卷，再尝试通过；不声称是用户真实失败分布。");
w("- 需求模型即使缺题仍计算余下路径的理论需求；真实引擎回放遇到第一次缺题立即停止。两者不可混称。");
w("\n## 各阶正式出卷候选池\n");
w("| 官阶 | 研习有效池 | 本阶 EXAM 有效池 | EXAM 需题数 |");
w("| --- | ---: | ---: | ---: |");
for (const rank of RANKS) {
  const practice = rankedRoundPool(corpus, { rankId: rank.id, kind: "PRACTICE", seed: 1 }).length;
  const exam = rankedRoundPool(corpus, { rankId: rank.id, kind: "EXAM", seed: 1 }).length;
  w("| " + [rank.label, practice, exam, rank.isEmperor ? 15 : 10].join(" | ") + " |");
}
w("\n## 全路径理论需求及真实引擎回放\n");
for (const [accuracy, failures] of [[1, 0], [0.8, 0], [0.6, 0], [0.8, 1]]) {
  const demand = simulatePath({ facesByGrade: byGrade, ranks: RANKS,
    expPerPractice: score(10, accuracy), expPerExam: score(10, accuracy),
    maxExamRetries: failures, globalDistinct: totalFaces });
  w("### 正确率 " + accuracy * 100 + "%，每阶失败 " + failures + " 次\n");
  w("每十题得分 " + score(10, accuracy) + "；到皇帝需要 " + demand.totalQuestions +
    " 道新题，超过理论总量至少 " + demand.globalShortfall + " 道。");
  w("\n| 随机种子 | 成功发出的局数 | 消耗新题 | 首次阻塞 |");
  w("| --- | ---: | ---: | --- |");
  for (const seed of [1, 42, 2026]) {
    const result = replay(accuracy, seed, failures);
    w("| " + [seed, result.games, result.used, result.blocked].join(" | ") + " |");
  }
  w();
}
w("## 结论与下一步\n");
w("现有题库无法支撑全路径：总量与窗口分布均需扩容。旧报告以实际抽到的题数冒充总需求，进而声称只存在窗口瓶颈，该结论作废。");
w("先按窗口补足同类型干扰项和晋升预留，再扩容并校对原文、作者、题面身份与难度。上线前至少通过不同固定种子下的完整路径测试；测试数据充足不代表正式语料已验收。");
w("持久化层必须保存 sourceKey 与 faceKey，并原子占用题目和一次性结算。数据库不可用时停用官阶模式，不能退回遗忘历史的内存模式。");

const report = lines.join("\n") + "\n";
writeFileSync(resolve("docs/design/2026-09-17-poetry-capacity-report.md"), report, "utf8");
console.log(report);
