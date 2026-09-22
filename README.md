# 重生：我靠诗词问鼎天下（GuessEverything）

> 重活一世，以诗词改命。手机单屏诗词成长游戏。

2026-09-22 已完成重生主题与手机适配改版，详见[实施与验收记录](docs/design/2026-09-22-rebirth-implementation-report.md)。平台打包和发布暂不在本次范围。

谜盒是一个基于公版语料的在线猜谜游戏。本分支（feature/poetry-rank）**只保留诗词升官玩法**
（布衣 → 11 阶官衔 + 皇帝登极大考，架空称号路线）。
核心设计坚持三条红线：**答案永不下发**、**全接口混合加密**、**题库只用公版 / 开放数据**。

## 玩法一览

| 玩法 | 题型 | 晋级线 |
| --- | --- | --- |
| 🎓 诗词升官 | 研习 / 科考 · 每局 10 题（皇帝登极大考 15 题），名句猜诗人 / 猜诗名 / 上句补下句 | 布衣 → 11 阶官衔 + 皇帝 |

**统一规则**：每局 10 题、每题 15 秒倒计时（超时按答错）；
答对得基础分 × 连击倍率（最高 2.0×）+ 速度奖励；
正确率 ≥60% 才算科考通过；研习积功名，功名达标解锁更高官阶科考。

## 本分支进行中（feature/poetry-rank）

诗词升官已打通「纯逻辑 + 数据层 + 前端 + 浏览器验收」全链路（可玩）；智能体题库引擎为纯基础设施（非玩法）：

**诗词升官**（布衣 → 11 阶官衔 + 皇帝登极大考，架空称号路线）
- 已完成（D0-D6 + UI 打磨 + P2 三期 + 阶段 6 + P3 两期）：人设对话系统 / 每日题 + 周奖 + 补签 + 10 成就 + 功名簿 /
  诗词阁 + 选字填空与朝代配对新题型 / 问同窗 + 剪影竞猜 / 美术资产全量入库（11 阶立绘 + NPC 表情）/ 皇榜 /
  语料扩容批次 2（176 首 · 3403 题面 · 五朝代，D0 门槛全达成）/ 限时事件框架（诗月圆 · 钦天大比）/
  分享卡（结算 canvas 长图）/ 封面 v2（楷体真实标题层）+ 首页接入 / 外观皮肤系统（衣冠页 + 皇帝金边龙袍）/
  赛季化皇榜（季度赛季键 + SeasonBoard 惰性定格，官阶与累计功名常青不清零）
- 实施顺序阶段 1-6 + P3 全部闭环（2026-09-21）
- 后续：皮肤资产批量上新（EVENT/EXCHANGE 解锁接口位已留）；赛季专属奖励联动

**智能体题库引擎**（P0/P1 完成，基础设施非玩法）
- 已完成：`src/lib/question-bank/` 的 compose / review / publish 管线、结构化评审、
  批次级幂等任务队列、崩溃恢复与回滚；题库单测 74/74、隔离库端到端演示 9/9
- 未开始：P2 真实采集（未启动）

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
    api/player/        # 匿名玩家档案（注册 / 改昵称）
    api/games/poetry/rank/  # 诗词升官 开局 / 判题 / 官阶视图 / 刷新恢复（withCrypto 包装）
    play/poetry-rank/  # 诗词升官官途页
  lib/
    crypto/            # 加密层：protocol / keys / nonce / session-keys / with-crypto / secure-fetch
    games/poetry/      # 诗词升官纯逻辑层：engine / rank 官阶 / capacity 容量 / promote 晋级结算 / score
    games/             # 共享纯函数：stages（判题门槛）/ timing（限时）/ sampling（加权抽样）
    question-bank/     # 智能体题库引擎（基础设施）：contracts / pipeline / validators / providers / infra
    db/                # Prisma 单例 + 仓储 + 会话服务（业务编排）
    data/              # 诗词语料种子 JSON（48 首 + 候选审计）
  store/               # Zustand 客户端状态（玩家身份 + 官途对局）
tests/                 # 与 src 结构镜像的单测
prisma/                # schema.prisma + 幂等种子脚本
scripts/               # 审计脚本（诗词容量 / 语料审计）+ 题库端到端演示
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
- 官阶 / 功名门禁在服务端强制校验（研习限当前官阶、科考目标必须 = 当前 + 1）；
- 答题耗时服务端钳位，速度分不可伪造。

## 数据合规红线

- 题库仅使用**公版内容 / MIT 协议开源数据集 / 开放 API**（诗词语料抽取自 chinese-poetry）。

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

> 语料审计：`node --experimental-strip-types scripts/poetry-capacity-audit.ts`
> （容量核算）与 `scripts/poetry-corpus-audit.ts`（语料结构审计，只读）。

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
