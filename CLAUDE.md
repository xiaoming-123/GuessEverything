# CLAUDE.md · 谜盒（GuessEverything）项目规约

> 一句话：开放数据零版权 + 纯函数逻辑层 + 接口层混合加密的轻量猜谜游戏。
> 本分支（feature/poetry-rank）**只保留诗词升官玩法**（布衣 → 11 阶官衔 + 皇帝登极大考，架空称号路线）；
> 智能体题库引擎为纯基础设施（非玩法），代码在本分支内。

## 技术栈

- Next.js 15（App Router）+ React 19 + TypeScript（strict）
- Tailwind CSS v4 · Zustand（客户端状态）
- 嵌入式 SQLite（单文件库，零运维）+ Prisma ORM
- 测试：Vitest（核心逻辑层强制单测覆盖）

## 架构铁律

1. **`src/lib/games/` 是纯逻辑层**：出题引擎、官阶体系、晋级结算、计分等全部为纯函数。
   - 禁止 import：`next/*`、`@prisma/client`、`react`、任何 IO。
   - 语料/随机数/配置一律通过参数注入，保证可单测、可移植小程序。
2. **答案永不下发**：任何 API 响应不得包含 `answerIndex`/答案字段；判题只在服务端完成（`src/lib/db/rank-service.ts`）。
3. **接口层加密**：业务 Route Handler 一律用 `withCrypto` 包装（`src/lib/crypto/with-crypto.ts`），业务代码全程操作明文对象，禁止在业务层触碰加解密。唯一明文接口是 `GET /api/crypto/key`。
4. **防作弊**：会话 TTL 过期作废、nonce 防重放、时间戳校验，均在加密层统一处理，业务层不重复实现；
   官阶 / 功名门禁（研习限当前官阶、科考目标必须 = 当前 + 1、功名不达门槛拒绝）在服务端强制。

## 目录约定

```
src/
  app/                 # 页面 + Route Handlers（薄壳，只做编排）
    api/crypto/key/    # 密钥交换（唯一明文接口）
    api/player/        # 匿名玩家档案（注册 / 改昵称）
    api/games/poetry/rank/  # 诗词升官：start / answer / 官阶视图 / resume（withCrypto 包装）
    play/poetry-rank/  # 诗词升官官途页（路线图 / 功名条 / 研习与科考入口）
  lib/
    crypto/            # 加密层：protocol(共享类型) keys nonce session-keys with-crypto
    games/poetry/      # 诗词升官纯逻辑层：types engine rank capacity promote score（零依赖）
    games/             # 共享纯函数：stages / timing / sampling
    question-bank/     # 智能体题库引擎（基础设施）：contracts / pipeline / validators / providers / infra
    db/                # Prisma 单例 + 仓储 + rank-service（业务编排）
    data/              # 诗词语料种子 JSON
  store/               # Zustand 客户端状态（player-store 身份 + rank-store 官途对局）
tests/                 # 与 src 结构镜像的单测
prisma/                # schema.prisma + 幂等种子脚本
```

## 代码风格

- 注释与用户可见文案使用中文；标识符使用英文。
- 服务端错误统一抛 `ApiError(status, message)`（业务）或 `CryptoError(code, message)`（加密层）。
- 新增玩法须另行开分支，**本分支不引入其他玩法模式**；玩法内演进（每日题 DAILY、语料扩容）在本分支继续。

## 常用命令

```bash
npm run dev        # 开发（Turbopack）
npm test           # Vitest 单测
npm run lint       # ESLint
npm run db:push    # Prisma 同步 schema 到数据库
npm run db:seed    # 导入诗词语料种子（幂等）
npm run build      # 生产构建验证
```

## 环境变量

见 `.env.example`：`DATABASE_URL`（必填，跑 DB 时）、`CRYPTO_RSA_PRIVATE_KEY`（生产必填，本地可省略自动生成）。

## 数据合规红线

- 题库数据仅使用公版内容 / MIT 协议开源数据集 / 开放 API。
