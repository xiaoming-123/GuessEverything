import Link from "next/link";

const modes = [
  {
    href: "/play/poetry",
    title: "诗词猜猜",
    desc: "名句猜诗人 · 猜诗名 · 上句补下句",
    emoji: "📜",
    ready: true,
  },
  {
    href: "/play/actor",
    title: "演员猜猜",
    desc: "代表作与经典角色，无图纯文字猜猜 TA 是谁",
    emoji: "🎬",
    ready: true,
  },
  {
    href: "/play/object",
    title: "物品猜猜",
    desc: "线索层层递进 · 民间谜语猜万物",
    emoji: "🎁",
    ready: true,
  },
  {
    href: "/play/feihua",
    title: "飞花令",
    desc: "令字辨诗 · 含字寻句 / 无字挑白 / 据句猜令",
    emoji: "🌸",
    ready: true,
  },
];

const stages = [
  { key: "PRIMARY", label: "小学必背" },
  { key: "JUNIOR", label: "初中" },
  { key: "SENIOR", label: "高中" },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <header className="text-center mb-10">
        <h1 className="text-4xl font-bold tracking-wide mb-2">谜盒</h1>
        <p className="text-zinc-500">万物皆可猜 · 连击翻倍 · 碎片开一局</p>
      </header>

      <section className="grid gap-4">
        {modes.map((m) =>
          m.ready ? (
            <Link
              key={m.title}
              href={m.href}
              className="block rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:shadow-md hover:-translate-y-0.5"
            >
              <div className="text-3xl mb-2">{m.emoji}</div>
              <div className="text-lg font-semibold">{m.title}</div>
              <div className="text-sm text-zinc-500 mt-1">{m.desc}</div>
            </Link>
          ) : (
            <div
              key={m.title}
              className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-100 p-5 opacity-60"
            >
              <div className="text-3xl mb-2">{m.emoji}</div>
              <div className="text-lg font-semibold">{m.title}</div>
              <div className="text-sm text-zinc-500 mt-1">{m.desc}</div>
            </div>
          ),
        )}
      </section>

      <Link
        href="/leaderboard"
        className="mt-6 block rounded-2xl border border-amber-300 bg-amber-50 p-5 text-center transition hover:shadow-md"
      >
        <div className="text-lg font-semibold">🏆 排行榜</div>
        <div className="text-sm text-zinc-500 mt-1">看看谁是本关最强猜谜人</div>
      </Link>

      <footer className="mt-10 text-center text-xs text-zinc-400">
        支持学段：{stages.map((s) => s.label).join(" / ")} · 接口层混合加密 · 答案永不下发
      </footer>
    </main>
  );
}
