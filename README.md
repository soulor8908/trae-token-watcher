# trae-token-watcher

> Chrome 扩展 · 本地优先的 TRAE Work Token 消耗监控 + AI 驱动积分优化

**trae-token-watcher** 是一个运行在浏览器里的「Token 账本」。它在你使用trae的官网 [www.trae.cn](https://www.trae.cn) 、论坛和traework 网页版时，**自动、无感地**记录每一次对话消耗的 Token、积分与费用，把分散在会话里的数据聚合成可量化、可回看、可优化的账本——并且**所有数据只存在你本地浏览器**，不上传任何第三方。

---

## 一、产品介绍

### 它解决什么问题

用 TRAE / Trae Work 做开发的人都有一个共同痛点：**花了多少钱、用掉多少额度，心里完全没数**。

- 官方只给单个会话的零散用量，跨会话、跨天、跨模型无法汇总；
- 翻看历史对话时，系统其实在「回放」历史用量，但你并不知道某次消耗到底发生在哪天；
- 想优化成本，却不知道哪些会话、哪些提示词最烧钱；
- 商业 AI 工具普遍把用量数据收在自己服务器，用户没有自己的副本。

trae-token-watcher 的定位就是：**把用量数据「还」给用户**——自动采集、本地留存、清晰呈现、智能诊断。

### 核心能力

| 能力          | 说明                                                               | 亮点                 |
| ----------- | ---------------------------------------------------------------- | ------------------ |
| **自动采集**    | 拦截 [www.trae.cn](http://www.trae.cn) 的 API 响应，提取 Token / 积分 / 费用 | 无感、零配置，打开网页即用      |
| **本地优先存储**  | 全部数据存浏览器 IndexedDB                                               | 不上传后端、隐私可控         |
| **仪表盘**     | 今日 / 本周 / 本月汇总、14 天趋势、模型分布、最近记录                                  | 一眼看清钱花在哪           |
| **准确的时间归因** | 历史会话归到它**真实发生的那天**，而非你「翻看它的那天」                                   | 解决「看历史把今天用量虚增」的难题  |
| **按会话去重**   | 同一 `session_id` 只保留一条最新快照                                        | 反复查看历史不产生重复数据      |
| **AI 诊断**   | 分析你的用法，给出省 Token / 省积分的优化建议                                      | 双路径：官方后端 or 自有 Key |
| **诊断历史**    | 每次诊断自动存档，可回看、可对比、可删除                                             | 优化建议「可追溯」          |

### 为什么它值得用

1. **隐私优先** —— 用量数据从不上传项目方服务器，连诊断都可走「自有 Key 直连」零后端模式。
2. **数据准确** —— 不是简单地记「采集时刻」，而是尽力还原每条用量对应的**真实会话时间**（详见第二节），所以「本月用了多少」是可信的。
3. **可回看** —— 诊断结论和历史快照都落盘，过两周想复盘「当初 AI 给我的建议是什么」随手能翻。
4. **零负担** —— 装完即忘，数据在后台自己长出来。

---

## 二、核心设计：时间归因与去重（重点）

这是本扩展最容易踩坑、也最能体现工程质量的地方，单独讲清楚。

### 2.1 为什么「时间」是个难题

TRAE 的用量数据来自 `get_session_usage` 接口，它返回的是**某个会话的累计 Token 总量**。问题在于：

- 这个响应**没有任何时间字段**（`usage_time` 恒为 `0`）；
- 当你**翻看一个历史会话**时，扩展会抓到这份历史真实用量，但如果把「你翻看它的此刻」当成用量发生时间，就会把历史消耗错误地算进「今天」——既虚增今日用量，又污染趋势图。

### 2.2 真实会话时间从哪来

真实对话时间在另一个接口 `chat_sessions` 的 `created_at` 字段（毫秒时间戳）。扩展在拦截到会话列表 / 详情响应时，建立一张 `session_id → created_at` 映射。

更关键的是：TRAE 的 `session_id` 是 **snowflake ID**，其前 8 位十六进制恰好等于该会话创建时间的秒数（已用真实样本验证，与 `chat_sessions.created_at` 精确吻合）。因此即使会话**不在已加载的列表里**，扩展也能用 `session_id` 前缀**反推出真实创建时间**——这是一个零网络开销、100% 可靠的兜底。

> 归因优先级：`chat_sessions.created_at`（最权威） → `session_id` 前缀反推（兜底） → 极特殊情况才退回采集时刻。

### 2.3 按会话去重

同一会话的 `get_session_usage` 是**累计聚合**，而且你每翻看一次就会触发一次采集。扩展对带 `session_id` 的记录采用**覆盖式去重**：同一会话始终只保留一条最新快照（旧记录先删后插）。这意味着：

- ✅ 反复查看历史会话不会产生重复数据；
- ✅ 同一会话后续用量增长时，快照自动更新为最新总量；
- ⚠️ 代价：一个进行中的会话，其「逐轮对话」明细会被合并成该会话的单条累计快照（这是累计聚合数据源本身的限制，也是用户确认接受的取舍）。

> 无 `session_id` 的实时请求（极少数边缘场景）保持原行为，每条独立入库。

---

## 三、安装

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本仓库的 `extension/` 目录
4. 打开 [www.trae.cn](https://www.trae.cn) 开始对话，Token 数据会自动采集

> 支持 Chrome / 兼容 Chromium 内核的浏览器（Edge 等）。



---

## 四、详细使用文档

### 4.1 概览：Popup 仪表盘

点击浏览器工具栏的扩展图标，打开仪表盘（暗色主题）。主要区域：

- **汇总卡片**：今日 / 本周 / 本月 的 Token 总量、积分消耗、缓存命中率等关键指标；
- **14 天趋势图**：直观看到用量随时间的变化；
- **模型分布**：你都在用哪些模型（如 GLM、DeepSeek 等），各自占比；
- **最近记录 / 会话级明细**：每条用量明细都带**真实会话时间**，以及一枚**缓存命中率徽标 ♻NN%**（按 `缓存 / (输入 + 缓存)` 计算，≥50% 绿、≥20% 琥珀、更低红色），一眼看出哪次对话最依赖缓存；
- **诊断 Tab**：发起 AI 诊断 + 查看诊断历史；
- **底部工具条**（弹框右下角）：
  - **全屏**：在新标签页打开同一仪表盘，绕过 Chrome 弹框约 600px 的高度上限（弹框 UI 本身无法突破该浏览器硬限制）；
  - **浮窗**：在 [www.trae.cn](http://www.trae.cn) 页面内显示 / 隐藏一个常驻的用量浮层；
  - **设置**：打开扩展设置页（后端地址、API Key、云端同步等）。

### 4.2 Token 自动采集

- **无需任何配置**：只要扩展已加载、且你在 [www.trae.cn](http://www.trae.cn) 上活动，采集就在后台进行。
- **采集内容**：输入 Token、输出 Token、缓存读取 Token、缓存写入 Token、总 Token、积分（credits）、费用（cost_money）、模型名、提问预览（user_input_preview）。
- **采集来源**：扩展以 MAIN WORLD 注入方式拦截页面的 `fetch` / `XMLHttpRequest` / `EventSource` / `WebSocket`，从响应体中解析用量字段（兼容 TRAE 的 `extra_info.input_token` 等真实字段结构）；扩展对所有 `*.trae.cn` 子域（含 `www.trae.cn`、`api.trae.cn`）生效，由 `manifest.json` 的 `content_scripts.matches` 控制。
- **主动增量拉取**：用户一进入 www.trae.cn（顶层页面），扩展默认在约 1.5s 后主动调用「用量明细」批量接口 `https://api.trae.cn/trae/api/v1/pay/query_user_usage_group_by_session`，**增量**拉取用量并写入账本，无需逐会话翻看；该接口每条记录自带真实 `usage_time`，时间归因直接用真实发生时刻，比逐会话 `get_session_usage`（无时间字段、需 snowflake 反推）更准确、更完整。要点：
  - **增量续拉（防重复请求）**：首次进入拉**最近 30 天**；之后把「上次成功拉取覆盖到的时间上界」持久化到 `localStorage`（`__ttw_bulk_last_end__`），每次进站点只拉 `[上次边界, 当前时刻]` 这段增量，不再全量重拉——避免短时间高频请求被服务端限流 / 拉黑。
  - **边界推进条件**：仅当整段增量完整翻到末页时，才把边界推进到当前时刻；若中途某页失败，保留旧边界、下次续拉该段（按 `session_id` 去重，重复入库安全）。
  - **串行 + 限频**：逐页**串行**请求（每页间隔 300ms），直到覆盖到上次时间边界（末页不足一页 / 整页早于窗口下界即停）；距上次成功增量 **< 60s** 时自动跳过本次自动拉取（冷却），防止刷新 / 重开页面造成的请求轰炸。
  - **鉴权自动捕获**：接口需要 `authorization: Cloud-IDE-JWT <jwt>` 头。扩展在 `XMLHttpRequest.setRequestHeader` 处机会性抓取页面任意请求的该 JWT（登录后几乎所有 API 请求都带它），持久化到 `localStorage`（`BULK_AUTH_KEY`，带过期检查）并在重放时注入——无需你手动配置 token；
  - **参数对齐服务端**：`page_size` 沿用页面真实值（约 20），不强制放大。曾因传 `page_size=100` 触发服务端上限校验返回 `code 9004「订单参数错误」`，已修复；
  - **分页上限**：最多翻 100 页（约 2000 条）；
  - **去重**：批量数据标记为 `bulk-usage` 并 `skipRefill`，直接采用权威 `usage_time`，不再反推 / 补拉会话详情，避免海量冗余请求。
- **时间归因**：如前所述，记录会归到会话真实发生日，而非采集时刻。
- **工具栏角标**：部分模式下工具栏图标会显示用量角标，便于快速感知。

### 4.3 数据回看与导出

- 仪表盘的「最近记录」可逐条查看；
- 所有原始数据在浏览器 IndexedDB 中，可通过扩展设置里的「清空记录」重置（注意：清空后不可恢复，且**已按错误时间入库的历史数据清空重采才能校正**）。

### 4.4 AI 诊断（双路径）

诊断功能分析你的 Token 用法，输出优化建议（如：哪些提示词可以精简、如何借助缓存命中降低消耗、模型选型建议等）。

```
诊断请求
  ├─ 已登录 + 已 Star 项目 + 后端可用 → 路径 A（官方后端转发 DeepSeek，限 10 次/天，结果缓存 1h）
  └─ 否则 → 路径 B（填入自己的 DeepSeek API Key，直连 DeepSeek，不限次数，零后端）
```

**怎么用（路径 B，最推荐、最隐私）：**

1. 在「诊断」Tab 找到 API Key 输入框；
2. 粘贴你自己的 DeepSeek API Key，点保存（加密存入 `chrome.storage.local`）；
3. 点「诊断我的 Token 用法」；
4. 诊断结果直接在本地渲染，请求直连 DeepSeek，不经过任何中间服务器。

**路径 A：** 点「用 GitHub 登录」并给项目 Star 后，即可免 Key 使用官方后端转发（免费、限流、缓存）。详见第八节。

### 4.5 诊断历史

每次诊断成功（无论路径 A 还是路径 B）都会**自动存档**一条记录到 IndexedDB，包含：

- **时间**：诊断执行时刻；
- **模式**：快速诊断 / 深度分析；
- **路径**：A（官方后端）/ B（自有 Key）；
- **效率评分**：从诊断结论中自动解析出的评分；
- **用量快照**：诊断那一刻的今日 / 本月 Token·积分、缓存率、累计次数；
- **完整结论**：完整的 AI 诊断文本。

**怎么查看：**

1. 切到「诊断」Tab，向下滚动到「诊断历史」区块；
2. 列表按时间倒序展示，显示标题、模式、路径、评分与记录数；
3. **点击任意条目**展开，查看当时的完整诊断结论和用量快照；
4. 单条右侧可**删除**；区块顶部「清空」按钮可**一键清空全部历史**（带二次确认）。

> 历史列表默认展示最近 50 条（数据库保留全部），避免面板过长。

---

## 五、项目结构

```
extension/                    # Chrome 扩展（MV3）
├── manifest.json             # 配置：双内容脚本 + 权限
├── content/
│   ├── inject.js             # 主世界：拦截 fetch/XHR/EventSource/WebSocket，提取 token 用量 + 时间归因 + 去重 + 主动批量拉取(query_user_usage_group_by_session)
│   └── content.js            # 隔离世界：中转消息到 background
├── background/
│   └── background.js         # Service Worker：存储 + 消息路由 + badge + 诊断入口
├── lib/
│   ├── db.js                 # IndexedDB 封装（usage-records + diagnoses 两表）
│   └── auth.js               # OAuth 客户端 + 双路径诊断入口
├── popup/
│   ├── popup.html / .css     # 仪表盘 UI（暗色主题）
│   ├── popup.js              # 统计 + 趋势 + 账号 + 双路径诊断 + 诊断历史渲染
│   ├── callback.html / .js   # OAuth 回调页：接收 token 存入 storage
└── icons/                    # 扩展图标

worker/                       # Cloudflare Workers 后端（可选，自部署时才需要）
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

---

## 六、数据流

```
www.trae.cn 页面
    │ fetch / XHR / EventSource / WebSocket 响应
    ▼
inject.js (主世界拦截)
    │ 1. 解析 token 用量字段
    │ 2. 解析 / 反推真实会话时间（chat_sessions.created_at 或 snowflake 前缀）
    │ 3. 按 session_id 去重
    └─ postMessage ──▶ content.js (隔离世界)
                          │ chrome.runtime.sendMessage
                          ▼
                    background.js (Service Worker)
                          │ IndexedDB 写入（带去重）
                          ▼
                    IndexedDB (本地)
                          ▲
                    popup.js (直读)
                          │
                    仪表盘 / 诊断历史渲染
```

---

## 七、技术选型

| 层      | 技术                           | 说明                                                   |
| ------ | ---------------------------- | ---------------------------------------------------- |
| 采集     | Content Script (MAIN world)  | document_start 注入，覆盖 fetch/XHR/EventSource/WebSocket |
| 存储     | IndexedDB                    | 本地优先，用量数据不上传                                         |
| 前端     | 原生 HTML/CSS/JS（popup）        | 暗色主题，零框架依赖                                           |
| 后端（可选） | Cloudflare Workers + D1 + KV | 身份认证 + Star 校验 + 诊断转发                                |
| 诊断 A   | DeepSeek API（后端转发）           | Star 用户免费，限 10 次/天，结果缓存 1h                           |
| 诊断 B   | DeepSeek API（直连）             | 用户自带 Key，不限次数，无后端                                    |

---

## 八、后端服务（自部署指南）

后端代码在 `worker/` 目录，部署到 Cloudflare Workers。

**普通用户无需关心这一节** —— 扩展默认走项目方运营的官方 Worker（`trae-token-watcher-api.ai-kits.workers.dev`），装完扩展点「用 GitHub 登录」即可使用。

仅在以下情况需要自部署：

- 企业内网 / 数据合规要求
- 隐私敏感场景，不希望 session 经过第三方 Worker
- 想为社区分担官方 Worker 流量

### 8.1 创建 GitHub OAuth App

- 访问 <https://github.com/settings/developers> → New OAuth App
- **Authorization callback URL** 填：`https://<你的-worker-域名>/auth/callback`
- 记下 Client ID 和 Client Secret

> ⚠️ **自部署必须** 用 `npm run secret:github-id` 和 `npm run secret:github-secret` 把它们配置成 Worker Secrets。
>
> 漏配会导致登录时跳转到 `https://github.com/login/oauth/authorize?client_id=undefined` 并返回 404。

### 8.2 创建 Cloudflare 资源

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

### 8.3 配置 Secrets

```bash
npm run secret:github-id        # 粘贴 GitHub OAuth Client ID
npm run secret:github-secret    # 粘贴 GitHub OAuth Client Secret
npm run secret:deepseek         # 粘贴后端转发用的 DeepSeek API Key
npm run secret:session          # 粘贴 32+ 字节随机串（session 签名密钥）
```

### 8.4 部署

```bash
npm run deploy
# 记下输出的 Worker 域名，如 https://trae-token-watcher-api.<你>.workers.dev
```

### 8.5 扩展端配置（仅自部署用户）

默认无需任何配置。若你自部署了 Worker，打开扩展设置页 →「云端同步」→ 展开「高级 · 自部署后端」→ 填入你的 Worker 域名并保存，扩展即切换为自部署模式（顶部状态标签会变成「自部署」）。

---

## 九、为什么 GitHub 登录需要后端服务？

**答：默认情况下用户不需要做任何配置** —— 扩展自带项目方运营的官方 Worker 地址，装完点登录即可。

但 GitHub OAuth 本质上必须有服务端中转，这是 GitHub 协议的硬约束，不是设计选择：

1. **`client_secret` 不能放进扩展** —— GitHub 换 token 接口要求带 `client_secret`，扩展代码对所有用户可见，放进去会被盗用冒充。
2. **OAuth 回调必须是公网 HTTPS** —— GitHub 只接受 `https://...` 的 callback URL，不接受 `chrome-extension://...`，所以回调只能落到 Worker 的 `/auth/callback`。

早期版本要求每个用户自部署 Worker，这是糟糕的设计——把项目方该承担的复杂度转嫁给了终端用户。**当前版本已修正**：默认走官方 Worker，复杂性吸收在项目方，对用户不可见。仅在合规 / 隐私场景才需要在「高级设置」里切换到自部署。

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

所以「后端服务」是扩展发起 OAuth 的入口。默认情况下扩展已经知道官方 Worker 在哪，用户什么都不用填；自部署模式下才需要在「高级设置」里切换。

---

## 十、常见问题排查

### 采集 / 时间 / 历史相关

| 现象                        | 原因                                         | 解决                                                                                     |
| ------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| 今日用量被「翻看历史会话」虚增           | 旧版本把采集时刻当用量时间                              | 升级到含「时间归因」的版本；旧的错误数据需清空重采校正                                                            |
| 历史记录显示的时间是「今天」而非真实发生日     | 该会话的真实时间未被捕获，回退到了采集时刻                      | 确认使用最新版；最新版已用 `session_id` 反推兜底，覆盖绝大多数情况                                               |
| 同一会话出现多条重复记录              | 未启用按会话去重（旧版）                               | 最新版默认按 `session_id` 覆盖去重，重采后自动合并                                                       |
| 想彻底重置数据                   | ——                                         | 扩展设置 →「清空记录」                                                                           |
| 主动拉取报 `401`               | JWT 未捕获或已过期（扩展刚加载、尚未抓到页面的 `Cloud-IDE-JWT`） | 重新加载扩展后再刷新一次 [www.trae.cn](http://www.trae.cn) 页面，让扩展捕获到带鉴权头的请求；token 会自动持久化复用         |
| 主动拉取报 `code 9004「订单参数错误」` | 曾因 `page_size=100` 触发服务端上限校验               | 当前版本已沿用页面真实 `page_size`（约 20）；若仍出现，请在控制台贴 `[bulk] 探测 POST ... → status=...` 日志及响应体     |
| 主动拉取 `404`                | 把相对接口路径拼到了 `www.trae.cn` 而非真实 host         | 当前版本已固定为 `api.trae.cn` 绝对路径；若仍 404，确认访问的是 `*.trae.cn` 站点（扩展只对 `*.trae.cn` 生效）          |
| 进入站点后完全没有自动拉取日志           | 未命中顶层 frame 或扩展未注入                         | 确认扩展已启用、访问的是 [www.trae.cn](http://www.trae.cn) 顶层页面，并查看控制台是否出现 `[bulk] 已调度主动拉取最近 30 天` |

### 登录 / 后端相关

| 现象                                | 原因                                                            | 解决                                                                          |
| --------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 登录跳转到 `client_id=undefined` 后 404 | Worker 没配置 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` secret | `cd worker && npm run secret:github-id`、`npm run secret:github-secret` 重新设置 |
| 登录后报「Worker 未配置 ...」              | 同上，secret 未生效                                                 | 重新 `wrangler secret put`，并用 `wrangler secret list` 确认                       |
| 已 Star 但诊断报 403                   | KV 绑定名错误，Star 缓存写不进                                           | 检查 `wrangler.toml` 中 KV `binding = "KV"`，重新 `wrangler deploy`               |
| OAuth 回调报 `redirect_uri mismatch` | GitHub OAuth App 的 callback URL 与 Worker 域名不一致                | 去 GitHub OAuth App 设置改为 `https://<worker域名>/auth/callback`                  |
| 扩展点登录没反应（默认模式）                    | 官方 Worker 临时不可达                                               | 等待恢复，或在「高级」里临时切到自部署                                                         |
| 扩展点登录没反应（自部署模式）                   | 自部署 Worker 未部署或地址填错                                           | 检查 Worker 状态与填入的 API 地址                                                     |

---

## 十一、后续路线

- **M3 完善** —— 诊断 Prompt 工程优化、用量趋势预测、团队管理
- **数据导出** —— 支持将用量账本 / 诊断历史导出为 CSV / JSON
- **跨设备同步** —— 在用户明确授权下，支持可选的加密云端备份

---

## 十二、设计文档

详见 [docs/design/design.html](docs/design/design.html)
