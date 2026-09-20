"use client";

/**
 * 匿名玩家状态（Zustand + localStorage）
 *
 * 首次进入自动注册（服务端分配昵称/头像），持久化 playerId。
 * 本分支只保留诗词升官玩法：功名 / 官阶权威数据来自服务端 RankView / RankSummary，
 * 本 store 只持有玩家身份（playerId / 昵称 / 头像）。
 */

import { create } from "zustand";

import { secureFetch } from "@/lib/crypto/secure-fetch";

interface PlayerProfile {
  id: string;
  nickname: string;
  avatar: string;
}

const STORAGE_KEY = "mihe.player.v1";

interface PlayerStore {
  playerId: string | null;
  nickname: string;
  avatar: string;
  /** 首次访问自动注册；幂等可重复调用 */
  ensurePlayer: () => Promise<void>;
  /** 拉取最新档案（昵称） */
  refreshProfile: () => Promise<void>;
  /** 改昵称（2-12 字符） */
  rename: (nickname: string) => Promise<void>;
}

function loadLocal(): { playerId: string | null } {
  if (typeof window === "undefined") return { playerId: null };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { playerId: null };
    const p = JSON.parse(raw) as { playerId?: string };
    return { playerId: p.playerId ?? null };
  } catch {
    return { playerId: null };
  }
}

/** 同步读取本地缓存的玩家 ID（开局提速用，不等注册网络往返） */
export function localPlayerId(): string | null {
  return loadLocal().playerId;
}

function saveLocal(playerId: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ playerId }));
  } catch {
    /* 隐私模式下忽略 */
  }
}

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  playerId: null,
  nickname: "",
  avatar: "👤",

  ensurePlayer: async () => {
    const { playerId } = get();
    if (playerId) return;
    const local = loadLocal();
    try {
      const profile = await secureFetch<PlayerProfile>("/api/player", {
        playerId: local.playerId ?? undefined,
      });
      saveLocal(profile.id);
      set({
        playerId: profile.id,
        nickname: profile.nickname,
        avatar: profile.avatar,
      });
    } catch {
      // DB 不可用（本地内存模式）/ 网络失败：匿名玩家档案是增强能力，
      // 不应阻断对局——开局不带 playerId 即可，后续重试由再次调用负责
    }
  },

  refreshProfile: async () => {
    const { playerId } = get();
    if (!playerId) return;
    try {
      const profile = await secureFetch<PlayerProfile>("/api/player", { playerId }, "PUT");
      set({
        nickname: profile.nickname,
        avatar: profile.avatar,
      });
    } catch {
      /* 档案刷新失败不打断对局 */
    }
  },

  rename: async (nickname: string) => {
    const { playerId } = get();
    if (!playerId) throw new Error("玩家未初始化");
    const profile = await secureFetch<PlayerProfile>(
      "/api/player",
      { playerId, nickname },
      "PATCH",
    );
    set({ nickname: profile.nickname });
  },
}));
