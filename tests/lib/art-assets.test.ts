/**
 * 美术资产常量表形状断言（详设 §6 红线：美术引用只走 art-assets 常量表）
 * 阶段 6：COVER_ART 指向 v2（叠标题版）。
 */
import { describe, expect, it } from "vitest";
import {
  COVER_ART,
  EXTRA_NPC_AVATARS,
  HERO_AVATARS,
  NPC_AVATARS,
  heroAssetKey,
  npcExpressionAsset,
} from "@/lib/art-assets";

describe("art-assets 常量表", () => {
  it("COVER_ART 指向 /art/ 下 v2 封面", () => {
    expect(COVER_ART.startsWith("/art/")).toBe(true);
    expect(COVER_ART).toBe("/art/cover_v2.png");
  });

  it("11 阶主角立绘齐全且路径合法", () => {
    for (let i = 0; i <= 10; i++) {
      expect(HERO_AVATARS[i]).toMatch(/^\/art\/q_hero_rank\d{2}_\w+\.png$/);
    }
    expect(Object.keys(HERO_AVATARS)).toHaveLength(11);
  });

  it("NPC 立绘与表情集路径合法；皇帝无表情图回退 null", () => {
    for (const v of Object.values(NPC_AVATARS)) {
      expect(v.startsWith("/art/")).toBe(true);
    }
    expect(npcExpressionAsset("TUTOR", "happy")).toMatch(/^\/art\/q_expr_tutor_happy\.png$/);
    expect(npcExpressionAsset("EXAMINER", "sad")).toMatch(/^\/art\/q_expr_examiner_sad\.png$/);
    expect(npcExpressionAsset("EMPEROR", "happy")).toBeNull();
  });

  it("P2 三 NPC 立绘齐全", () => {
    expect(Object.keys(EXTRA_NPC_AVATARS)).toHaveLength(3);
    for (const v of Object.values(EXTRA_NPC_AVATARS)) {
      expect(v.startsWith("/art/")).toBe(true);
    }
  });

  it("heroAssetKey 与文件命名一致", () => {
    expect(HERO_AVATARS[0]).toContain(heroAssetKey(0));
    expect(HERO_AVATARS[10]).toContain(heroAssetKey(10));
    expect(heroAssetKey(99)).toBe("unknown");
  });
});
