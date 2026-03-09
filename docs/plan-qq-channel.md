# neoclaw QQ Channel 接入调研与计划

更新时间：2026-03-08

## 1. 结论（更新版）

结合你补充的参考项目 `sliverp/qqbot`，当前更合理的结论是：

- **优先参考 openclaw 的官方 QQ Bot API 路线**
- **OneBot 11 兼容接入保留为备选 / 快速验证方案**

原因不是“OneBot 不能做”，而是：

- `openclaw` 现成参考已经证明 **QQ 开放平台 Bot API** 这条链路可落地
- 这条路线更接近“平台官方能力”，后续可维护性通常会更好
- `qqbot` 使用 **长连接事件订阅** 收消息，不需要暴露公网 webhook，这点对本地部署更友好

因此，对 `neoclaw` 的建议改为：

- **主方案：QQ 开放平台 Bot API channel**
- **备方案：OneBot 11 channel（NapCat / 兼容实现）**

## 2. 新参考：openclaw 的 `qqbot` 插件

你提供的参考仓库：

- [sliverp/qqbot](https://github.com/sliverp/qqbot)

从该仓库 README 可以确认几件关键事实：

- 它是 **Openclaw 的 QQ channel plugin**，基于 **QQ Open Platform Bot API**
- 支持 **C2C 私聊、群聊 @消息、频道消息**
- 它采用 **长连接事件订阅机制** 接收入站消息，而不是要求公开 webhook
- Openclaw 中的配置方式核心是 `appId` + `clientSecret`

参考摘取点：

- README 明确写了它是 “QQ 开放平台 Bot API 的 Openclaw 渠道插件”，并支持 `C2C private chats, group chat @ messages, and channel messages`
- README 还说明它使用 “long-connection event subscription mechanism” 接收消息
- 配置示例里，`channels.qqbot` 使用 `appId` 和 `clientSecret`

这直接改变了我们前一版“优先 OneBot”的判断。

## 3. 对 neoclaw 的影响

`neoclaw` 的 channel 架构依然适合做 QQ 接入，但第一版技术路线要重新排序：

### 方案 A：官方 QQ Bot API（推荐）

建议作为正式方案优先评估。

优点：

- 更接近 `openclaw` 的已验证路径
- 配置模型清晰：`appId` / `clientSecret`
- 长连接入站更适合 `Channel.start()` 生命周期
- 不依赖 OneBot / NapCat 这一层额外桥接

风险：

- 官方 API 能力边界要进一步核实
- 不同消息场景（C2C / 群 @ / 频道）权限和开通步骤可能更复杂
- 如果要完整支持媒体、输入状态、Markdown，工作量会比最小 OneBot 文本收发更高

### 方案 B：OneBot 11（备选）

适合作为快速验证链路，或在官方能力无法满足时兜底。

优点：

- 开发速度快
- 容易先打通文本收发
- 和现有 webhook / HTTP API 形式很贴近

缺点：

- 多依赖一层桥接
- 平台行为和兼容实现之间可能有差异
- 长期维护性、稳定性、账号风险更复杂

## 4. 当前 neoclaw 现状（仍然适合落点）

当前仓库已经具备接入新 channel 的主要基础设施：

- `src/channels/channel.ts` 已定义统一 `Channel` 接口
- `src/channels/manager.ts` 已负责 channel 注册、启动、停止、热更新、出站分发
- `src/config/schema.ts` 已有按 channel 组织的配置结构
- `src/bus/types.ts` 已定义统一的 `InboundMessage` / `OutboundMessage`
- `src/channels/feishu.ts` 已提供“长连接 / webhook 双模式、target 规范化、去重、配置热更新”的近期参考样板

所以，QQ channel 不需要改整体架构，主要是把平台协议映射补齐。

## 5. 推荐技术方案（修正版）

## 5.1 MVP 方向

建议第一版先做 **官方 QQ Bot API 的最小可用 channel**，能力范围收窄为：

- C2C 私聊收发
- 群聊 @消息入站
- 文本 outbound
- 基础配置校验
- 基础错误处理

如果在实现中遇到官方权限、文档、账号或 SDK 稳定性阻碍，再切到 OneBot 备选方案。

## 5.2 运行形态建议

基于 `qqbot` README 的线索，`neoclaw` 的官方 QQ channel 更适合设计为：

- `start()` 中建立长连接事件订阅
- 事件到来后映射为 `InboundMessage`
- `send()` 中调用 QQ Bot API 发送消息
- `stop()` 中关闭连接并清理资源

这和 `feishu` 的 websocket 模式、以及现有 `ChannelManager` 的生命周期模型是匹配的。

## 5.3 配置草案（官方路线）

建议在 `src/config/schema.ts` 增加：

```ts
interface QQConfig {
  enabled: boolean;
  appId: string;
  clientSecret: string;
  sandboxOnly?: boolean;
  allowFrom?: string[];
  requireMention?: boolean;
  apiBase?: string;
  wsIntentMask?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  dedupPersist?: boolean;
  dedupFile?: string;
}
```

首版重点：

- `appId`
- `clientSecret`
- `allowFrom`
- `requireMention`
- 基础重连参数
- 可选去重持久化

## 5.4 target / chatId 规范建议

内部建议统一成稳定格式，不直接暴露平台原始字段：

- 私聊：`chatId = "qq:private:<openid-or-userid>"`
- 群聊：`chatId = "qq:group:<groupid>"`
- 频道：`chatId = "qq:channel:<channelid>"`

发送目标建议兼容：

- `private:<id>`
- `group:<id>`
- `channel:<id>`
- `qq:private:<id>`
- `qq:group:<id>`
- `qq:channel:<id>`

如果后续官方 SDK 对不同场景的 target 结构不一致，也能在 channel 内部消化掉。

## 5.5 入站事件映射建议

第一阶段优先支持：

- 私聊消息
- 群聊 @消息
- 可选：频道消息

映射为：

- `senderId`：`<user-id>|<nickname?>`
- `chatId`：按 `private/group/channel` 规范化
- `content`：优先纯文本；富文本先做降级抽取
- `metadata`：保留原始 `messageId`、`eventId`、`scene`、原始 payload 摘要

## 6. 参考项目可借鉴点

## 6.1 `sliverp/qqbot`

最值得借鉴：

- 官方 QQ Bot API 路线已走通
- 长连接事件订阅模型适合 channel 生命周期
- 配置入口足够简单，先用 `appId` / `clientSecret`
- 支持场景比较完整，后续可按能力逐步补齐

## 6.2 openclaw 思路

虽然本地 `openclaw` 仓库里没有内嵌 QQ 代码，但从插件模式上可以借鉴：

- 平台协议差异尽量封装在 channel / plugin 内部
- 宿主层只关心统一消息模型和路由
- target 语义要先收敛，避免上层业务直接拼平台字段

## 6.3 Memoh-v2 思路

可借鉴它的适配器分层方式：

- 配置校验
- target 解析
- inbound 事件转换
- outbound 发送
- 生命周期管理

## 7. 开发切入点

建议变更点如下：

- 新增 `src/channels/qq.ts`
- 更新 `src/bus/types.ts` 的 `ChannelName`
- 更新 `src/config/schema.ts` 的 `ChannelsConfig`
- 更新 `src/channels/manager.ts`，接入 `QQChannel`
- 更新 `src/commands/web.ts` 的配置读写与脱敏逻辑
- 如 Web 管理台要支持，再补 `webapp` 的 channels 配置 UI
- 新增 `src/channels/__tests__/qq.test.ts`

## 8. 分阶段计划

## 阶段 A：官方 QQ 协议调研定稿（0.5~1 天）

- 确认官方 SDK / API 接入方式
- 确认私聊、群 @、频道消息对应事件模型
- 敲定 `chatId` / `senderId` / outbound target 规范
- 敲定配置字段和默认值

验收标准：

- 形成一份稳定的协议映射说明
- 不再把 MVP 建立在 OneBot 假设上

## 阶段 B：最小可用实现（1~1.5 天）

- 新增 `QQChannel`
- 建立官方事件长连接
- 实现文本消息 inbound / outbound
- 实现 `allowFrom`、`requireMention`
- 接入 `manager`、`schema`、状态展示、配置热更新

验收标准：

- QQ 私聊可收发
- 群聊 @ 后可触发
- 配置错误能直接定位到关键字段

## 阶段 C：稳定性补齐（1~1.5 天）

- 自动重连
- 入站去重（内存 + 可选持久化）
- 同 chat 顺序保证
- 错误码与日志包装

验收标准：

- 断连后能恢复
- 重复事件不会重复入队
- 常见错误具备可读日志

## 阶段 D：消息能力增强（1 天）

- 图片 / 文件 / 语音
- 输入中状态
- Markdown / 富文本降级
- 回复引用映射

验收标准：

- 常见消息不会明显丢语义
- 富媒体行为有清晰回退策略

## 阶段 E：测试与文档（0.5~1 天）

- 单测：target 解析、配置校验、事件解析、去重
- 接入文档：QQ 平台创建 Bot、拿 `AppID/AppSecret`、本地运行说明
- 如有需要，再补 Web 配置面板

验收标准：

- 核心逻辑有回归保护
- 新用户可独立完成接入

## 9. 主要风险点

- 官方 QQ 平台的权限、审核、沙箱能力可能限制真实使用场景
- 群聊 / 频道场景和私聊场景的 API 可能不完全一致
- 富媒体与 Markdown 支持成本可能高于纯文本
- 现阶段 `neoclaw` 还没有现成官方 QQ SDK 接入样板，首版需要多做协议摸底

## 10. 当前建议的实际开发顺序

1. 先补官方 QQ Bot API 的协议调研
2. 先实现私聊 + 群 @ 文本消息
3. 暂缓媒体和复杂富文本
4. 先把测试补在 `src/channels/__tests__/qq.test.ts`
5. Web UI 最后接，避免配置字段反复变动
