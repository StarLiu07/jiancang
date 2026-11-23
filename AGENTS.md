# AGENTS.md

> 像珍惜自己的注意力一样珍惜上下文窗口。本文件每一条都必须回答“它凭什么在这里”；若不再需要，直接删除。

## 一、通用闭环纪律（与技术栈无关）

### 1. Context 治理
- **信息分流**：
  - 长期不变的项目约束 → 写在本文件“二、本项目专属约定”；
  - 踩过的坑与失败经验 → 先记入 [LESSONS.md](./LESSONS.md)，**不要直接往本文件堆补丁文字**；
  - 项目还小时不建独立 Memory，**一切以代码库本身为准**。
- **体积红线**：本文件原则上控制在 **150 行（约 6KB）以内**。想新增一条规则前，先检查是否有旧规则可以合并、删除或转为代码/测试。
- **工具克制**：能用现成 CLI 完成的操作优先用 CLI，避免引入占满上下文的冗余工具；查状态优先查最小精准输出，不要把整屏无关日志灌进上下文。

### 2. 验证铁律（Loop 的核心）
- **先看验证，再报完成**：任何改动提交或汇报前，必须运行对应检查（编译 / 类型 / Lint / 测试 / 实际运行），禁止靠猜测宣布通过。
- **红灯先于绿灯**：每新增一条测试、检查脚本或门禁，必须先喂一个**已知错误输入**确认它会稳定报红，再修复变绿。从未变过红的检查等于没写。
- **以远端/真实状态为准**：确认推送、部署、服务运行状态时，直接查询目标真实状态，不依赖被截断的本地命令输出。

### 3. 干净上下文纪律（防 Context Rot）
- 同一问题在当前上下文中连续修复 **2 轮仍未收敛**，立刻停止在原上下文硬磨：
  1. 明确向用户提议**回退到出错前**或**新开干净会话**；
  2. 只带三样东西重新出发：**已验证的机械事实（报错/diff）**、**当前判断**、**已排除的错误方向**。

### 4. 踩坑沉淀阶梯（写进提示，不如写进代码）
同一个错误出现第 **2 次** 时，记入 [LESSONS.md](./LESSONS.md)，并严格按约束强度从高到低找落脚点（能用上一层就不用下一层）：
1. **代码结构 / 类型系统**（让错误在结构上写不出来）
2. **Lint / Git Hook / 自动化脚本**（执行时自动拦截）
3. **自动化回归测试**（改坏立刻报红）
4. **规则文件 / Skill**（最后手段）

---

## 二、本项目专属约定（随代码演进补充）

- **技术栈与入口**：
  - 后端：`backend/`，Python 3.11+（`uv` + FastAPI + SQLite FTS5 trigram），入口 `app.main:app`，默认端口 `8420`。
  - 移动端：`mobile/`，Expo SDK 52 + Expo Router 4 + TypeScript（Android 优先，支持系统分享 `ACTION_SEND` 与本地每日提醒）。
  - 部署：根目录 `docker-compose.yml` + `backend/Dockerfile` + `.env.example`，面向家用 Ubuntu NUC（`APP_UID/GID=1001`，复用宿主机 `mihomo :7890` 与 `new-api :3000`）。
- **开发 / 运行命令**：
  - 后端本地运行：`cd backend && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8420`
  - 移动端启动：`cd mobile && pnpm start`（Android 原生构建/预构建：`pnpm exec expo prebuild --platform android`）
  - NUC 部署：`cp .env.example .env && mkdir -p data && docker compose up -d --build`
- **低成本验证命令（Tier 1：编译 / Lint / 测试）**：
  - 后端：`cd backend && uv run pytest -q && uv run ruff check app tests`
  - 移动端：`cd mobile && pnpm exec tsc --noEmit && pnpm exec expo config --type public`
- **项目红线（不可触碰的约束）**：
  - 严禁将任何真实 API Key / Token / Cookie 写入仓库或 `.env.example`（所有凭据只放 `.env`）。
  - 抓取或 AI 失败时绝不丢失用户原始收藏记录，必须优雅降级为 `partial` 或 `failed` 并支持重试/手动补全。
  - 修改 `backend/app/models.py` 或路由契约时，必须同步更新 `mobile/src/types.ts` 与 `mobile/src/api/client.ts`。
