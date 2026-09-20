# 谜盒（GuessEverything）

> 万物皆可猜 · 开放数据零版权 · 纯函数逻辑层 · 接口层混合加密的轻量猜谜游戏

谜盒是一个基于公版语料的在线猜谜游戏，内置 **诗词 / 演员 / 物品 / 飞花令 / 诗词升官** 五种玩法，
搭配「三关闯关 + 匿名排行榜 + 战绩分享卡片」的成长闭环。
核心设计坚持三条红线：**答案永不下发**、**全接口混合加密**、**题库只用公版 / 开放数据**。

## 玩法一览

| 玩法 | 题型 | 关卡 |
| --- | --- | --- |
| 📜 诗词猜猜 | 名句猜诗人 · 猜诗名 · 上句补下句 | 小学必背 / 初中 / 高中 |
| 🎬 演员猜猜 | 代表作 + 经典角色，纯文字（无肖像剧照） | 入门 / 进阶 / 骨灰 |
| 🎁 物品猜猜 | 线索层层递进 · 公版民间谜语 | 入门 / 进阶 / 骨灰 |
| 🌸 飞花令 | 含字寻句 · 无字挑白 · 据句猜令 | 入门 / 进阶 / 骨灰 |
| 🎓 诗词升官 | 研习 / 科考 · 每局 10 题（皇帝登极大考 15 题） | 布衣 → 11 阶官衔 + 皇帝 |

**统一规则**：每局 10 题、每题 15 秒倒计时（超时按答错）；
答对得基础分 × 连击倍率（最高 2.0×）+ 速度奖励；
正确率 ≥60% 通关，60 / 80 / 95% 对应 1 / 2 / 3 星；
通过第 n 关解锁第 n+1 关。

## 本分支进行中（feature/poetry-rank）

诗词升官已打通「纯逻辑 + 数据层 + 前端 + 浏览器验收」全链路（可玩）：

**诗词升官**（诗词猜猜的晋升线：布衣 → 11 阶官衔 + 皇帝登极大考，架空称号路线）
- 已完成：官阶体系 `rank.ts`、容量核算 `capacity.ts` + 审计脚本、晋级结算 `promote.ts`；
  语料 48 首（批次 1 新增 5 首，结构审计 + 人工核验均通过）；
  容量结论：100% 正确率全路径需约 805 题，当前题面 693，缺口 112，瓶颈在 g10–12 窗口
- 已完成（阶段 B 数据层 + API）：PlayerRank / PlayerSeenKey 持久化（已见 sourceKey + faceKey
  双维度，重启不遗忘）、事务选题（并发冲突换种子重试）、一次性结算（settleKey 原子占位，
  重复结算不加分）、晋升再校验（纯函数复用，客户端不得指定任意级别）、
  `POST /api/games/poetry/rank/start|answer` + `GET /api/games/poetry/rank`；
  集成测试 16/16（并发不重复 / 重启不遗忘 / 重复结算不加分 / 无资格被拒 / 旧存档保留）
- 已完成（阶段 C 前端 + 浏览器验收）：官途页 `/play/poetry-rank`（路线图 / 功名条 / 研习与科考入口 /
  失败重考 / 缺题提示）、Zustand 官途状态（答案永不下发）、刷新恢复 `POST /api/games/poetry/rank/resume`
  （ACTIVE 且未超时会话从首个未答题续答）、判题解释（服务端生成出处，客户端无 meta）、首页入口；
  真实浏览器验收 15/15（首次晋升 / 刷新恢复 / 移动布局 / 科考门禁）
- 未开始：每日题（DAILY，服务端已拒绝，前端无入口）；语料批次 2（前置：可核验来源文本，
  g10–12 需补 ≥112 题面）；皇帝大考容量复验（待批次 2 后）

设计与审计文档见 [docs/design/](docs/design/)。

## 技术栈

- **Next.js 15**（App Router + Turbopack）· **React 19** · **TypeScript strict**
- **Tailwind CSS v4** · **Zustand**（客户端状态）
- **嵌入式 SQLite + Prisma ORM**（单文件零运维，含内存兜底）
- **Vitest** 单测（纯逻辑层全覆盖）+ Node 冒烟脚本（HTTP 闭环）

## 架构

项目分三层，边界严格：

```
src/
  app/                 # 页面 + Route Handlers（薄壳，只做编排）
    api/crypto/key/    # 密钥交换（唯一明文接口）
    api/games/<mode>/  # 各玩法 出题 / 判题（withCrypto 包装）
    play/<mode>/       # 各玩法页
  lib/
    crypto/            # 加密层：protocol / keys / nonce / session-keys / with-crypto / secure-fetch
    games/<mode>/      # 纯逻辑层：engine / distractors / score / types（零依赖纯函数）
    games/poetry/      # 诗词升官（在建）：rank 官阶 / capacity 容量 / promote 晋级结算
    db/                # Prisma 单例 + 仓储 + 会话服务（业务编排）
    data/              # 语料种子 JSON（诗词 48 首 + 候选审计）
  store/               # Zustand 客户端状态（每模式独立）
tests/                 # 与 src 结构镜像的单测
prisma/                # schema.prisma + 幂等种子脚本
scripts/               # 审计与演示脚本（诗词容量 / 语料审计）
docs/                  # 设计、审计与调研报告
```

1. **纯逻辑层**（`lib/games/`）：出题引擎、干扰项、计分全部为零依赖纯函数，
   语料 / 随机数 / 配置一律参数注入，保证可单测、可移植小程序。
   禁止 import `next/*`、`@prisma/client`、`react` 或任何 IO。
2. **加密层**（`lib/crypto/`）：业务 Route Handler 一律用 `withCrypto` 包装，
   业务代码全程操作明文对象；客户端用 `secureFetch` 对称封装。
3. **数据层**（`lib/db/`）：Prisma 单例 + 会话服务编排，DB 不可用时自动回退内存存储。

### 接口层混合加密

- 客户端生成 **AES-256** 会话密钥，经服务端 **RSA-2048-OAEP-SHA256** 公钥封装，仅随首个请求下发；
- 每个请求用 **AES-256-GCM** 加密（IV / authTag / 密文分离）；
- **防重放**：`ts` 时间戳（±2 分钟时效）+ `nonce` 一次性随机数；
- 唯一明文接口是 `GET /api/crypto/key`（密钥交换）。

### 防作弊

- **答案永不下发**：服务端轮次数据含答案，下发前剥离，判题只读数据库比对；
- 会话 10 分钟 TTL，过期作废；重复判题拦截；
- 关卡解锁在服务端强制校验；答题耗时服务端钳位，速度分不可伪造。

## 数据合规红线

- 题库仅使用**公版内容 / MIT 协议开源数据集 / 开放 API**（诗词语料抽取自 chinese-poetry）；
- **演员题只允许纯文字描述，禁止肖像与剧照**。

## 快速开始

### 1. 环境要求

- Node.js ≥ 18（含 WebCrypto）
- 无需安装数据库：嵌入式 SQLite 单文件，首次 `db:push` 自动创建；也可以完全不落库（内存兜底模式）

### 2. 安装与配置

```bash
npm install            # 安装依赖（postinstall 自动 prisma generate）
cp .env.example .env   # 按需填写 DATABASE_URL / CRYPTO_RSA_PRIVATE_KEY
```

环境变量见 [.env.example](.env.example)：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | SQLite 文件路径，如 `file:./data/app.db`（相对 `prisma/` 目录解析） |
| `CRYPTO_RSA_PRIVATE_KEY` | RSA 私钥（PKCS#8 PEM，`\n` 转义）；本地可省略自动生成，**生产必填** |
| `USE_MEMORY_DB` | `=1` 强制内存模式，完全不连库（游戏闭环正常，玩家/排行榜不可用） |

### 3. 建库导数据（走真实 DB 时）

```bash
npm run db:push        # Prisma 同步 schema 到数据库
npm run db:seed        # 导入语料种子（幂等，可重复执行）
```

### 4. 启动与验证

```bash
npm run dev            # 开发（http://localhost:3000，Turbopack）
npm test               # Vitest 单测
npm run lint           # ESLint
npm run build          # 生产构建验证
```

> 冒烟测试：先启动服务，再 `node scripts/smoke-client.mjs` 等脚本，
> 模拟加密客户端走完整 HTTP 闭环。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 开发服务器（Turbopack） |
| `npm run build` / `npm run start` | 生产构建 / 启动生产 |
| `npm test` / `npm run test:watch` | 单测（一次性 / 监听） |
| `npm run lint` | ESLint |
| `npm run db:push` | Prisma 同步 schema |
| `npm run db:seed` | 导入语料种子 |
| `npm run db:studio` | Prisma Studio |

## 文档

完整项目规约（架构铁律、目录约定、代码风格、新增玩法指南）见 [CLAUDE.md](CLAUDE.md)。

## License

本项目以 **GPL-3.0** 协议开源（见 [LICENSE](LICENSE)）；题库数据版权归原公版 / 开放数据集所有。
