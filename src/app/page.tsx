import Link from "next/link";
import { COVER_ART } from "@/lib/art-assets";

const modes = [
  {
    href: "/play/poetry-rank",
    title: "诗词升官",
    desc: "布衣 → 11 阶官衔 + 皇帝登极大考 · 研习积功名 · 科考擢升",
    emoji: "🎓",
    ready: true,
  },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      {/* 封面卡（阶段 6：标题已叠入图内，不再重复大标题） */}
      <header className="mb-10">
        {/* eslint-disable-next-line @next/next/no-img-element -- 本地静态封面，无需 next/image 优化 */}
        <img
          src={COVER_ART}
          alt="谜盒 · 诗词升官 游戏封面"
          className="w-full rounded-2xl border border-zinc-200 shadow-md"
        />
        <p className="mt-4 text-center text-zinc-500">
          诗词升官 · 连击翻倍 · 碎片开一局
        </p>
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

      <footer className="mt-10 text-center text-xs text-zinc-400">
        接口层混合加密 · 答案永不下发
      </footer>
    </main>
  );
}
