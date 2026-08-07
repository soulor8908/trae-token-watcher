# trae-token-watcher

Chrome 扩展 · 监控 TRAE Work Token 消耗，AI 驱动积分优化建议。

## MVP 功能

- **自动采集** — 在 work.trae.cn 对话时自动拦截 API 响应，提取 Token 用量（输入/输出/缓存）
- **本地存储** — 所有用量数据存储在扩展本地 IndexedDB，不上传后端
- **仪表盘** — 今日/本周/本月汇总、14 天趋势图、模型分布、最近记录
- **AI 诊断（路径 B）** — 填入自己的 DeepSeek API Key，一键生成优化建议（不经过任何后端）

## 安装

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录
4. 打开 [work.trae.cn](https://work.trae.cn) 开始对话，Token 数据会自动采集

## 使用

1. 点击工具栏图标打开仪表盘，查看 Token 汇总与趋势
2. **AI 诊断**：在诊断区粘贴 DeepSeek API Key → 保存 → 点击「诊断我的 Token 用法」
3. Key 加密存储在 `chrome.storage.local`，请求直连 DeepSeek API

## 项目结构

```
extension/                    # Chrome 扩展（MV3）
├── manifest.json             # 配置：双内容脚本 + 权限
├── content/
│   ├── inject.js             # 主世界：拦截 fetch/XHR，提取 token 用量
│   └── content.js            # 隔离世界：中转消息到 background
├── background/
│   └── background.js         # Service Worker：存储 + 消息路由 + badge
├── lib/
│   ├── db.js                 # IndexedDB 封装
│   └── auth.js               # OAuth 客户端 + 双路径诊断入口
├── popup/
│   ├── popup.html / .css     # 仪表盘 UI（暗色主题）
│   ├── popup.js              # 统计 + 趋势 + 账号 + 双路径诊断
│   ├── callback.html / .js   # OAuth 回调页：接收 token 存入 storage
└── icons/                    # 扩展图标

worker/                       # Cloudflare Workers 后端
├── wrangler.toml             # D1/KV binding + 变量
├── schema.sql                # D1 建表（users / sessions / usage_quota）
├── package.json              # 部署脚本
└── src/
    ├── index.js              # 路由表 + CORS + 错误处理
    ├── github.js             # GitHub OAuth 换 token + 用户信息 + Star 检查
    ├── auth.js               # OAuth 流程 + Star 缓存 + 状态查询
    ├── session.js            # session 签发/校验（SHA-256 哈希）
    ├── db.js                 # D1 查询封装
    └── diagnose.js           # 诊断转发 + 限流 + KV 缓存
```

## 数据流

```
work.trae.cn 页面
    │ fetch/XHR 响应
    ▼
inject.js (主世界拦截) ──postMessage──▶ content.js (隔离世界)
                                          │ chrome.runtime.sendMessage
                                          ▼
                                    background.js (Service Worker)
                                          │ IndexedDB 写入
                                          ▼
                                    IndexedDB (本地)
                                          ▲
                                    popup.js (直读)
                                          │
                                    仪表盘渲染
```

## 技术选型

| 层 | 技术 | 说明 |
|---|---|---|
| 采集 | Content Script (MAIN world) | document_start 注入，覆盖 fetch/XHR |
| 存储 | IndexedDB | 本地优先，用量数据不上传 |
| 后端 | Cloudflare Workers + D1 + KV | 身份认证 + Star 校验 + 诊断转发 |
| 诊断 A | DeepSeek API（后端转发） | Star 用户免费，限 10 次/天，结果缓存 1h |
| 诊断 B | DeepSeek API（直连） | 用户自带 Key，不限次数，无后端 |

## 后端部署（M2）

后端代码在 `worker/` 目录，部署到 Cloudflare Workers。

### 1. 创建 GitHub OAuth App

- 访问 https://github.com/settings/developers → New OAuth App
- **Authorization callback URL** 填：`https://<你的-worker-域名>/auth/callback`
- 记下 Client ID 和 Client Secret

> ⚠️ **必须** 在第 3 步用 `npm run secret:github-id` 和 `npm run secret:github-secret` 把它们配置成 Worker Secrets。
> 漏配会导致登录时跳转到 `https://github.com/login/oauth/authorize?client_id=undefined` 并返回 404。

### 2. 创建 Cloudflare 资源

```bash
cd worker
npm install
npx wrangler login

# 创建 D1 数据库
npx wrangler d1 create trae-token-watcher-db
# 把返回的 database_id 填入 wrangler.toml

# 创建 KV 命名空间
npx wrangler kv namespace create KV
# 把返回的 id 填入 wrangler.toml（binding 必须保持为 KV，代码用 env.KV 访问）

# 初始化数据库表（本地 + 远程）
npm run db:init
npm run db:init:remote
```

### 3. 配置 Secrets

```bash
npm run secret:github-id        # 粘贴 GitHub OAuth Client ID
npm run secret:github-secret    # 粘贴 GitHub OAuth Client Secret
npm run secret:deepseek         # 粘贴后端转发用的 DeepSeek API Key
npm run secret:session          # 粘贴 32+ 字节随机串（session 签名密钥）
```

### 4. 部署

```bash
npm run deploy
# 记下输出的 Worker 域名，如 https://trae-token-watcher-api.<你>.workers.dev
```

### 5. 扩展端配置

在扩展 popup 的「AI 诊断」区，将后端域名填入「后端 API 地址」并保存。之后点击「用 GitHub 登录」即可完成 OAuth，Star 仓库后享免费诊断。

## 双路径诊断

```
诊断请求
  ├─ 已登录 + 已 Star + 后端可用 → 路径 A（后端转发，限流10次/天，缓存1h）
  └─ 否则 → 路径 B（用户自有 DeepSeek Key 直连，不限次数）
```

## 为什么 GitHub 登录要配置后端 API 地址？

Chrome 扩展（MV3）**无法独立完成 GitHub OAuth**，必须借助后端 Worker 中转，原因有三：

1. **`client_secret` 不能放进扩展** — GitHub 换 token 接口要求带 `client_secret`，扩展代码对所有用户可见，放进去会被盗用冒充。所以换 token 必须在 Worker 服务端完成。
2. **OAuth 回调地址必须是公网 HTTPS** — GitHub 只接受 `https://...` 形式的 callback URL，不接受 `chrome-extension://...`。所以回调只能落到 Worker 的 `/auth/callback`。
3. **每个用户自部署** — 本项目是 BYO（Bring Your Own）后端，不同用户的 Worker 域名不同。扩展无法预先知道你的 Worker 在哪，所以必须由你在设置页填一次「后端 API 地址」。

完整流程（[worker/src/auth.js](worker/src/auth.js)）：

```
扩展 popup 点击「用 GitHub 登录」
   │ chrome.tabs.create(`${apiBase}/auth/github?ext_id=...`)
   ▼
Worker /auth/github  → 302 → github.com/login/oauth/authorize?client_id=...
   │ 用户授权
   ▼
GitHub → 302 → Worker /auth/callback?code=...
   │ Worker 用 client_secret 换 access_token
   │ 查用户信息 + 查 Star 状态 + 签发 session
   ▼
Worker → 302 → chrome-extension://${extId}/callback.html#token=...
   │ 扩展 callback.js 把 session 存入 chrome.storage.local
   ▼
登录完成
```

所以「后端 API 地址」是扩展发起 OAuth 的入口，没填就找不到 Worker，登录链路从第一步就断掉。

## 常见问题排查

| 现象 | 原因 | 解决 |
|---|---|---|
| 登录跳转到 `client_id=undefined` 后 404 | Worker 没配置 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` secret | `cd worker && npm run secret:github-id`、`npm run secret:github-secret` 重新设置 |
| 登录后报「Worker 未配置 ...」 | 同上，secret 未生效 | 重新 `wrangler secret put`，并用 `wrangler secret list` 确认 |
| 已 Star 但诊断报 403 | KV 绑定名错误，Star 缓存写不进 | 检查 `wrangler.toml` 中 KV `binding = "KV"`，重新 `wrangler deploy` |
| OAuth 回调报 `redirect_uri mismatch` | GitHub OAuth App 的 callback URL 与 Worker 域名不一致 | 去 GitHub OAuth App 设置改为 `https://<worker域名>/auth/callback` |
| 扩展点登录没反应 | 没配置后端 API 地址 | 在 popup 或设置页填入 Worker 域名并保存 |

## 后续路线

- **M3 完善** — 诊断 Prompt 工程优化、用量趋势预测、团队管理

## 设计文档

详见 [docs/design/design.html](docs/design/design.html)
