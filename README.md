# 黑暗森林：观察者效应

前端按两份网站设计与功能文档实现，提供玩家、裁判、观战、大屏和赛后页面，以及独立的模拟数据开发预览。权威比赛服务仍是工程骨架，尚未实现业务接口。

架构：Cloudflare Pages 静态前端 → 同源 Pages Functions → 独立 Worker 中的 SQLite-backed Durable Object。

## 本地开发

使用 Node.js 24 与 npm 11 或以上版本。依赖版本由根目录 `package-lock.json` 锁定。

```powershell
cd E:\forest
npm ci
npm run dev
```

- `http://127.0.0.1:5173`：Vite 开发入口；`/api/*` 转发到本地 Pages。
- `http://127.0.0.1:8788`：Pages 静态构建与 Functions 运行时。
- `127.0.0.1:8787`：内部 Worker 本地运行时，无业务 HTTP 入口。
- 终端按 Ctrl+C 停止开发进程；本地 Cloudflare 状态在根目录 `.wrangler/state/`。

只查看前端时，无需启动 Cloudflare 进程：

```powershell
npm run dev:preview
```

- 开发预览：`http://127.0.0.1:5173/dev-preview/`，可切换6种角色、25组状态场景、模拟目击结果和连接异常。
- 正式入口：`http://127.0.0.1:5173/`，只使用真实同域接口，不回退到模拟比赛。现阶段登录等操作会提示服务不可用。
- 两个入口复用同一套页面与组件；模拟适配器只由开发预览入口加载。

启动、页面覆盖、模拟数据边界及待接接口见 [前端实现与开发预览](docs/前端实现与开发预览.md)。

## 常用命令

| 命令                  | 用途                                             |
| --------------------- | ------------------------------------------------ |
| `npm run dev`         | 构建静态外壳并同时启动三个本地进程               |
| `npm run dev:preview` | 只启动前端并打开独立模拟数据预览                 |
| `npm run check`       | 格式、ESLint、类型与构建检查，不部署云端         |
| `npm run build`       | 构建前端，并 dry-run 打包 preview Worker         |
| `npm run cf:types`    | 根据 Wrangler 配置重新生成绑定类型               |
| `npm run test`        | 执行全量单元测试；前端快速验证请使用下述指定文件 |
| `npm run cf:login`    | 手动登录 Cloudflare，需要浏览器授权              |
| `npm run cf:whoami`   | 检查当前 Cloudflare 身份                         |

## 工作区

- `apps/web/`：React前端、独立开发预览入口、同源 `functions/` 与 Pages 配置。
- `apps/match-worker/`：独立 Durable Object Worker 与权威状态模块的预留目录。
- `packages/contracts/`：角色、状态、动作、七色身份与前端数据契约，不包含服务端秘密。
- `tests/`：单元、Workers 集成与端到端测试的预留目录。
- `.github/workflows/ci.yml`：检查工作流；不包含云端部署。

## 实现边界

前端页面、共用交互、状态披露与模拟适配器已经实现。正式入口具备HTTP适配层，但还没有可联调的登录、API、RPC、SQL、权威比赛时钟、规则结算或Alarms。
开发预览的本地状态变化不能替代正式服务器的鉴权、幂等、随机结算、发行唯一性及审计保证。

前端快速检查：`npm run build:web`、`npx tsc --project apps/web/tsconfig.app.json`、`npx vitest run tests/unit/frontend.test.ts`。无需为查看页面执行全量测试。

## Cloudflare 配合事项

本次已复用当前机器的 Wrangler 登录，创建并验证了云端开发资源，目前不需要你额外登录或操作控制台。换机器或授权过期时，运行 `npm run cf:login` 并在浏览器完成授权；不要把 token、密码或密钥发到聊天中。

现有云端开发地址：[开发环境](https://dev.darkforest-pages-dev.pages.dev/)。本次仅完成本地前端，未执行云端部署；该地址内容可能仍是旧构建。

开发阶段仅使用 `dev` 分支的 preview 部署，生产部署列表为空；现有域名与 DNS 保持原样。后续更新预览运行 `npm run cf:preview:deploy`。

目录职责、环境隔离、部署命令和分步配合流程见 [工程骨架与开发环境](docs/工程骨架与开发环境.md)。
