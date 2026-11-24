# 镜像基础设施踩坑记录 / Pitfalls

用 codex-app-mirror 的真实流量（月下载数十万次、egress 百 TB 级）换来的经验。新镜像上线前先读一遍，别再踩一次。

## 分发与路由

### 静态站会吞掉数据端点路由
**症状**：README 的下载量徽标突然渲染 "unparseable json response"——`/stats/downloads.json` 返回的是官网 HTML。
**根因**：官网部署在 zone 根路径后，其 SPA fallback 接管了所有未被 Worker route 覆盖的路径。Worker 原本只挂了 `/latest/*`。
**对策**：任何"数据端点"前缀（`/stats/*` 等）必须显式划给 Worker route——Workers route 优先级高于同域静态站。新镜像域名规划时，一开始就把数据前缀列入 Worker routes。

### R2 公开桶的漏扫噪声
**症状**：GetObject 请求数远高于真实下载数。
**根因**：公开桶被大量漏洞扫描（`.env`、`wp-login.php`、`phpinfo.php`……全 404、0 字节），虚增请求计数。
**对策**：统计下载量时按**精确对象 key** 过滤（`update-download-stats.py` 的做法），不要按前缀聚合。

### R2 Analytics 只保留 ~32 天
**症状**：无法直接查询"累计总下载量"。
**根因**：GraphQL `r2OperationsAdaptiveGroups` 的时间窗口硬上限 `4w4d`。
**对策**：每日累加持久化（state 存桶内 JSON），见 `update-download-stats.py`。新增跟踪对象时脚本会在窗口内自动回补一次；断档超过窗口的数据不可恢复，会 WARNING 明示。

## 上游探测（Microsoft Store / 静态直链）

### FE3 临时 URL 与 rollout 漂移
**症状**：探测时拿到的包 URL，到下载时已失效或指向不同版本；ARM64 尤其频繁。
**根因**：Microsoft CDN 的 FE3 URL 是临时的；Store 的分阶段 rollout 会让 probe 与 download 两个时刻看到不同状态。
**对策**：探测结果只作为"变更信号"，下载前重新解析；对可选架构（ARM64）允许 `catalog-only` 状态并保留上一份校验匹配的 latest，等 rollout 稳定后再补。绝不把 Microsoft CDN 临时 URL 当长期下载地址发布。

### 平台间发布不同步
**症状**：同一内部版本，macOS 已发、Windows 未发（或反之），镜像 Release 卡住。
**对策**：按"内部版本"聚合 Release；缺失平台先发 prerelease 并在 body 标注等待中；已就绪的架构立即推进自己的 `latest/*` 短链，四架构齐后提升为正式 latest。

## 调度

### GitHub Actions schedule 不可靠
**症状**：`schedule` 触发经常延迟数十分钟甚至被跳过。
**对策**：主调度用 Cloudflare Cron Trigger（`workers/github-dispatcher`）打 `workflow_dispatch`，GitHub 自带 schedule 只做低频兜底（如每 6 小时）。

## R2 上传

### 大文件上传偶发卡死与 `CompleteMultipartUpload: InvalidPart`
**症状**：
1. `aws s3 cp` 上传数百 MB 安装包到 R2 偶发无限挂起，拖死整个发布 run。
2. GitHub Runner 预装的新版 AWS CLI v2（`>= 2.23`）连续上传几十个大文件（DMG / MSIX / `.delta`）到 R2 时，偶发在分片合并阶段报错 `An error occurred (InvalidPart) when calling the CompleteMultipartUpload operation: One or more of the specified parts could not be found`。
**根因**：AWS CLI v2 默认开启 `when_supported` 分片附加 CRC 校验，且默认按 `8MB` 分片 × `10` 并发线程切分大文件（790MB 安装包多达 100 个分片）；一旦单个分片在 R2 侧出现瞬时一致性抖动，同一 `UploadId` 无法仅靠 SDK 内部重试恢复。
**对策**：`sync-r2.sh` 默认设置 `AWS_REQUEST_CHECKSUM_CALCULATION=when_required`、`AWS_RESPONSE_CHECKSUM_VALIDATION=when_required`、`64MB` 分片阈值/大小与 `4` 并发连接，默认开启 CLI 连接/读取超时（`30s` / `180s`），并在最外层提供整对象指数退避重试（`R2_UPLOAD_ATTEMPTS`，默认 4 次，重新发起全新 `UploadId`），同时保留 `R2_UPLOAD_MODE=put-object` 备选路径。

## 更新通道（macOS Sparkle）

### EdDSA 签名必须字节级保真
**原则**：Sparkle 的 EdDSA 签的是归档字节本身。镜像只要与官方字节级一致，原始签名依然有效——**只改写 appcast enclosure 的 URL，绝不重算/伪造签名**。任何对归档的"无害处理"（重压缩、改元数据）都会毁掉签名。

## 统计口径

### 短链别名会静默漏计
**症状**：累计下载数长期系统性低估。
**根因**：新增的对象别名（如 `latest/win-x64`）没有同步加进统计对象集，而它成了 README 主推链接。
**对策**：`STATS_OBJECTS` 是必填参数（kit 版），新增短链别名时必须同步更新；脚本对新增对象自动回补留存窗口内的历史。
