# download-router

双层镜像 + 按地域分流的通用下载路由 worker。同一份源码服务多个镜像，各镜像的差异全部由 `ROUTE_CONFIG` 提供。

## 职责

- **地域分流**：`SECONDARY_COUNTRY_CODES`（默认 CN）命中且配了 secondary S3 时，对副镜像签发 SigV4 预签名 URL（302，支持 `SECONDARY_S3_METADATA_TTL_SECONDS` 与 `SECONDARY_S3_SIGNED_URL_TTL_SECONDS` 分级有效期）；否则重定向到全球 R2（`GLOBAL_MIRROR_BASE_URL`）。
- **访问保护与反盗链（可选，默认关闭）**：`BLOCK_MODE`（`off` / `shadow` / `enforce`，坏配置 fail-open）支持 `BLOCKED_REFERER_HOSTS`（盗链页面 `302` 回跳首页）与 `BLOCKED_UA_SUBSTRINGS`（含 UTF-8 中文 ByteString 解码，返回 `403` 合规 JSON + RFC 6903 `Link` 头），采样写入独立 `ABUSE_ANALYTICS` 数据集。
- **下载计数**：GET 且 category 非空时写 Analytics Engine（`DOWNLOAD_ANALYTICS` binding，设 `ANALYTICS_EXTENDED_BLOBS="1"` 可追加路径、Referer 域名、UA、ASN 与协议指纹），失败不阻塞跳转。
- **徽标代理**：`/stats/downloads.json` 从 R2 proxy 成 JSON（防同域官网 SPA 吞路径），带 CORS + max-age=300。

## ROUTE_CONFIG

`vars.ROUTE_CONFIG`（wrangler.jsonc 里的结构化对象，或 JSON 字符串）：

```jsonc
{
  "aliases": {
    "/latest/win-x64": { "category": "installer", "filename": "App-x64.msix", "contentType": "application/vnd.ms-appx" },
    "/latest/checksums": { "category": null, "filename": "SHA256SUMS.txt", "contentType": "text/plain; charset=utf-8" },
    "/latest/appcast.xml": { "category": null }
  },
  "patterns": [
    { "regex": "^/latest/mac/(arm64|intel)/[^/]+\\.zip$", "category": "update-full" },
    { "regex": "^/latest/mac/(arm64|intel)/[^/]+\\.delta$", "category": "update-delta" }
  ]
}
```

- **alias**：精确路径 → `{ category, filename?, contentType? }`。`category` 为 `null` 表示合法但不计入 analytics（如 checksums/manifest/appcast）。`filename`/`contentType` 用于 secondary 预签名 URL 的 content-disposition，缺省则不加。
- **pattern**：`{ regex, category }`，用于 Sparkle 归档等按模式匹配的路径（如 mac zip/delta）。
- 缺失或坏配置 → worker 返回 500（fail closed）。

## 部署

```bash
git clone --depth 1 --branch <tag> https://github.com/Wangnov/agents-mirror-kit
cp <mirror-repo>/cloudflare/download-router/wrangler.jsonc agents-mirror-kit/workers/download-router/
cd agents-mirror-kit/workers/download-router
npx wrangler deploy
# secondary S3 凭证等用 npx wrangler secret put 配置
```

## 测试

```bash
npm run check --prefix workers/download-router
```

测试用与 codex-app-mirror 生产一致的 ROUTE_CONFIG 断言行为；抽取时另有 91 项新旧 worker 差分校验（含 SigV4 签名字节级一致）。
