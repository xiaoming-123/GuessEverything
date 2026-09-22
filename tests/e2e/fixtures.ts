import {
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  constants,
} from "node:crypto";
import type { Page } from "@playwright/test";
import { RANKS } from "../../src/lib/games/poetry/rank";
import type { RankView } from "../../src/lib/db/rank-service";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export function makeRank(rankId = 0): RankView {
  return {
    rankId,
    label: RANKS[rankId].label,
    subtitle: RANKS[rankId].subtitle,
    totalExp: rankId ? 156000 : 1200,
    expToNext: rankId ? 0 : 800,
    nextUnlocked: rankId > 0,
    ranks: RANKS.map((r) => ({
      rankId: r.id,
      key: r.key,
      label: r.label,
      subtitle: r.subtitle,
      isEmperor: !!r.isEmperor,
    })),
    seenCount: 156,
    recentGames: [{ kind: "PRACTICE", expGained: 230, accuracy: 80 }],
    badges: ["FIRST_PRACTICE", "COMBO_3"],
    corpusTotal: 600,
    daily: {
      cells: Array.from({ length: 42 }, (_, i) =>
        i < 5 || i > 35
          ? null
          : {
              date: `2026-08-${String(i - 4).padStart(2, "0")}`,
              state: i % 3 ? "done" : "missing",
            },
      ),
      weeksCompleted: 2,
      weeklyBonus: 200,
      makeupLeft: 1,
    },
    guess: rankId < 8 ? { done: false } : null,
    event: null,
    skins: { owned: [], equipped: null },
  };
}

export async function mockGame(
  page: Page,
  options: {
    rankId?: number;
    event?: boolean;
    promoted?: boolean;
    longQuestion?: boolean;
    longOptions?: boolean;
    failRank?: boolean;
    failKeyOnce?: boolean;
    resume?: boolean;
  } = {},
) {
  const rank = makeRank(options.rankId);
  const requests: string[] = [];
  let answered = 0;
  let failKey = !!options.failKeyOnce;
  let key: Buffer | null = null;
  const rounds = Array.from({ length: 3 }, (_, i) => ({
    roundIndex: i,
    type: i ? "GUESS_TITLE" : "GUESS_POET",
    prompt: options.longQuestion
      ? "君不见黄河之水天上来，奔流到海不复回。".repeat(12)
      : "长风破浪会有时，直挂云帆济沧海。",
    options: i
      ? [
          "酬乐天扬州初逢席上见赠",
          "闻王昌龄左迁龙标遥有此寄",
          "白雪歌送武判官归京",
          "行路难·其一",
        ]
      : ["李白", "杜甫", "白居易", "王维"],
  }));
  if (options.longOptions)
    rounds[0].options = rounds[0].options.map(
      (text) => `${text}：${"长风破浪会有时，直挂云帆济沧海。".repeat(12)}`,
    );
  const poemItems = Array.from({ length: 31 }, (_, i) => ({
    title: i === 0 ? "酬乐天扬州初逢席上见赠" : `诗稿第${i + 1}卷`,
    poet: "刘禹锡",
    dynasty: "唐",
    grade: 8,
    mastered: i % 2 === 0,
    seenAt: "2026-09-22",
    lines: Array(30).fill("沉舟侧畔千帆过，病树前头万木春。"),
  }));
  if (options.event)
    rank.event = {
      id: "MOON",
      name: "诗月圆",
      tagline: "诗月正圆",
      expMultiplier: 1.2,
      endsAt: Date.now() + 3600000,
    } as RankView["event"];
  await page.addInitScript(() =>
    localStorage.setItem("rebirth-prologue:v1", "1"),
  );
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    requests.push(path);
    if (path === "/api/crypto/key") {
      if (failKey) {
        failKey = false;
        return route.fulfill({ status: 503, json: {} });
      }
      return route.fulfill({
        json: {
          sessionId: "ui-session",
          publicKey: keys.publicKey
            .export({ type: "spki", format: "der" })
            .toString("base64"),
        },
      });
    }
    if (route.request().method() === "GET") {
      if (path.endsWith("/rank"))
        return route.fulfill(
          options.failRank ? { status: 503, json: {} } : { json: rank },
        );
      if (path.endsWith("/gallery")) {
        const p = Number(url.searchParams.get("page")),
          size = Number(url.searchParams.get("pageSize"));
        return route.fulfill({
          json: {
            total: 31,
            items: poemItems.slice((p - 1) * size, p * size),
            byDynasty: [{ dynasty: "唐", count: 31 }],
            byGrade: [{ grade: 8, count: 31 }],
          },
        });
      }
      if (path.endsWith("/ledger"))
        return route.fulfill({
          json: {
            ...rank,
            recentBars: Array.from({ length: 10 }, (_, i) => ({
              kind: "PRACTICE",
              exp: i * 30,
            })),
          },
        });
      if (path.endsWith("/leaderboard"))
        return route.fulfill({
          json: {
            items: Array.from({ length: 40 }, (_, i) => ({
              name: i ? `诗友第${i}位` : "李白",
              avatar: "诗",
              totalExp: 10000,
              seasonExp: 8000 - i * 10,
              rankLabel: i ? "举人" : "皇帝",
              isVirtual: !i,
            })),
            season: "2026-Q3",
            seasonLabel: "2026 年第三季度",
            my: {
              rankLabel: rank.label,
              totalExp: 1200,
              seasonExp: 1200,
              aboveCount: 32,
            },
            past: [
              {
                seasonKey: "2026-Q2",
                label: "2026 年第二季度",
                rankLabel: "布衣",
                seasonExp: 20,
              },
            ],
          },
        });
      return route.fulfill({ status: 404, json: {} });
    }
    const envelope = route.request().postDataJSON();
    if (envelope.key)
      key = privateDecrypt(
        {
          key: keys.privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(envelope.key, "base64"),
      );
    if (!key) throw new Error("测试请求未建立加密会话");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const body = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64")),
        decipher.final(),
      ]).toString(),
    );
    let result: unknown = {};
    const session = {
      gameSessionId: "game-ui",
      kind: "PRACTICE",
      rankId: rank.rankId,
      label: rank.label,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      rank,
      rounds,
      persona: "TUTOR",
      opening: "这一卷，由你落笔。",
      event: null,
    };
    if (path === "/api/player")
      result = { id: "ui-player", nickname: "一卷新生", avatar: "诗" };
    if (path.endsWith("/resume") && options.resume)
      result = { ...session, answeredIndexes: [0], score: 100, hint: null };
    if (path.endsWith("/start")) {
      answered = 0;
      result = { ...session, kind: body.kind };
    }
    if (path.endsWith("/answer")) {
      answered++;
      result = {
        correct: body.choice === 0,
        timeout: !!body.timeout,
        correctAnswer: rounds[body.roundIndex].options[0],
        explanation: "诗句写出了诗人不畏艰难的志向。",
        feedback: "诗句写出了诗人不畏艰难的志向。".repeat(5),
        gained: 100,
        totalScore: answered * 100,
        multiplier: 1,
        summary:
          answered === rounds.length
            ? {
                kind: "PRACTICE",
                rankId: rank.rankId,
                correctCount: 2,
                totalRounds: 3,
                accuracy: 67,
                stars: 2,
                expGained: 300,
                totalExp: 1500,
                promotion: {
                  promoted: !!options.promoted,
                  newRank: options.promoted ? rank.rankId + 1 : rank.rankId,
                  reason: options.promoted ? "PROMOTED" : "KIND_NOT_EXAM",
                },
                rank: options.promoted ? makeRank(rank.rankId + 1) : rank,
                settleLine: "这一卷，积下的不只是功名。",
                newBadges: ["FIRST_PRACTICE", "COMBO_3", "SEEN_100"],
                hintUsed: false,
                event: null,
              }
            : null,
      };
    }
    if (path.endsWith("/hint")) result = { removedIndexes: [2, 3] };
    if (path.endsWith("/guess")) {
      rank.guess = { done: true, correct: true, gained: 100 };
      result = { correct: true, gained: 100, todayUsed: true };
    }
    if (path.endsWith("/makeup")) rank.daily.makeupLeft = 0;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(result), "utf8"),
      cipher.final(),
    ]);
    return route.fulfill({
      json: {
        v: 1,
        sessionId: "ui-session",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ts: Date.now(),
        data: data.toString("base64"),
      },
    });
  });
  return { rank, requests };
}
