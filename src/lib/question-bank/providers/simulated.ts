/**
 * 智能体题库引擎 · 模拟 provider（P1 确定性执行）
 *
 * 重要边界：本 provider 是**纯模拟**，仅用于在无模型、无网络环境下
 * 验证管线确定性逻辑（队列、状态机、哈希绑定、发布/回滚）。
 * 它不是真实模型，其「审核」结果不代表真实模型审核，也不代表正式入库。
 *
 * 模拟策略（确定性、可复现）：
 * - REVIEW：独立作答 —— 不看预设答案与命题解释，仅凭「已核验原文证据」
 *   （workVersion + 快照）按题型模板推导答案（等价于审核 agent 的第一遍）。
 * - REVISE：按结构化 issue + 种子确定性修订（如重取干扰项），不改来源事实。
 * - 任何阶段：外部原始文本（rawText）只作为数据被哈希/定位，
 *   provider 不解析其中指令（提示注入防护在 evidence 校验层 + 此处双保险）。
 *
 * 输出为结构化对象，由程序校验；tokensUsed 按输出规模确定性估算。
 */

import {
  detectInjection,
} from "../sources/evidence";
import type {
  ProviderInput,
  ProviderOutput,
  QuestionProvider,
} from "../contracts/types";

export const SIMULATED_PROVIDER_NAME = "SIMULATED";
export const SIMULATED_PROVIDER_VERSION = "SIMULATED-v1";

/** 确定性 token 估算：输出字符数 / 2（下限 8），模拟按最坏输出预留 */
export function estimateTokens(payload: unknown): number {
  const len = JSON.stringify(payload)?.length ?? 0;
  return Math.max(8, Math.ceil(len / 2));
}

/** 从已核验原文证据按题型模板推导答案（独立作答的核心） */
function deriveAnswerFromEvidence(input: ProviderInput): string | null {
  const { facts } = input;
  const type = facts.questionType as string | undefined;
  const workVersion = facts.workVersion as
    | { title?: string; author?: string; lines?: string[] }
    | undefined;
  const prompt = facts.prompt as string | undefined;

  if (!type || !prompt) return null;

  switch (type) {
    case "GUESS_POET":
      return workVersion?.author ?? null;
    case "GUESS_TITLE":
      return workVersion?.title ?? null;
    case "COMPLETE_NEXT": {
      const lines = workVersion?.lines ?? [];
      const idx = lines.findIndex((l) => l === prompt);
      if (idx < 0 || idx + 1 >= lines.length) return null;
      return lines[idx + 1];
    }
    default:
      return null;
  }
}

export class SimulatedProvider implements QuestionProvider {
  readonly name = SIMULATED_PROVIDER_NAME;
  readonly version = SIMULATED_PROVIDER_VERSION;

  /** 注入故障（测试用）：按 taskId 关键字触发 TRANSIENT 错误，模拟网络抖动 */
  constructor(private readonly failTransient?: (input: ProviderInput) => boolean) {}

  async invoke(input: ProviderInput): Promise<ProviderOutput> {
    // 模拟瞬时故障（仅测试注入）：不产出任何结果
    if (this.failTransient?.(input)) {
      return {
        ok: false,
        payload: {},
        tokensUsed: 0,
        providerVersion: SIMULATED_PROVIDER_VERSION,
        error: { kind: "TRANSIENT", message: "simulated transient failure" },
      };
    }

    const { stage } = input;
    let payload: Record<string, unknown>;

    switch (stage) {
      case "REVIEW": {
        const independentAnswer = deriveAnswerFromEvidence(input);
        payload = {
          independentAnswer: independentAnswer ?? "",
          /** 模拟审核同样执行注入特征识别（双保险）：facts 中含外部原文时 */
          injectionDetected:
            typeof factsExternalText(input) === "string" &&
            detectInjection(factsExternalText(input) as string),
        };
        break;
      }
      case "REVISE": {
        // 确定性修订：按 issue 处理
        const issues = (input.facts.issues ?? []) as Array<{ code: string }>;
        const currentOptions = (input.facts.options ?? []) as string[];
        const correct = input.facts.correct as string | undefined;
        const seed = input.seed ?? 1;
        const type = input.facts.questionType as string | undefined;
        const workVersion = input.facts.workVersion as
          | { title?: string; author?: string; lines?: string[] }
          | undefined;
        const lines = workVersion?.lines ?? [];

        if (issues.some((i) => i.code === "DUPLICATE_OPTION") ||
            issues.some((i) => i.code === "OPTION_TYPE_MISMATCH")) {
          // 重新取干扰项（不改变正确答案与来源事实）
          const pool = (input.facts.distractorPool ?? []) as string[];
          let candidates = [...new Set([...currentOptions, ...pool].filter(Boolean))]
            .filter((v) => v !== correct);
          // 按题型剔除不合规干扰项（混入的异类选项）
          const lineish = (s: string) =>
            /[，。！？]/.test(s) ||
            s.replace(/[\s，。！？]/g, "").length >= 5;
          if (type === "GUESS_POET") candidates = candidates.filter((v) => !lineish(v));
          if (type === "COMPLETE_NEXT") {
            candidates = candidates.filter(
              (v) => lines.includes(v) || lineish(v),
            );
          }
          const shuffled = deterministicShuffle(candidates, seed);
          payload = {
            options: [correct, ...shuffled.slice(0, 3)],
            reason: "重取干扰项（不改来源事实）",
          };
        } else {
          // 无法确定性修复的 issue → 明确失败，交由待核验（不假装通过）
          return {
            ok: false,
            payload: {},
            tokensUsed: 0,
            providerVersion: SIMULATED_PROVIDER_VERSION,
            error: {
              kind: "PERMANENT",
              message: `模拟修订器无法处理 issue: ${issues.map((i) => i.code).join(",")}`,
            },
          };
        }
        break;
      }
      default:
        return {
          ok: false,
          payload: {},
          tokensUsed: 0,
          providerVersion: SIMULATED_PROVIDER_VERSION,
          error: {
            kind: "PERMANENT",
            message: `模拟 provider 不支持阶段 ${stage}（命题为模板执行器，不走 provider）`,
          },
        };
    }

    return {
      ok: true,
      payload,
      tokensUsed: estimateTokens(payload),
      providerVersion: SIMULATED_PROVIDER_VERSION,
    };
  }
}

/** 取 facts 中的外部原始文本（仅用于注入识别，不作为指令） */
function factsExternalText(input: ProviderInput): string | undefined {
  const t = input.facts.externalRawText;
  return typeof t === "string" ? t : undefined;
}

/** 确定性洗牌（mulberry32 内联，避免跨模块依赖） */
function deterministicShuffle<T>(items: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
