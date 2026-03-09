# neoclaw Web 管理后台 v1 设计方案

更新时间：2026-03-07

## 1. 目标与结论

### 1.1 目标

为 `neoclaw` 提供一个真正可长期使用的 Web 管理后台，而不是继续在初始化引导页上堆功能。

这版后台需要满足以下目标：

- 让用户在**不依赖任何 Telegram / DingTalk / Feishu 等 channel** 的情况下，直接通过 Web 和 Agent 交互。
- 提供一个真正的 **Dashboard**，用于总览状态、进入管理入口，而不是把所有功能都堆在同一页。
- 提供独立的 **Cron 管理页面**。
- 提供独立的 **Skills 管理页面**，同时支持：
  - 列出现有 skills
  - 搜索本地 skills
  - 基于 `clawhub` 的市场搜索
  - **纯命令安装** skill，而不是让 agent 安装，避免额外 token 消耗
- 保留 **配置管理页面**，并在该页面统一管理：
  - agent
  - models / providers
  - channels
  - 配置导入 / 导出 / 快照 / 回滚

### 1.2 明确结论

这版后台应当收敛为：

- `Wizard`：初始化引导，仅一次性使用
- `Dashboard`：总览与导航入口
- `Chat`：网页内正式聊天
- `Config`：唯一配置编辑中心
- `Cron`：定时任务管理
- `Skills`：本地 skills + 市场安装

不再继续扩展“引导页增强版”模式，也不再拆出大量重复页面，例如单独的 channels 页面、单独的 runtime 页面、单独的测试页面。

---

## 2. 当前仓库现状与约束

### 2.1 已有能力

当前仓库中已经具备若干可直接复用的能力：

#### Web 相关

- 已有 Web 命令与基础后端：`src/commands/web.ts`
- 已有前端单页工程：`webapp/`
- 已有配置读取、保存、导入导出、快照、回滚能力
- 已有运行时状态接口：`/api/runtime-status`
- 已有测试聊天接口：`/api/chat/test`

#### 会话与记忆

- 已有持久化会话管理：`src/session/manager.ts`
- 会话以 `jsonl` 存储，可追加消息、清空、裁剪、读取
- Agent 正常消息链路已经使用 `SessionManager`
- 已有 `MemoryManager` 与记忆检索能力

#### Cron

- 已有 `CronService`
- 已支持 `list / add / remove / pause / resume`
- 已有 CLI 命令封装，说明服务逻辑已较完整

#### Skills

- 已有 `SkillManager`
- skills 来源为 `workspace/skills/*/SKILL.md`
- 已支持列出 skills、解析名称/描述、解析路径
- Agent 在会话时会动态读取 skill 路径，因此本地安装 skill 具备较好的接入基础

### 2.2 现有不足

- Web 目前更像“配置引导页”，不是真正后台
- 页面结构混合了引导和维护心智
- 没有正式的网页聊天页
- 没有 Cron 页面
- 没有 Skills 页面
- 没有 `clawhub` 纯命令式集成接口
- Dashboard 仍为空缺

### 2.3 本方案的边界约束

本方案只设计 **Web 管理后台 v1**，不扩展到：

- 多用户后台
- 多 agent 管理平台
- 云端 skill 市场服务本身
- 复杂权限系统
- 对 channel 进行完整调试模拟

---

## 3. 信息架构

## 3.1 顶层结构

建议采用以下路由结构：

- `/wizard`
- `/app/dashboard`
- `/app/chat`
- `/app/config`
- `/app/cron`
- `/app/skills`

### 3.2 进入规则

- 若尚未完成基础配置，则默认进入 `/wizard`
- 若已完成基础配置，则默认进入 `/app/dashboard`

“基础配置已完成”的最小判断规则：

- `agent.model` 非空
- `agent.workspace` 非空

### 3.3 跳转规则

- `Wizard` 完成后：进入 `Dashboard`
- `Wizard` 顶部提供 “进入后台” 按钮
- 后台顶部提供 “重新打开向导” 按钮
- `Dashboard` 作为后台主入口，所有管理页从这里进入

### 3.4 导航原则

后台只保留有限的一级导航：

- Dashboard
- Chat
- Config
- Cron
- Skills

不再拆更多页面，避免稀释功能、制造重复。

---

## 4. 页面设计

## 4.1 Wizard（初始化引导页）

### 页面目标

只负责用户第一次配置环境，完成后退出主舞台。

### 功能范围

- 选择 provider / 拉取 model
- 配置 agent 基础项
- 配置 channels
- 保存配置
- 启动 agent
- 进入后台

### 不负责的内容

- 不承载长期配置管理
- 不承载快照历史浏览
- 不承载网页正式聊天
- 不承载 cron 管理
- 不承载 skills 管理

### 与后台关系

它是后台的“前置入口”，不是后台本身。

---

## 4.2 Dashboard

### 页面目标

让用户在进入后台后，第一眼知道：

- agent 现在能不能用
- 配置有没有完成
- channels 是否开启
- cron 和 skills 大概是什么状态
- 下一步去哪个页面

### 页面模块

#### 1）Agent 状态卡

展示：

- Agent 是否运行
- 当前 model
- 当前 workspace
- 当前 profile / baseDir
- 最近错误摘要（如有）

操作：

- 启动 Agent
- 打开向导

#### 2）Channels 摘要卡

展示：

- CLI 是否开启
- Telegram 是否开启
- DingTalk 是否开启
- Feishu 是否开启
- 缺失关键字段的 warning

操作：

- 跳转到 `Config`

#### 3）Cron 摘要卡

展示：

- 当前任务总数
- 启用数量
- 暂停数量
- 最近一次 / 下一次执行时间（若可得）

操作：

- 跳转到 `Cron`

#### 4）Skills 摘要卡

展示：

- 已安装 skills 数量
- 最近刷新时间
- 市场可用状态（clawhub 是否可用）

操作：

- 跳转到 `Skills`

#### 5）快捷入口

- 去聊天
- 去配置管理
- 去 Cron
- 去 Skills

### 明确不放的功能

Dashboard 不直接放：

- 导入/导出
- 快照回滚
- 完整配置表单
- Skill 安装
- Cron 新建表单

它只负责概览和导航。

---

## 4.3 Chat（网页聊天页）

### 页面目标

让用户在没有任何外部 channel 的情况下，直接通过网页与 Agent 对话，并把它作为**正式使用场景**而不是临时测试面板。

### 页面布局

建议采用两栏布局：

- 左侧：会话列表
- 右侧：当前对话窗口

### 核心功能

#### 会话列表

- 新建会话
- 会话切换
- 删除会话
- 清空会话
- 显示会话标题（可用首条消息摘要）
- 显示最后更新时间

#### 聊天区域

- 展示用户消息
- 展示 Agent 回复
- 支持流式显示回复
- 输入框发送消息
- 支持回车发送 / Shift+Enter 换行
- 支持“停止生成”
- 支持“新建会话”按钮

### Markdown 渲染要求

网页聊天必须做比当前“测试聊天文本块”更正式的渲染。

应支持：

- 标题
- 段落
- 列表
- 引用
- 表格
- 分割线
- 行内代码
- 代码块
- 链接

渲染要求：

- 禁止直接渲染任意 HTML，避免 XSS
- 链接新窗口打开
- 代码块保留换行和横向滚动
- 长表格可横向滚动
- 引用、列表、段落间距明确
- 行内代码与代码块视觉区分明显

建议实现：

- 继续沿用项目已有 `markdown-it` 方向
- 在前端加入统一的 markdown 渲染层，而不是手写简单字符串格式化

### 对话是否持久化存储

#### 最终决策

**Chat 页中的对话默认全部持久化保存。**

#### 原因

- 网页聊天是正式入口，不是调试工具
- 用户刷新页面后丢上下文会很差
- 仓库已具备 `SessionManager`，有能力承载这个需求

#### 但需要区分两类聊天

1. **正式 Web Chat**
   - 保存到正式会话
   - 用于长期上下文
   - 可在会话列表中复用

2. **Config 页中的连通性测试聊天**
   - 不保存到正式会话
   - 不污染真实会话历史
   - 仍可保留为临时探活工具

#### 存储策略

- 为网页聊天引入独立会话 key 前缀：
  - `webchat:<sessionId>`
- 继续复用 `SessionManager`
- 每个网页会话映射到一个 session 文件

### 与 Agent 的交互方式

需要新增正式聊天接口，而不是继续复用 `/api/chat/test`。

建议新增：

- `GET /api/chat/sessions`
- `POST /api/chat/sessions`
- `GET /api/chat/sessions/:id`
- `POST /api/chat/sessions/:id/messages`
- `POST /api/chat/sessions/:id/clear`
- `DELETE /api/chat/sessions/:id`

### v1 不做的内容

- 多人协作会话
- 富媒体上传
- 会话重命名 AI 自动总结
- 搜索全量聊天记录
- 对话分叉

---

## 4.4 Config（配置管理页）

### 页面目标

作为唯一配置编辑中心，统一完成：

- agent 配置
- model / provider 配置
- channel 配置
- 配置资产管理（导入导出、快照回滚）

### 页面模块

#### 1）Agent 配置区

- 主模型
- 代码模型
- workspace
- memoryWindow
- logLevel

#### 2）Provider / Model 区

- providers 列表
- 自定义 provider API 格式
- 拉取 model
- 模型刷新

#### 3）Channels 区

- CLI
- Telegram
- DingTalk
- Feishu

每个区块直接编辑，不再单独拆 channels 页面。

#### 4）配置资产区

这是唯一允许出现导入导出和快照功能的页面。

功能：

- 导出配置
- 导入配置
- 快照列表
- 快照预览
- 回滚

#### 5）保存与校验区

- 保存配置
- 错误提示
- 保存成功提示

### 设计原则

- 所有配置资产能力只在这里出现一次
- 不在 Dashboard、Chat、Cron、Skills 中重复放导入/导出/回滚

---

## 4.5 Cron（定时任务页）

### 页面目标

将已有 `CronService` 能力显式后台化。

### 页面模块

#### 1）任务列表

字段展示：

- id
- type：`every / at / cron`
- schedule
- enabled
- nextRun
- message
- channel
- chatId

#### 2）任务操作

- 新建任务
- 暂停任务
- 恢复任务
- 删除任务

#### 3）新建任务表单

- 类型选择
- `every` 秒数
- `at` 时间
- `cron` 表达式
- message
- channel
- chatId

#### 4）筛选

- 全部 / 启用 / 暂停
- 按类型过滤
- 搜索 message

### 实现取舍

v1 建议：

- 只做 `list / add / pause / resume / remove`
- 不做“编辑已有任务”
- 如果要改内容，则删除后重建

原因：

- 当前后端已有这些能力
- 改动最小
- 上线最快

### 新增接口建议

- `GET /api/cron/jobs`
- `POST /api/cron/jobs`
- `POST /api/cron/jobs/:id/pause`
- `POST /api/cron/jobs/:id/resume`
- `DELETE /api/cron/jobs/:id`

---

## 4.6 Skills（Skills 管理页）

### 页面目标

统一完成两类任务：

- 管理本地已安装 skills
- 基于 `clawhub` 搜索和安装 skills

### 页面结构

建议用双 Tab：

- `已安装`
- `市场`

### 4.6.1 已安装 Tab

#### 数据来源

直接读取：

- `workspace/skills/*/SKILL.md`

复用：

- `SkillManager`

#### 页面功能

- 列出现有 skills
- 搜索（按名称 / 描述）
- 查看名称、描述、目录名、路径
- 查看 `SKILL.md` 内容
- 删除 skill
- 刷新列表

#### 推荐展示字段

- skill 名称
- description
- 目录名
- `SKILL.md` 相对路径
- 最近修改时间（可后续补）

### 4.6.2 市场 Tab

#### 目标

基于 `clawhub` CLI 实现 skill 搜索与安装，**不通过 agent**。

#### 核心原则

- 搜索不走 prompt
- 安装不走 prompt
- 纯命令执行
- 不消耗 token

#### 页面功能

- 搜索框
- 搜索结果列表
- 显示 name / 简介 / 来源
- 安装按钮
- 安装状态提示
- 安装成功后刷新本地 skills 列表

### 为什么必须走 CLI

如果通过 agent 去“理解技能市场并执行安装”，会带来：

- token 消耗
- 响应不稳定
- 安装参数不可控
- 安全边界模糊

而本方案中：

- 前端只传 query / name
- 后端直接跑固定命令
- 结果可控、可复现、成本低

### 新增接口建议

#### 本地 skills

- `GET /api/skills/local`
- `GET /api/skills/:name`
- `DELETE /api/skills/:name`

#### clawhub 市场

- `GET /api/skills/market/health`
- `POST /api/skills/market/search`
- `POST /api/skills/market/install`

### 安全约束

前端不能传任意 shell 命令。

后端只接受结构化参数：

- search：`query`
- install：`name`

后端内部固定命令拼装，例如：

- `clawhub search <query>`
- `clawhub install <name>`

并固定：

- cwd
- 目标安装目录
- 超时
- 输出长度

### clawhub 可用性检查

建议提供专门健康接口：

- `GET /api/skills/market/health`

返回：

- CLI 是否存在
- 版本
- 错误提示

若未安装，则 Skills 市场页直接提示如何安装，而不是让用户点安装后才失败。

---

## 5. API 设计

## 5.1 复用现有接口

### Config 相关

- `GET /api/config/current`
- `GET /api/config/export`
- `GET /api/config/snapshots`
- `GET /api/config/snapshots/:id`
- `POST /api/config/import`
- `POST /api/config/rollback`
- `POST /api/config/save`

### Runtime 相关

- `GET /api/runtime-status`
- `POST /api/agent/start`

### 测试聊天

- `POST /api/chat/test`

它仍保留，但仅作为 Config 页的临时连通性测试接口。

## 5.2 新增接口：Dashboard

v1 不强制新增单独 dashboard summary 接口。

Dashboard 可先通过聚合以下接口完成：

- `/api/runtime-status`
- `/api/config/current`
- `/api/cron/jobs`
- `/api/skills/local`

若后续前端聚合过重，再补：

- `GET /api/dashboard/summary`

## 5.3 新增接口：Chat

- `GET /api/chat/sessions`
- `POST /api/chat/sessions`
- `GET /api/chat/sessions/:id`
- `POST /api/chat/sessions/:id/messages`
- `POST /api/chat/sessions/:id/clear`
- `DELETE /api/chat/sessions/:id`

### 返回约定建议

#### Session 列表项

- `id`
- `title`
- `createdAt`
- `updatedAt`
- `messageCount`

#### Session 详情

- `id`
- `messages`
  - `role`
  - `content`
  - `timestamp`

#### 发送消息

- 请求：`message`
- 返回：
  - v1 可先用非流式
  - 若前端体验优先，可直接设计为 SSE 或 chunked streaming

建议：

- v1 先做**单请求流式输出**
- 因为 Chat 页是正式功能，流式很重要

## 5.4 新增接口：Cron

- `GET /api/cron/jobs`
- `POST /api/cron/jobs`
- `POST /api/cron/jobs/:id/pause`
- `POST /api/cron/jobs/:id/resume`
- `DELETE /api/cron/jobs/:id`

## 5.5 新增接口：Skills

### 本地

- `GET /api/skills/local`
- `GET /api/skills/:name`
- `DELETE /api/skills/:name`

### 市场

- `GET /api/skills/market/health`
- `POST /api/skills/market/search`
- `POST /api/skills/market/install`

---

## 6. 前端结构拆分

## 6.1 路由层

建议新增页面目录：

- `webapp/src/pages/wizard/*`
- `webapp/src/pages/app/dashboard/*`
- `webapp/src/pages/app/chat/*`
- `webapp/src/pages/app/config/*`
- `webapp/src/pages/app/cron/*`
- `webapp/src/pages/app/skills/*`

## 6.2 公共壳层

- `AdminLayout`
- `TopNav`
- `SidebarNav`（若页面数量固定，也可简化为顶部 tabs）
- `StatusCard`
- `SectionCard`
- `EmptyState`
- `ConfirmModal`

## 6.3 Chat 页面组件

- `ChatSessionList`
- `ChatWindow`
- `ChatComposer`
- `MarkdownMessage`
- `ChatMessageBubble`
- `ChatEmptyState`

## 6.4 Config 页面组件

- `AgentConfigForm`
- `ProviderConfigPanel`
- `ChannelsConfigPanel`
- `ConfigImportExportPanel`
- `SnapshotList`
- `SnapshotPreviewModal`

## 6.5 Cron 页面组件

- `CronList`
- `CronFilters`
- `CronCreateForm`
- `CronRowActions`

## 6.6 Skills 页面组件

- `SkillsTabs`
- `LocalSkillsList`
- `LocalSkillDetail`
- `MarketSearchBar`
- `MarketSearchResults`
- `InstallSkillButton`
- `ClawhubHealthBanner`

---

## 7. 关键实现决策

## 7.1 为什么不再做很多独立页面

因为会导致：

- 功能重复
- 心智分散
- 小白用户不知道去哪一页改东西

因此 v1 只保留 5 个后台页面。

## 7.2 为什么 Config 页统一管理 agent/model/channels

因为这些配置最终都落在同一个配置文件上。

如果拆成多个页面：

- 会产生保存边界不清晰
- 用户会感到“明明都属于配置，为什么分开”
- 容易重复出现导入导出等资产功能

## 7.3 为什么 Chat 页要单独存在

因为“网页直接和 Agent 对话”已经是独立主场景，不再只是测试工具。

它需要：

- 会话管理
- 正式持久化
- 正式 markdown 渲染
- 正式输入输出体验

这和 Config 页中的“临时测试聊天”完全不是一个功能层级。

## 7.4 为什么 Skills 市场必须是纯命令执行

因为这是一个确定性安装任务，不是开放式推理任务。

纯命令的好处：

- 不消耗 token
- 不依赖模型输出质量
- 更稳定
- 更安全
- 更好调试

---

## 8. 分阶段实施计划

## Phase 1：后台壳层与路由

### 目标

将当前单页结构拆成真正后台架构。

### 交付内容

- `/wizard`
- `/app/dashboard`
- `/app/config`
- `/app/chat`
- `/app/cron`
- `/app/skills`
- 公共后台导航壳层

### 验收标准

- 向导与后台彻底分离
- 后台有统一导航
- 已配置用户默认进入 Dashboard

## Phase 2：Config 页面迁移

### 目标

把当前已有配置能力迁移成正式配置页。

### 交付内容

- agent / model / channels 配置表单
- 导入 / 导出 / 快照 / 回滚
- 保存与校验

### 验收标准

- Config 页面成为唯一配置中心
- 导入导出与快照功能只在 Config 页面出现

## Phase 3：Chat 页面

### 目标

提供正式网页聊天。

### 交付内容

- 会话列表
- 持久化聊天
- markdown 渲染
- 流式回复
- 清空/删除/新建会话

### 验收标准

- 不使用任何 channel 即可聊天
- 刷新页面后会话仍在
- markdown 渲染正确且安全

## Phase 4：Cron 页面

### 目标

提供任务管理后台。

### 交付内容

- 列表
- 新建
- 暂停 / 恢复 / 删除
- 筛选

### 验收标准

- 所有现有 cron 核心能力可通过网页管理

## Phase 5：Skills 页面

### 目标

把本地 skills 与 clawhub 市场收敛到一个正式页面。

### 交付内容

- 本地 skills 列表
- 搜索本地 skills
- 查看 skill 详情
- 删除 skill
- 市场搜索
- 纯命令安装
- 安装后自动刷新本地列表

### 验收标准

- skills 管理不依赖 agent
- 安装不消耗 token
- 本地与市场都可用

---

## 9. 详细任务拆分

## 9.1 Phase 1 任务

### 前端

- 引入路由
- 拆分 `App.tsx`
- 新增后台壳层
- 新增导航与默认跳转逻辑

### 后端

- 补充默认入口逻辑（根据配置判断跳转）

### 文件建议

- `webapp/src/App.tsx`
- `webapp/src/main.tsx`
- `webapp/src/router.tsx`（新增）
- `webapp/src/layouts/AdminLayout.tsx`（新增）

## 9.2 Phase 2 任务

### 前端

- 将当前 Config 功能迁移为独立页面
- 移除向导中非必要配置资产功能暴露

### 后端

- 复用现有配置接口，无需大改

## 9.3 Phase 3 任务

### 后端

- 基于 `SessionManager` 新增 Chat 接口
- 设计 session key：`webchat:<id>`
- 支持会话列表、详情、追加消息、清空、删除
- 支持正式聊天接口（建议流式）

### 前端

- 会话列表 UI
- 聊天消息 UI
- markdown 渲染组件
- 流式显示

## 9.4 Phase 4 任务

### 后端

- 为 `CronService` 增加 Web API 包装层

### 前端

- 列表和表单 UI
- 操作按钮
- 过滤 UI

## 9.5 Phase 5 任务

### 后端

- 基于 `SkillManager` 增加本地 skills API
- 增加 `clawhub` health / search / install API
- 增加安全命令执行封装

### 前端

- Skills tabs
- 本地 skills 列表 + 搜索
- 市场搜索 + 安装
- 安装状态反馈

---

## 10. 风险与注意事项

## 10.1 Chat 持久化边界

需要确保：

- 正式网页聊天进入持久化
- 配置探活聊天不进入正式持久化

否则很容易污染真实会话历史。

## 10.2 Markdown 渲染安全

必须默认关闭原始 HTML 直出。

否则：

- 易出现 XSS
- 用户输入或模型输出可能注入恶意 HTML

## 10.3 Skills CLI 安装安全

必须避免：

- 前端传任意命令
- 后端直接 shell 拼接字符串

应使用：

- 固定命令
- 固定参数位置
- 固定 cwd
- 受控超时和输出长度

## 10.4 clawhub 依赖缺失

如果本地没有安装 `clawhub`：

- Skills 市场页必须优雅降级
- 给出明确提示
- 不影响本地 skills 页使用

## 10.5 路由迁移风险

当前前端代码集中在一个 `App.tsx` 中。

迁移后台路由时，需避免：

- 一次性重构过大
- 边迁边破坏现有向导功能

建议：

- 先把现有逻辑原样搬入 `WizardPage`
- 再逐步提取 `ConfigPage` / `ChatPage`

---

## 11. 验收标准

当以下条件全部满足时，可认为后台 v1 设计目标达成：

- 用户完成引导后进入 Dashboard，而不是继续停留在引导页
- 用户可直接通过 Web Chat 与 agent 正式对话
- Web Chat 会话会被持久化保存
- Chat 页支持安全且清晰的 Markdown 渲染
- Config 页面成为唯一配置中心
- Cron 页面可以完成任务增删停启
- Skills 页面可以查看本地 skills 并通过 `clawhub` 纯命令安装 skill
- 安装 skill 不依赖 agent，不消耗 token

---

## 12. 推荐开发优先级

推荐开发顺序：

1. 路由与后台壳层
2. Config 页面迁移
3. Chat 页面
4. Cron 页面
5. Skills 页面

如果资源有限，最小可交付顺序：

1. Dashboard
2. Config
3. Chat
4. Cron
5. Skills

其中：

- `Chat` 是用户感知价值最高的新能力
- `Skills` 是最贴近差异化能力的页面
- `Cron` 是最容易复用现有后端逻辑的一页


---

## 13. P0 / P1 / P2 排期与实施清单

本章节将前文的架构与页面方案进一步落成可执行任务，目标是让实现者拿到文档后，可以直接按阶段开工，而不需要再自行拆分范围。

## 13.1 排期原则

### P0

必须优先完成，完成后后台具备“可用骨架 + 正式网页聊天 + 配置中心”的最小闭环。

### P1

在 P0 基础上补齐“管理能力”，让后台真正具备运维与日常维护价值。

### P2

体验增强与效率增强，不影响后台主链路是否成立。

---

## 13.2 P0：后台骨架 + Config + Chat

### P0 目标

交付一个可以真正替代“引导页增强版”的后台最小闭环：

- 向导与后台彻底分离
- 有 Dashboard
- 有 Config 页面
- 有正式 Chat 页面
- 用户无需任何 channel 即可通过网页与 Agent 持续交互

### P0 用户价值

用户完成初始配置后，可以：

- 进入后台首页
- 查看当前运行状态
- 进入配置管理页修改配置
- 直接在网页中与 Agent 聊天
- 刷新页面后保留聊天记录

### P0 页面交付

#### 1）`/wizard`

保留现有向导能力，只做迁移，不继续扩展复杂后台功能。

#### 2）`/app/dashboard`

提供最小 Dashboard：

- Agent 状态卡
- 配置摘要卡
- Channels 摘要卡
- Chat / Config / Cron / Skills 快捷入口

#### 3）`/app/config`

迁移现有配置中心能力：

- agent / model / channels 配置
- 导入
- 导出
- 快照列表
- 快照预览
- 回滚
- 保存

#### 4）`/app/chat`

新增正式网页聊天页：

- 会话列表
- 会话创建
- 会话切换
- 会话清空
- 会话删除
- 发送消息
- 显示回复
- Markdown 渲染
- 持久化保存

### P0 后端任务拆分

#### A. 路由与页面入口

无需新增专门后端路由判断页面，只需继续沿用 Web 静态页入口，让前端路由接管。

#### B. Dashboard 数据接口

P0 不单独新增 `dashboard summary` 接口。

Dashboard 先直接拼装以下数据：

- `GET /api/runtime-status`
- `GET /api/config/current`
- `GET /api/config/snapshots`

如果前端聚合复杂度过高，再补 `GET /api/dashboard/summary`，但不作为 P0 阻塞项。

#### C. Chat 正式接口

P0 必须新增：

- `GET /api/chat/sessions`
- `POST /api/chat/sessions`
- `GET /api/chat/sessions/:id`
- `POST /api/chat/sessions/:id/messages`
- `POST /api/chat/sessions/:id/clear`
- `DELETE /api/chat/sessions/:id`

##### 实现规则

- 会话 ID 使用明确的 Web 前缀，例如：`webchat:<uuid>`
- 持久化层复用 `SessionManager`
- 配置页中的 `POST /api/chat/test` 继续保留，但它不进入正式会话体系
- `POST /api/chat/sessions/:id/messages` 建议直接实现流式响应

##### 是否流式

P0 决策：**是，直接做流式**。

原因：

- Chat 是正式页面，不是测试工具
- 如果一开始做成非流式，后续前端结构和接口还得再拆一次

#### D. 会话列表标题策略

P0 不做 AI 自动命名。

规则：

- 若会话有第一条用户消息，则使用其前若干字符作为标题
- 若还没有消息，则显示“新会话”

### P0 前端任务拆分

#### A. 路由壳层

新增：

- `router`
- `AdminLayout`
- 后台导航
- `WizardPage`
- `DashboardPage`
- `ConfigPage`
- `ChatPage`

#### B. Config 页面迁移

把当前 `App.tsx` 中现有配置相关逻辑迁入 `ConfigPage`：

- `configDraft`
- 导入/导出逻辑
- 快照预览逻辑
- 保存逻辑
- 运行时配置加载逻辑

#### C. Chat 页面

新增组件：

- `ChatSessionList`
- `ChatWindow`
- `ChatComposer`
- `MarkdownMessage`
- `ChatEmptyState`

#### D. Markdown 渲染

P0 必须做到：

- 禁止原始 HTML 直出
- 支持常见 Markdown 结构
- 代码块和链接正确渲染

### P0 文件拆分建议

#### 前端新增/重构

- `webapp/src/App.tsx`：仅保留应用入口与路由挂载
- `webapp/src/router.tsx`：新增
- `webapp/src/layouts/AdminLayout.tsx`：新增
- `webapp/src/pages/wizard/WizardPage.tsx`：新增，迁移现有引导页逻辑
- `webapp/src/pages/app/dashboard/DashboardPage.tsx`：新增
- `webapp/src/pages/app/config/ConfigPage.tsx`：新增
- `webapp/src/pages/app/chat/ChatPage.tsx`：新增
- `webapp/src/components/chat/*`：新增

#### 后端新增/重构

- `src/commands/web.ts`：新增 Chat 正式接口
- `src/session/manager.ts`：视需要补列表能力
- `src/agent/neovate-agent.ts`：评估是否抽出复用的 Web Chat 调用链

### P0 验收标准

- 能从向导进入后台
- Dashboard 可打开
- Config 页面功能不回退
- Web Chat 可创建会话并聊天
- 刷新页面后会话仍可继续
- Markdown 渲染符合安全要求

---

## 13.3 P1：Cron + Skills 管理页

### P1 目标

在 P0 后台闭环的基础上，补齐两类核心管理能力：

- Cron 任务管理
- Skills 管理与市场安装

### P1 用户价值

用户可以：

- 通过网页管理定时任务
- 查看当前安装的 skills
- 搜索本地 skills
- 通过 `clawhub` 纯命令安装新 skills

### P1 页面交付

#### 1）`/app/cron`

- 任务列表
- 新建任务
- 暂停 / 恢复 / 删除
- 基本筛选

#### 2）`/app/skills`

双 Tab：

- 已安装
- 市场

### P1 后端任务拆分

#### A. Cron Web API

新增：

- `GET /api/cron/jobs`
- `POST /api/cron/jobs`
- `POST /api/cron/jobs/:id/pause`
- `POST /api/cron/jobs/:id/resume`
- `DELETE /api/cron/jobs/:id`

##### 说明

- 直接复用 `CronService`
- 不做“编辑任务”接口
- 任务修改采用“删除并重建”的产品规则

#### B. Skills 本地 API

新增：

- `GET /api/skills/local`
- `GET /api/skills/:name`
- `DELETE /api/skills/:name`

##### 说明

- 基于 `SkillManager` 实现
- 补充文件路径、目录名、描述等返回字段
- `GET /api/skills/:name` 返回 `SKILL.md` 原文或解析结果

#### C. clawhub 市场 API

新增：

- `GET /api/skills/market/health`
- `POST /api/skills/market/search`
- `POST /api/skills/market/install`

##### 实现规则

- 后端直接执行 `clawhub` CLI
- 前端只能传结构化参数：`query`、`name`
- 不允许透传命令字符串
- 固定工作目录与安装路径
- 设置执行超时与输出长度上限

### P1 前端任务拆分

#### A. Cron 页面组件

- `CronList`
- `CronCreateForm`
- `CronFilters`
- `CronRowActions`

#### B. Skills 页面组件

- `SkillsTabs`
- `LocalSkillsList`
- `LocalSkillDetail`
- `MarketSearchBar`
- `MarketSearchResults`
- `InstallSkillButton`
- `ClawhubHealthBanner`

### P1 文件拆分建议

#### 前端

- `webapp/src/pages/app/cron/CronPage.tsx`
- `webapp/src/pages/app/skills/SkillsPage.tsx`
- `webapp/src/components/cron/*`
- `webapp/src/components/skills/*`

#### 后端

- `src/commands/web.ts`：新增 Cron / Skills 接口
- `src/services/cron.ts`：复用为主
- `src/agent/skill-manager.ts`：扩展为详情与删除所需能力，或新增轻量 service 包装

### P1 验收标准

- Cron 页面可完成任务增删停启
- Skills 页面可列出本地 skills
- Skills 页面可基于 `clawhub` 搜索并安装 skills
- 安装不依赖 agent，不消耗 token

---

## 13.4 P2：体验增强与效率增强

### P2 目标

增强后台的日常使用体验，但不改变主功能结构。

### P2 内容

#### Dashboard 增强

- 更完整的错误展示
- 最近操作记录
- 更丰富的摘要统计

#### Chat 增强

- 会话搜索
- 更好的标题生成
- 会话置顶 / 排序
- 复制消息
- 渲染细节优化（表格、代码高亮等）

#### Config 增强

- 未保存变更提示
- 更细粒度校验
- 保存前差异摘要

#### Cron 增强

- 更多筛选条件
- 任务复制能力
- 下一次执行时间计算显示优化

#### Skills 增强

- 本地 skills 搜索高亮
- 市场结果排序
- 已安装状态识别
- 安装日志详情

### P2 不做

P2 仍不建议扩展为：

- 多用户后台
- 多 agent 管理
- 复杂权限系统
- 远程 skill 市场服务托管

---

## 13.5 推荐实施顺序（细化版）

### 第 1 周 / 第一批提交

目标：先把后台架子立起来。

建议提交顺序：

1. 路由拆分与 `WizardPage` 迁移
2. `AdminLayout` + `DashboardPage` 占位版
3. `ConfigPage` 迁移，保证现有能力不回退

### 第 2 周 / 第二批提交

目标：完成 Web Chat 正式功能。

建议提交顺序：

1. Chat 会话接口
2. Chat 页面骨架
3. 流式消息与 Markdown 渲染
4. 会话持久化与刷新恢复

### 第 3 周 / 第三批提交

目标：补齐 Cron。

建议提交顺序：

1. Cron Web API
2. Cron 页面列表
3. Cron 创建与操作

### 第 4 周 / 第四批提交

目标：补齐 Skills。

建议提交顺序：

1. 本地 skills API
2. Skills 本地列表页
3. `clawhub` 健康检查
4. `clawhub` 搜索
5. `clawhub` 安装

---

## 13.6 每阶段的阻塞依赖

### P0 主要阻塞

- 前端是否引入路由
- Chat 是否直接实现流式接口
- Markdown 渲染库与安全策略确定

### P1 主要阻塞

- `clawhub` CLI 在目标环境是否可用
- Cron API 的参数校验与错误提示是否补齐

### P2 主要阻塞

- 不是技术阻塞，主要是时间与体验打磨优先级

---

## 13.7 最终推荐落地策略

如果只能做一版最有价值的后台，请按如下顺序保证收益最大化：

1. `Config` 不回退
2. `Chat` 做成正式入口
3. `Dashboard` 做成统一首页
4. `Cron` 完成基本管理
5. `Skills` 实现本地管理 + 纯命令安装

这意味着，真正的后台价值不是“再把引导页做大”，而是：

- 用 `Dashboard` 做入口
- 用 `Config` 做配置中心
- 用 `Chat` 做网页主交互入口
- 用 `Cron` 和 `Skills` 做高频管理功能

