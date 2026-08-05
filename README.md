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
# 把返回的 id 填入 wrangler.toml

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

## 后续路线

- **M3 完善** — 诊断 Prompt 工程优化、用量趋势预测、团队管理

## 设计文档

详见 [docs/design/design.html](docs/design/design.html)
