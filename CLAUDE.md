# CLAUDE.md · 谜盒（GuessEverything）项目规约

> 一句话：开放数据零版权 + 纯函数逻辑层 + 接口层混合加密的轻量猜谜游戏。

## 技术栈

- Next.js 15（App Router）+ React 19 + TypeScript（strict）
- Tailwind CSS v4 · Zustand（客户端状态）
- PostgreSQL + Prisma ORM
- 测试：Vitest（核心逻辑层强制单测覆盖）

## 架构铁律

1. **`src/lib/games/` 是纯逻辑层**：出题引擎、干扰项、计分等全部为纯函数。
   - 禁止 import：`next/*`、`@prisma/client`、`react`、任何 IO。
   - 语料/随机数/配置一律通过参数注入，保证可单测、可移植小程序。
2. **答案永不下发**：任何 API 响不得包含 `answerIndex`/答案字段；判题只在服务端完成（`src/lib/db/session-service.ts`）。
3. **接口层加密**：业务 Route Handler 一律用 `withCrypto` 包装（`src/lib/crypto/with-crypto.ts`），业务代码全程操作明文对象，禁止在业务层触碰加解密。唯一明文接口是 `GET /api/crypto/key`。
4. **防作弊**：会话 TTL 过期作废、nonce 防重放、时间戳校验，均在加密层统一处理，业务层不重复实现。

## 目录约定

```
src/
  app/                 # 页面 + Route Handlers（薄壳，只做编排）
    api/crypto/key/    # 密钥交换（唯一明文接口）
    api/games/poetry/  # 出题 / 判题（withCrypto 包装）
    play/poetry/       # 诗词玩法页
  lib/
    crypto/            # 加密层：protocol(共享类型) keys nonce session-keys with-crypto
    games/poetry/      # 纯逻辑层：types engine distractors score（零依赖）
    db/                # Prisma 单例 + 仓储 + 会话服务（业务编排）
    data/              # 语料种子 JSON
  store/               # Zustand 客户端状态
tests/                 # 与 src 结构镜像的单测
prisma/                # schema.prisma
```

## 代码风格

- 注释与用户可见文案使用中文；标识符使用英文。
- 服务端错误统一抛 `ApiError(status, message)`（业务）或 `CryptoError(code, message)`（加密层）。
- 新增玩法（演员/物品/飞花令）按 `lib/games/<mode>/` 建纯逻辑模块 + `lib/db/<mode>-service.ts` 编排 + `app/api/games/<mode>/` 路由。

## 常用命令

```bash
npm run dev        # 开发（Turbopack）
npm test           # Vitest 单测
npm run lint       # ESLint
npm run db:push    # Prisma 同步 schema 到数据库
npm run build      # 生产构建验证
```

## 环境变量

见 `.env.example`：`DATABASE_URL`（必填，跑 DB 时）、`CRYPTO_RSA_PRIVATE_KEY`（生产必填，本地可省略自动生成）。

## 数据合规红线

- 题库数据仅使用公版内容 / MIT 协议开源数据集 / 开放 API。
- 演员题只允许纯文字描述，禁止肖像与剧照。
