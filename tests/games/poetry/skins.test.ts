/**
 * 皮肤系统纯逻辑单测（P3 详设 §1.6）
 */
import { describe, expect, it } from "vitest";
import {
  SKINS,
  SKIN_BY_KEY,
  canEquipSkin,
  skinsUnlockedByBadges,
} from "@/lib/games/poetry/skins";
import { SKIN_ASSETS, heroAssetFor, HERO_AVATARS } from "@/lib/art-assets";
import { isRankId } from "@/lib/games/poetry/rank";

describe("SKINS 表形状", () => {
  it("key 唯一", () => {
    const keys = SKINS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("rankId 合法且首批仅 ACHIEVEMENT 解锁型", () => {
    for (const s of SKINS) {
      expect(isRankId(s.rankId)).toBe(true);
      expect(s.unlock.type).toBe("ACHIEVEMENT");
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.desc.length).toBeGreaterThan(0);
    }
  });

  it("SKIN_BY_KEY 与 SKINS 同步", () => {
    expect(SKIN_BY_KEY.size).toBe(SKINS.length);
    for (const s of SKINS) expect(SKIN_BY_KEY.get(s.key)).toBe(s);
  });

  it("每件皮肤都有资产且路径合法", () => {
    for (const s of SKINS) {
      expect(SKIN_ASSETS[s.key]).toMatch(/^\/art\/q_skin_\w+\.png$/);
    }
  });
});

describe("skinsUnlockedByBadges", () => {
  it("EMPEROR 达成 → 解锁 DRAGON_GOLD", () => {
    expect(skinsUnlockedByBadges(["EMPEROR"], [])).toEqual(["DRAGON_GOLD"]);
  });

  it("已拥有不重复解锁", () => {
    expect(skinsUnlockedByBadges(["EMPEROR"], ["DRAGON_GOLD"])).toEqual([]);
  });

  it("无关 badge 不解锁", () => {
    expect(skinsUnlockedByBadges(["FIRST_PRACTICE", "ALL_CORRECT"], [])).toEqual([]);
  });

  it("空 badge 不解锁", () => {
    expect(skinsUnlockedByBadges([], [])).toEqual([]);
  });
});

describe("canEquipSkin", () => {
  it("拥有 + rank 匹配 → 可穿", () => {
    expect(canEquipSkin("DRAGON_GOLD", ["DRAGON_GOLD"], 10)).toBe(true);
  });

  it("未拥有 → 拒", () => {
    expect(canEquipSkin("DRAGON_GOLD", [], 10)).toBe(false);
  });

  it("rank 不匹配 → 拒（皇帝皮肤非皇帝阶不可穿）", () => {
    expect(canEquipSkin("DRAGON_GOLD", ["DRAGON_GOLD"], 9)).toBe(false);
    expect(canEquipSkin("DRAGON_GOLD", ["DRAGON_GOLD"], 0)).toBe(false);
  });

  it("未知 key → 拒", () => {
    expect(canEquipSkin("NOT_EXIST", ["NOT_EXIST"], 10)).toBe(false);
  });
});

describe("heroAssetFor 穿戴渲染", () => {
  it("rank 10 + 穿戴皮肤 → 皮肤资产", () => {
    expect(heroAssetFor(10, "DRAGON_GOLD")).toBe(SKIN_ASSETS.DRAGON_GOLD);
  });

  it("rank 10 未穿戴 → 默认皇帝立绘", () => {
    expect(heroAssetFor(10, null)).toBe(HERO_AVATARS[10]);
  });

  it("rank 不匹配（脏数据）→ 回退默认立绘", () => {
    expect(heroAssetFor(5, "DRAGON_GOLD")).toBe(HERO_AVATARS[5]);
  });

  it("未知皮肤 key（脏数据）→ 回退默认立绘", () => {
    expect(heroAssetFor(10, "GHOST_SKIN")).toBe(HERO_AVATARS[10]);
  });

  it("全 11 阶默认立绘均可取", () => {
    for (let i = 0; i <= 10; i++) {
      expect(heroAssetFor(i, null)).toBe(HERO_AVATARS[i]);
    }
  });
});
