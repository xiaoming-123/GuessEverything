import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 生产验收使用独立目录，避免与正在预览的 dev 服务互相覆盖构建产物。
  distDir: process.env.NEXT_BUILD_DIR || ".next",
};

export default nextConfig;
