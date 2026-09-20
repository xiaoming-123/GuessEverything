/**
 * 候选语料离线验收（只读，不写库）。
 *
 * 职责（对应 2026-09-18-next-steps 第 1 条「导入候选题先离线验证
 * 四选项与题面唯一性，通过同一审计脚本后再入库」）：
 * 1. ID 冲突（候选 id 不得与现库重复）
 * 2. 重复诗检测：同（题名, 作者）或全文逐字相同（换 ID/换题名不得绕过去重）
 * 3. 题面（faceKey）冲突：候选的 题干+正确答案+题型 与现库已有题面碰撞
 * 4. 四选项可行性：用正式出卷器 materializeRound(strictOptions=true)
 *    对候选每个「句位 × 题型」素材实例化，要求四个唯一选项
 *
 * 通过（exit 0）才可并入 poetry-seed.json；失败（exit 1）逐项列出原因。
 * 注意：本脚本只验证结构性问题，不替代人工对原文/作者/难度的校对。
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { faceKey, materializeRound } from "../src/lib/games/poetry/engine";
import { PoemCorpusItem, PoetryQuestionType } from "../src/lib/games/poetry/types";
import seedJson from "../src/lib/data/poetry-seed.json";
import candidatesJson from "../src/lib/data/poetry-candidates.json";

const seed = seedJson as PoemCorpusItem[];
const candidates = candidatesJson as PoemCorpusItem[];
const merged: PoemCorpusItem[] = [...seed, ...candidates];

const ALL_TYPES: PoetryQuestionType[] = [
  PoetryQuestionType.GUESS_POET,
  PoetryQuestionType.GUESS_TITLE,
  PoetryQuestionType.COMPLETE_NEXT,
];

/** 现库全量题面集合 */
const existingFaces = new Set<string>();
for (const item of seed) {
  for (let i = 0; i < item.lines.length - 1; i++) {
    for (const t of ALL_TYPES) existingFaces.add(faceKey(item, i, t));
  }
}

/** 现库全文指纹（行拼接，换 ID/换题名查重用） */
const existingFullTexts = new Map<string, string>();
for (const p of seed) existingFullTexts.set(p.lines.join("\n"), p.id);

interface Issue {
  level: "error" | "warn";
  code: string;
  message: string;
}

const perPoem = new Map<string, Issue[]>();
const issuesOf = (id: string): Issue[] => {
  if (!perPoem.has(id)) perPoem.set(id, []);
  return perPoem.get(id)!;
};
const candidateFullTexts = new Map<string, string>();

for (const c of candidates) {
  const id = c.id;

  /* 1. ID 冲突 */
  if (seed.some((p) => p.id === id)) {
    issuesOf(id).push({ level: "error", code: "ID_COLLISION", message: `id ${id} 与现库重复` });
  }

  /* 2. 重复诗：同（题名, 作者）或全文相同（换 ID 查重） */
  if (seed.some((p) => p.title === c.title && p.poet === c.poet)) {
    issuesOf(id).push({ level: "error", code: "DUPLICATE_POEM", message: `《${c.title}》（${c.poet}）已存在于现库` });
  }
  const fullText = c.lines.join("\n");
  const dupId = existingFullTexts.get(fullText);
  if (dupId) {
    issuesOf(id).push({ level: "error", code: "DUPLICATE_TEXT", message: `全文与现库 ${dupId} 逐字相同（换 ID/换题名不得绕过去重）` });
  }
  const prevCand = candidateFullTexts.get(fullText);
  if (prevCand) {
    issuesOf(id).push({ level: "error", code: "DUPLICATE_TEXT", message: `全文与候选 ${prevCand} 逐字相同` });
  }
  candidateFullTexts.set(fullText, id);

  /* 3. 结构 */
  if (c.lines.length < 2) {
    issuesOf(id).push({ level: "error", code: "STRUCTURE", message: `行数 ${c.lines.length} < 2，无法构成补下句` });
  }
  if (c.grade < 1 || c.grade > 12) {
    issuesOf(id).push({ level: "error", code: "GRADE_RANGE", message: `grade ${c.grade} 超出 1..12` });
  }

  /* 4. 题面冲突 + 5. 四选项可行性（用合并后语料构造干扰项池，与正式出卷同口径） */
  let validMaterials = 0;
  let totalMaterials = 0;
  for (let i = 0; i < c.lines.length - 1; i++) {
    for (const t of ALL_TYPES) {
      totalMaterials++;
      const fk = faceKey(c, i, t);
      if (existingFaces.has(fk)) {
        issuesOf(id).push({
          level: "error",
          code: "DUPLICATE_FACE",
          message: `句位 ${i} × ${t} 题面与现库已有题面相同`,
        });
        continue;
      }
      const round = materializeRound(t, c, i, merged, 0, () => 0.5, true);
      const okOptions =
        round.answerIndex >= 0 && round.options.length === 4 && new Set(round.options).size === 4;
      if (!okOptions) {
        issuesOf(id).push({
          level: "error",
          code: "INSUFFICIENT_OPTIONS",
          message: `句位 ${i} × ${t} 无法构造四个唯一选项`,
        });
        continue;
      }
      validMaterials++;
    }
  }
  if (validMaterials === 0) {
    issuesOf(id).push({ level: "warn", code: "NO_VALID_MATERIAL", message: `无任何可用素材（${totalMaterials} 个全部失败）` });
  }
  // 记录有效素材数供报告
  issuesOf(id).push({ level: "warn", code: "__MATERIALS__", message: `${validMaterials}/${totalMaterials}` });
}

/* ---- 报告 ---- */
const lines: string[] = [];
const w = (t = "") => lines.push(t);
w("# 候选语料离线验收报告");
w(`\n生成时间：${new Date().toISOString()}。由 scripts/poetry-corpus-audit.ts 生成。`);
w(`\n现库 ${seed.length} 首，候选 ${candidates.length} 首。`);
w(`\n## 逐首结论\n`);
w("| id | 题名（作者） | grade | 结论 | 有效素材/总素材 | 问题 |");
w("| --- | --- | ---: | --- | --- | --- |");

let passCount = 0;
let failCount = 0;
for (const c of candidates) {
  const issues = perPoem.get(c.id) ?? [];
  const errors = issues.filter((i) => i.level === "error");
  const matInfo = issues.find((i) => i.code === "__MATERIALS__")?.message ?? "-";
  const passed = errors.length === 0;
  if (passed) passCount++;
  else failCount++;
  const detail = issues.filter((i) => i.code !== "__MATERIALS__");
  const detailText = detail.length > 0 ? detail.map((e) => `${e.code}: ${e.message}`).join("；") : "-";
  w(`| ${c.id} | 《${c.title}》（${c.poet}） | ${c.grade} | ${passed ? "通过" : "不通过"} | ${matInfo} | ${detailText} |`);
}
w(`\n## 汇总\n`);
w(`- 通过 ${passCount} / ${candidates.length}；不通过 ${failCount}。`);
w(`- 通过仅代表结构性验收（四选项可行性 + 题面唯一 + 无重复诗/换 ID 重复）；原文、作者归属、难度标签仍需人工校对（见 2026-09-20-poetry-corpus-plan.md 校对清单），校对完成前候选为「待核验」状态。`);

const report = lines.join("\n") + "\n";
writeFileSync(resolve("docs/design/2026-09-20-poetry-corpus-audit.md"), report, "utf8");
console.log(report);
process.exit(failCount > 0 ? 1 : 0);
