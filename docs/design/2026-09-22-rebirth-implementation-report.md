# 重生改版实施与验收记录（2026-09-22）

## 本次交付

本次只优化游戏本身，不包含微信小游戏打包、AppID、提审、域名或发布操作。保留现有路由与玩家存档，继续使用原有服务端出题、判题、功名与官阶规则。

- 品牌：《重生：我靠诗词问鼎天下》，短名“诗词逆命”；替换页面 metadata、首页、顶栏、分享图和站点图标。
- 视觉：暖宣纸、靛蓝与琥珀金；人物画屏、序章、十一阶独白、结算反馈形成统一主题。
- 核心布局：首页、官途、对局、结算采用动态视口单屏布局，包含安全区、窄屏及横屏规则。
- 玩法信息：官途突出人物、功名进度与下一步操作，竞猜、战绩与衣冠收进面板；未来官阶及隐藏终点继续按门禁展示。
- 答题：补齐五种题型的准确问法，题干按测量结果完整分页；极长选项先阅读全文再显式确认，普通选项一触作答。问同窗明确提示功名折算；反馈原位展示，阅读解析时暂停客户端自动翻题。
- 浏览：功名簿分类、诗词阁分页与全文阅读、皇榜分页、衣冠解锁检查；分页容量按可用空间处理，保留上一页操作。
- 分享：按需生成，修复标题过长及人物使用结算前官阶的问题，图片等比预览，支持下载与长按保存，失败可重试。
- 稳定性：注册请求合并，密钥交换失败可再次建立连接，并发首请求或丢包不再导致后续请求缺密钥；客户端网络请求增加超时；加载失败、图片失败和异常页面有明确出口。
- 数据一致性：功名簿修复“最近十局”实际取到最早十局的问题；结算顶栏不再把原始得分标成最终功名。

## 验收方式

最终结果：

| 检查 | 结果 |
| --- | --- |
| Vitest | 29 个测试文件，344 / 344 通过 |
| Playwright | Chromium / WebKit 共 30 / 30 通过 |
| TypeScript / ESLint | 通过，无新增告警 |
| Next.js Turbopack 生产构建 | 通过 |
| 真实 HTTP / 加密 / 隔离 DB 冒烟 | 十题、提示、刷新恢复、结算、分享、诗词阁通过 |

最终截图：`.artifacts/rebirth/real-home.png`、`real-rank.png`、`real-quiz.png`、`real-settle.png`、`real-share.png`、`real-gallery.png`。测试报告：`.artifacts/playwright-report/index.html`。

使用本地生产构建进行浏览器验证；开发预览和验收使用不同构建目录及端口，避免覆盖用户正在运行的预览。后端真实冒烟使用独立 SQLite 文件 `.artifacts/rebirth-smoke.db`，不修改原有玩家档案。

### 自动化

- Vitest：原有出题、计分、加密、题库、官阶及数据库集成回归，并增加最近十局的回归断言。
- Playwright：Chromium / WebKit，320×568、360×640、375×667、390×844、844×390。
- 覆盖首页、官途、浏览页、长题、长选项、对局解析与自动翻题、晋升结算、分享、rank 8/9/10 显隐、密钥交换失败重试与服务错误。
- 校验根节点无滚动、关键元素位于视口内、按钮命中不被遮挡、正文不发生未处理溢出，配合截图目视检查。
- 加密 mock 保留真实 RSA-OAEP / AES-GCM 请求与响应过程，不向业务客户端加入测试后门。

### 真实后端闭环

独立库导入 176 首种子诗词，完成匿名注册 → 序章 → 十题研习 → 问同窗 → 第四题刷新恢复 → 判题与解析 → 结算入账 → 分享图 → 诗词入阁。

入口脚本：`scripts/smoke-rebirth.mjs`。浏览器用例：`tests/e2e/mobile.spec.ts`。浏览器截图与报告在 `.artifacts/`，不纳入 Git。

### 本地复现（PowerShell）

先安装依赖与浏览器：

```powershell
npm install
node node_modules/@playwright/test/cli.js install chromium webkit
```

建立独立验收库并构建：

```powershell
New-Item -ItemType Directory -Force .artifacts | Out-Null
$env:DATABASE_URL = 'file:' + ((Join-Path (Get-Location) '.artifacts/rebirth-smoke.db') -replace '\\', '/')
node node_modules/prisma/build/index.js db push --skip-generate
node prisma/seed.mjs
$env:NEXT_BUILD_DIR = '.next-verify'
node node_modules/next/dist/bin/next build --turbopack
node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3100
```

在另一个终端执行：

```powershell
$env:E2E_BASE_URL = 'http://127.0.0.1:3100'
node node_modules/@playwright/test/cli.js test
node scripts/smoke-rebirth.mjs
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
```

## 实施中根据效果调整的项目

1. 立绘自带深色背景，与宣纸底不协调：改为拱形金边画屏，保留原有资产。
2. 短题面偏上：改为题面区域居中，长题仍完整分页。
3. 横屏功名簿统计卡压住翻页：收紧标题与统计卡，压缩图表装饰高度。
4. 自动生成分享长图挤占结算：改为点击后生成，固定高度弹层预览。
5. 弹层受默认样式影响偏向屏幕左上：显式居中并计入安全区。
6. 基础结算测试受当天活动影响：基础用例固定无活动，活动倍率仍由独立集成测试覆盖。
7. 开发服务与生产验收共用 `.next` 会互相覆盖：增加 `NEXT_BUILD_DIR` 隔离入口。

## 验收边界

浏览器模拟覆盖不等于微信真机验收。本次未执行微信打包、真实 iOS / Android 硬件检查、原生菜单适配或平台发布事项；200% 系统字体及原生日期选择器需后续真机补验。不承诺已完成平台审核或可直接提交微信小游戏。

原有 PNG 封面不再用于首页；新的页面标题由 HTML 排版。旧封面导出脚本同步了品牌文字，但本次未重生成 PNG 美术产物。服务器 persona 句式池保持现状。
