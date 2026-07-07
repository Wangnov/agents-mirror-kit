# github-dispatcher

Cloudflare Cron Trigger → GitHub `workflow_dispatch` 扇出器。一个部署实例可以按 `DISPATCH_TARGETS` 配置触发任意多个镜像仓库的 mirror workflow，作为 GitHub Actions 自带 schedule（不可靠、常延迟）的主调度替代。

## 配置

- **`DISPATCH_TARGETS`**（推荐）：JSON 数组，每项 `{owner, repo, workflow?, ref?, inputs?, required?}`；`workflow` 默认 `mirror.yml`，`ref` 默认 `main`，`required` 默认 `true`。任一 `required` 目标 dispatch 失败会让本次 cron 报错（可观测），`required: false` 的目标失败只记日志。
- **Legacy 单目标 vars**：未设 `DISPATCH_TARGETS` 时沿用 `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_WORKFLOW` / `GITHUB_REF` / `GITHUB_FORCE_RELEASE`，行为与旧版完全一致。
- **`GITHUB_TOKEN`**（secret，必填）：需要目标仓库的 `actions:write`。
- **`DISPATCH_USER_AGENT`**（可选）：请求 UA 标识。

## 部署

实例的 `wrangler.jsonc`（名字、cron、vars）留在各镜像仓库；本目录只有源码和 `wrangler.jsonc.example`：

```bash
cd workers/github-dispatcher
cp <mirror-repo>/cloudflare/github-dispatcher/wrangler.jsonc .
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN   # 首次部署时
```

## 测试

```bash
npm run check --prefix workers/github-dispatcher
```
