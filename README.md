# 黑暗森林：观察者效应

当前是开发环境骨架，按 `docs/黑暗森林_完整策划案.md` 与 `docs/黑暗森林_技术方案.md` 组织。

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

页面目前为空白是预期结果；未实现的 `/api/*` 返回 404。

## 常用命令

| 命令                | 用途                                           |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | 构建静态外壳并同时启动三个本地进程             |
| `npm run check`     | 格式、ESLint、类型与构建检查，不部署云端       |
| `npm run build`     | 构建前端，并 dry-run 打包 preview Worker       |
| `npm run cf:types`  | 根据 Wrangler 配置重新生成绑定类型             |
| `npm run test`      | 执行未来添加的单元测试；当前无测试，不视为通过 |
| `npm run cf:login`  | 手动登录 Cloudflare，需要浏览器授权            |
| `npm run cf:whoami` | 检查当前 Cloudflare 身份                       |

## 工作区

- `apps/web/`：静态前端、同源 `functions/`、地图资源与 Pages 配置。
- `apps/match-worker/`：独立 Durable Object Worker 与权威状态模块的预留目录。
- `packages/contracts/`：仅预留可向浏览器公开的契约，不包含服务端秘密。
- `tests/`：单元、Workers 集成与端到端测试的预留目录。
- `.github/workflows/ci.yml`：检查工作流；不包含云端部署。

## 实现边界

没有实现业务界面、登录、API、RPC、SQL 表、比赛时钟、规则、Alarms、裁判功能或测试用例。
源码仅有空前端/契约模块、空 Durable Object 类、空默认 Worker 导出及透传中间件，供工具链识别入口。

## Cloudflare 配合事项

本次已复用当前机器的 Wrangler 登录，创建并验证了云端开发资源，目前不需要你额外登录或操作控制台。换机器或授权过期时，运行 `npm run cf:login` 并在浏览器完成授权；不要把 token、密码或密钥发到聊天中。

开发预览：https://dev.darkforest-pages-dev.pages.dev/ 。页面为空白是预期结果，未实现 API 返回 404。

开发阶段仅使用 `dev` 分支的 preview 部署，生产部署列表为空；现有域名与 DNS 保持原样。后续更新预览运行 `npm run cf:preview:deploy`。

目录职责、环境隔离、部署命令和分步配合流程见 [工程骨架与开发环境](docs/工程骨架与开发环境.md)。
