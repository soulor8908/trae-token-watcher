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
extension/
├── manifest.json          # MV3 配置
├── content/
│   ├── inject.js          # 主世界：拦截 fetch/XHR，提取 token 用量
│   └── content.js         # 隔离世界：中转消息到 background
├── background/
│   └── background.js      # Service Worker：存储 + 消息路由 + badge
├── lib/
│   └── db.js              # IndexedDB 封装
├── popup/
│   ├── popup.html         # 仪表盘 UI
│   ├── popup.css          # 暗色主题样式
│   └── popup.js           # 统计渲染 + 趋势图 + AI 诊断
└── icons/                 # 扩展图标
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
| 存储 | IndexedDB | 本地优先，无后端依赖 |
| 诊断 | DeepSeek API (直连) | 路径 B，用户自带 Key |
| 后端 | — | MVP 不需要，M2 阶段引入 Cloudflare |

## 后续路线

- **M2** — Cloudflare Worker + D1 + GitHub OAuth + Star 校验（Star 即门票）
- **M3 完整版** — Star 用户免费诊断（经后端转发，限 10 次/天）

## 设计文档

详见 [docs/design/design.html](docs/design/design.html)
