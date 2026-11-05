# 黑暗森林：观察者效应

项目包含玩家、裁判、观战、大屏和赛后页面，以及由Durable Object负责结算的比赛服务。正式名单决定参赛人数，赛前参数在锁定发码时间后固定。

架构：Cloudflare Pages 静态前端 → 同源 Pages Functions → 独立 Worker 中的 SQLite-backed Durable Object。

## 本地开发

使用 Node.js 24 与 npm 11 或以上版本。依赖版本由根目录 `package-lock.json` 锁定。

```powershell
cd E:\forest
npm ci
node scripts/local-setup.mjs --players 24
npm run dev
```

在另一个终端运行 `npm run local:init`。初始化完成后，通过 `.private/local-rehearsal/accounts.json` 查看玩家和三个独立裁判的登录口令。`--players` 指预注册账号池容量；实际参赛人数取裁判选定的正式名单长度。账号与密钥保存在被Git忽略的私有目录及 `.dev.vars` 中。

- `http://127.0.0.1:5173`：Vite 开发入口；`/api/*` 转发到本地 Pages。
- `http://127.0.0.1:8788`：Pages 静态构建与 Functions 运行时。
- `127.0.0.1:8787`：内部 Worker 本地运行时，本地初始化工具通过受密钥保护的入口建立场次。
- 终端按 Ctrl+C 停止开发进程；本地 Cloudflare 状态在根目录 `.wrangler/state/`。

只查看前端时，无需启动 Cloudflare 进程：

```powershell
npm run dev:preview
```

- 开发预览：`http://127.0.0.1:5173/dev-preview/`，可切换6种角色、25组状态场景、模拟目击结果和连接异常。
- 正式入口：`http://127.0.0.1:5173/`，使用真实同域接口及本地持久化场次。
- 两个入口复用同一套页面与组件；模拟适配器只由开发预览入口加载。

启动、页面覆盖、模拟数据边界及待接接口见 [前端实现与开发预览](docs/前端实现与开发预览.md)。

## 常用命令

| 命令                      | 用途                                     |
| ------------------------- | ---------------------------------------- |
| `npm run dev`             | 构建静态外壳并同时启动三个本地进程       |
| `npm run dev:preview`     | 只启动前端并打开独立模拟数据预览         |
| `npm run check`           | 格式、ESLint、类型与构建检查，不部署云端 |
| `npm run build`           | 构建前端，并 dry-run 打包 preview Worker |
| `npm run cf:types`        | 根据 Wrangler 配置重新生成绑定类型       |
| `npm test`                | 执行单元测试及真实Workers集成测试        |
| `npm run test:workers`    | 执行SQLite、RPC、Alarm及业务集成测试     |
| `npm run test:acceptance` | 对尚未开始的本地场次执行一次HTTP首航验收 |
| `npm run cf:login`        | 手动登录 Cloudflare，需要浏览器授权      |
| `npm run cf:whoami`       | 检查当前 Cloudflare 身份                 |

## 工作区

- `apps/web/`：React前端、独立开发预览入口、同源 `functions/` 与 Pages 配置。
- `apps/match-worker/`：独立 Durable Object Worker，包含SQLite迁移、认证、规则、事件、投影和管理服务。
- `packages/contracts/`：角色、状态、动作、七色身份与前端数据契约，不包含服务端秘密。
- `tests/`：前端与纯规则单元测试、真实Workers集成测试；HTTP验收工具位于 `scripts/acceptance.mjs`。
- `.github/workflows/ci.yml`：检查工作流；不包含云端部署。

## 实现边界

已接通登录、昵称、母星审核、正式名单、参数配置、T0/T1首航、目击处罚与重生、宇宙事件、完整赛程、终局核验、观战及结果。裁判支持通知状态、暂停恢复、临时禁止攻击、基础指令、异常换码、受控攻击更正、历史分页、账号管理、赛后战报版本更正及加密备份与原生PITR恢复。

接口、操作及验收记录见[后端接口与运行说明](docs/后端接口与运行说明.md)。验收安排查[后端实现计划](docs/后端实现计划.md)及[验收安排补充](docs/后端验收安排补充_2026-11-04.md)；完整两小时排练已按用户要求取消。

前端快速检查：`npm run build:web`、`npx tsc --project apps/web/tsconfig.app.json`、`npx vitest run tests/unit/frontend.test.ts`。无需为查看页面执行全量测试。

## Cloudflare 配合事项

Preview使用当前机器的Wrangler登录及独立业务密钥。换机器或授权过期时，运行 `npm run cf:login` 并在浏览器完成授权。

云端开发地址：[开发环境](https://dev.darkforest-pages-dev.pages.dev/)。账号位于 `.private/preview-rehearsal/accounts.json`，与本地账号独立。2026年11月4日已完成真实HTTP首航、无人访问T0/T1、目击及重生验收，场次随后暂停。

开发阶段仅使用 `dev` 分支的 preview 部署，生产部署列表为空；现有域名与 DNS 保持原样。后续更新预览运行 `npm run cf:preview:deploy`。

目录职责、环境隔离、部署命令和分步配合流程见 [工程骨架与开发环境](docs/工程骨架与开发环境.md)。
