# Neoclaw Web 配置向导技术设计（v2）

日期：2026-03-02

## 1. 背景

当前 Web 配置页是字段平铺（`config.json` 直映射），新手需要理解完整结构，容易配错。

目标是改成分步向导，且 **provider 配置方式跟随 Neovate Code 实际能力**，不是手写一套 provider 规则。

## 2. 本次调研结论（来自 node_modules 运行时）

通过 `@neovate/code` 运行时 `providers.list/models.list/providers.login.*` 实测：

- 当前环境可返回 **36 个 provider**（真实列表由 Neovate 决定）。
- provider 元数据可直接拿到：`id/name/env/apiEnv/api/apiFormat/hasApiKey/source`。
- 模型列表可直接拿到：`models.list`（按 provider 分组，含 `value=providerId/modelId`）。
- OAuth 登录能力实测支持：`github-copilot`、`qwen`、`codex`。
- 其余大多数内置 provider 为 API key 模式（`env` 非空）。

结论：**不需要 clone neovate 源码**，Web 端可直接基于 node_modules 的 runtime API 构建 provider 引导。

## 3. 用户体验目标（按你的要求调整）

1. Step 1 配置模型/provider
2. Step 2 配置 agent（模型下拉选择）
3. Step 3 配置 channels（多选 + 条件必填）

附加要求：

- Agent 参数里大部分是默认值，普通用户基本不需要改。
- built-in provider 优先走“选择 + 登录/填 key”的引导，不让用户直写大段 JSON。
- 只有 custom provider 才要求输入 `apiBaseURL + key`。

## 4. 范围与非目标

### 4.1 范围

- 重做 Web UI 为 3-step wizard。
- Provider 流程基于 Neovate runtime（providers/models/login API）。
- 对现有 `config.json` 保持兼容写回。

### 4.2 非目标

- 不改配置文件大结构。
- 不引入前端框架（继续内嵌原生 HTML/JS）。
- 不在 v2 首次交付里覆盖所有 provider 特殊高级参数。

## 5. Wizard 交互设计

## 5.1 Step 1: 模型 Provider

先显示 provider 下拉（数据来自 `providers.list`）。选择后按 provider 类型走不同分支。

### A. OAuth provider（如 github-copilot/qwen/codex）

- 显示“登录”按钮。
- 点击后调用 `providers.login.initOAuth`，返回 `authUrl`。
- 前端引导用户打开链接完成授权。
- 前端轮询 `providers.login.pollOAuth` / `providers.login.status`。
- 状态变成已登录后，允许进入“拉取模型”。

### B. API-key provider（绝大多数 built-in）

- 默认只展示 `API Key`。
- `baseURL` 仅在“高级设置”里可选展示（用于覆盖内置默认地址，不是主路径）。
- 用户填写后写入临时 draft（不立即落盘）。
- 点击“验证并拉模型”。

### C. Custom provider

- 才展示 `providerId/apiFormat/apiBaseURL/apiKey/headers`。
- 使用 OpenAI-compatible `/models` 发现模型（v2 首版）。

### 拉模型结果

- 统一产出模型列表 `{label, value}`。
- 成功后可进入 Step 2。

## 5.2 Step 2: Agent

默认只展示最小必要字段：

- `agent.model`（下拉，来源于 Step 1）
- `agent.workspace`

高级项折叠（默认沿用默认值，不强迫用户改）：

- `memoryWindow`
- `maxMemorySize`
- `consolidationTimeout`
- `subagentTimeout`
- `codeModel`
- `logLevel`

说明：`temperature/maxTokens` 当前 neoclaw runtime 未使用，不在主流程暴露。

## 5.3 Step 3: Channels

- 多选 channel：`cli / telegram / dingtalk`。
- 只渲染已选 channel 的字段。
- 必填即时校验：
  - telegram: `token`
  - dingtalk: `clientId/clientSecret/robotCode`

## 6. 后端 API 设计（web command 内新增）

## 6.1 Provider 相关

### `GET /api/providers/list`

返回 `providers.list` 的简化结果：

- `id/name/source/api/apiFormat/env/apiEnv/hasApiKey`
- `authType`（后端归一化）：`oauth | api-key | none | custom`

### `POST /api/providers/auth/start`

入参：`{ providerId }`

行为：调用 `providers.login.initOAuth`，返回 `authUrl/oauthSessionId/userCode`。

### `POST /api/providers/auth/poll`

入参：`{ oauthSessionId }`

行为：调用 `providers.login.pollOAuth`，返回 `pending/completed/error`。

### `POST /api/providers/auth/complete`

入参：`{ providerId, oauthSessionId, code }`

行为：调用 `providers.login.completeOAuth`。用于无浏览器/回调不可达时的手工补全。

### `POST /api/providers/models`

入参：

- built-in: `{ providerId, apiKey?, baseURL?, headers? }`
- custom: `{ mode: "custom", customProvider: {...} }`

行为：

- built-in：创建临时 `createSession({ providers: draftProviders })`，调用 `models.list` 并按 `providerId` 过滤。
- custom：走 OpenAI-compatible `/models`（仅 v2 custom 首版）。

返回：`models[]`。

## 6.2 保留配置接口

- `POST /api/config/test`
- `POST /api/config/save`
- `POST /api/chat/test`

## 7. 配置映射策略

## 7.1 Provider -> config.providers

- built-in api-key provider：写入 `config.providers[providerId].options.apiKey/baseURL/headers`
- oauth provider：通常不需要写 key，保留可选 override
- custom provider：写入 `config.providers[customProviderId]`

## 7.2 Agent 默认化

向导默认不改这些值（除非用户展开高级项并主动修改）：

- `memoryWindow` 默认 50
- `maxMemorySize` 固定默认 8192
- `consolidationTimeout` 默认 30000

## 7.3 OAuth 在 Linux Server（无浏览器）场景

这是常态部署场景，Web 向导必须支持“异机授权”：

1. 服务端发起 `auth/start`，拿到 `authUrl`（及可能的 `userCode`）。
2. 用户在本地有浏览器的电脑上打开该链接。
3. 对 device-code 流（如 github-copilot/qwen）：直接在本地浏览器完成授权，服务端持续 `auth/poll`。
4. 对需要回调的流（如 codex）：
   - 浏览器完成登录后会跳到 `http://localhost:xxxx/...`（在本地机无法回调到服务器）。
   - 引导用户复制回调 URL 中的 `code` 参数，粘贴到 Web 向导输入框。
   - 向导调用 `auth/complete` 完成登录。

这样可覆盖无 GUI 的纯 Linux 部署环境，不依赖服务器本地浏览器。

## 8. 与现有实现一致性问题（必须修）

当前 `ChannelManager` 仅在构造时按 enabled 创建 channel。

因此“保存后启用新 channel”不会即时生效。

必须改为动态启停：

- `false -> true`：创建并 `start()`
- `true -> false`：`stop()` 并移除
- `true -> true`：`updateConfig()`

## 9. 分阶段实施

### Phase 1: Provider runtime API 接入

- 新增 provider 列表/登录/模型拉取接口
- 打通临时 providers 草稿注入

### Phase 2: Wizard UI

- 完成 3-step 引导
- Agent 高级项折叠 + 默认值策略

### Phase 3: Channel 热更新修复

- 改造 `ChannelManager`
- 回归验证 telegram/dingtalk/cli 启停

## 10. 验收标准

- 新用户不编辑 JSON，按 3 步可完成配置。
- Step 2 模型只能从下拉选择（来源于 Step 1）。
- custom provider 才需要填 `apiBaseURL + key`。
- 启用新 channel 保存后可即时生效。

## 11. 需要你确认

1. `maxMemorySize` 固定为 `8192`（已确认）。
2. built-in API-key provider 默认只展示 `API Key`，`baseURL` 放高级折叠；custom provider 必须展示 `baseURL`（已确认）。
3. OAuth provider 首版先做 `github-copilot/qwen/codex`（已确认）。
