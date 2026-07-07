# agents-mirror-kit

[agentsmirror.com](https://codexapp.agentsmirror.com) 镜像矩阵（[codex-app-mirror](https://github.com/Wangnov/codex-app-mirror)、[claude-app-mirror](https://github.com/Wangnov/claude-app-mirror)、agents-cli-mirror）的共享基础层：与"镜像哪个应用"无关的脚本与 Cloudflare Worker 源码，在一处维护、多镜像复用。

Shared foundation for the agentsmirror.com mirror matrix: app-agnostic scripts and Cloudflare Worker sources, maintained once and consumed by every mirror repo.

## 组件

| 组件 | 说明 |
|---|---|
| `scripts/sync-r2.sh` | 单对象上传 R2（content-type/disposition/cache-control、`R2_UPLOAD_MODE` s3-cp/put-object 双模式、CLI 超时控制） |
| `scripts/clear-r2-prefix.sh` | 清理 R2 指定前缀（staging 清场） |
| `scripts/remove-latest-links-from-release-notes.sh` | 从旧 Release notes 移除 latest 短链区块 |
| `scripts/update-download-stats.py` | 累计下载计数 + shields.io 徽标（R2 GraphQL Analytics 每日累加、新增跟踪对象自动回补） |
| `workers/github-dispatcher/` | Cloudflare Cron → GitHub `workflow_dispatch` 扇出（`DISPATCH_TARGETS` JSON 多目标，兼容单目标 legacy vars） |
| `workers/download-router/` | 双层镜像地域分流：CN→secondary S3 预签名、其余→全球 R2、下载计数、`/stats` 徽标代理；路径/元数据由 `ROUTE_CONFIG` 驱动 |
| `docs/pitfalls.md` | 用真实镜像流量换来的踩坑记录 |

**不在 kit 里的**（有意为之）：探测（probe）、下载、版本对齐、release body、Sparkle appcast 构建——这些是 per-app 逻辑，差异是本质的，留在各镜像仓库。

## 消费方式

镜像仓库在 workflow 里 checkout **pinned tag**（不是 main），脚本按 kit 路径调用：

```yaml
- uses: actions/checkout@v6
  with:
    repository: Wangnov/agents-mirror-kit
    ref: v0.1.0          # pinned tag；升级 = 显式 bump
    path: .mirror-kit

- run: bash .mirror-kit/scripts/sync-r2.sh --object "$BUCKET" latest/win-x64 file.msix name.msix
```

Worker 的部署配置（`wrangler.jsonc`：实例名、cron、vars、routes）**留在各镜像仓库**——kit 只提供源码。部署：

```bash
git clone --depth 1 --branch v0.1.0 https://github.com/Wangnov/agents-mirror-kit
cd agents-mirror-kit/workers/github-dispatcher
cp <mirror-repo>/cloudflare/github-dispatcher/wrangler.jsonc .
npx wrangler deploy
```

## 治理

- 镜像仓库 pin tag 消费：本仓库的任何变更（包括外部 PR）都**不会自动流入**任何生产镜像管线；升级永远是各镜像仓库显式 bump tag、逐仓灰度。
- 本仓库不含任何 secrets、部署凭证或路由配置。
- 变更请 issue-first：先说明真实遇到的问题或明确的下游需求，再谈实现（与 codex-app-mirror 的贡献要求一致）。

## License

[MIT](./LICENSE)
