import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "谜盒 · 万物皆可猜",
  description: "从名句猜诗词、从作品猜演员、从描述猜万物",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased bg-zinc-50 text-zinc-900 min-h-dvh">
        {children}
      </body>
    </html>
  );
}
