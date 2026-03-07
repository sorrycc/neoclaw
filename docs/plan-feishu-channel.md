# neoclaw 飞书 Channel 接入评估与计划

更新时间：2026-03-04

## 1. 结论（先说结论）

在当前 neoclaw 架构下，**增加一个可用的 Feishu channel 难度中等**，因为已有清晰的 `Channel` 抽象、消息总线、配置热更新。

如果目标是“先可用”，工作量约 **1~2 天**。  
如果目标是“稳定上线（含重连、去重、安全、测试）”，工作量约 **3~5 天**。

## 2. 当前项目现状（已具备能力）

当前仓库已经具备以下基础能力（已落地）：

- 新增 `src/channels/feishu.ts`
- `config schema`、`channel manager`、`status`、`index` 热更新链路已接入
- 支持 outbound 文本发送（tenant token 缓存）
- inbound 支持 `websocket` / `webhook` 两种接入
- 基础去重（内存）、`allowFrom`、群聊 `requireMention`
- 文本与 `post` 基础解析

对应意味着：**不是从 0 开始**，而是进入“稳定性和生产化补齐”阶段。

## 3. 参考项目对照（Memoh-v2 / openclaw）

### 3.1 Memoh-v2 可借鉴点

- 适配器边界清晰：`config / inbound / stream / directory` 分层明确
- 目标 ID 规范化和错误提示较完整（例如 target 解析错误信息）
- WebSocket 连接具备显式重连循环
- Feishu 相关测试覆盖较多（单测 + 集成）

### 3.2 openclaw 可借鉴点

- 长期演进后的稳定性设计更完整：
  - 持久化去重（重启后仍可抑制重复）
  - webhook 入口安全防护（限流、body 限额、超时）
  - 按 chat 串行队列 + 去抖合并（同 chat 顺序一致，跨 chat 并发）
  - 目标 ID 规范化更完整（`chat:/group:/user:/dm:`）
  - 多账号配置模型（default + accounts）
- 说明当前 Feishu 在生产环境的主要成本不在“能收发”，而在“稳定性和边界处理”。

## 4. 主要风险点（当前 neoclaw 还缺）

- 去重仅内存态，进程重启后无法抑制重放事件
- WebSocket 自动重连策略较弱（`autoReconnect: false`）
- webhook 缺少请求体大小/超时/限流保护
- inbound 并发顺序控制不足（同群高并发下可能乱序）
- 目标路由语义还可加强（`group:`/`dm:` 等格式兼容）
- 媒体与富文本支持仍是基础版本
- 缺少针对 Feishu 的系统化测试（尤其回归测试）

## 5. 分阶段执行计划

## 阶段 A：稳定最小可用（0.5~1 天）

- 明确配置约束与错误信息（启动前校验）
- 补齐 `status` 展示字段（mode / webhook 配置）
- 整理示例配置与接入文档，形成可复现“最短路径”

验收标准：

- 配置错误时可直接定位到缺失字段
- `status` 能明确当前 Feishu 运行模式和关键参数

## 阶段 B：运行时可靠性（1~1.5 天）

- WebSocket 重连机制（指数退避 + 抖动）
- inbound 同 chat 串行处理（避免乱序）
- webhook 防护（body 大小、读取超时、基础限流）
- 去重策略升级（至少“内存 + 可选持久化”）

验收标准：

- 网络抖动后可自动恢复收消息
- 压测下同 chat 不乱序
- webhook 对异常请求可快速 fail-close

## 阶段 C：路由与消息语义增强（1~1.5 天）

- 目标 ID 规范化增强（`chat:/group:/user:/dm:`）
- mention 识别和清洗增强（避免误触发）
- `post` 结构解析增强（更多 tag）
- 媒体消息发送与占位策略完善

验收标准：

- 群聊/私聊路由行为一致且可预测
- mention 规则与 `requireMention` 组合行为稳定

## 阶段 D：测试与回归保护（1 天）

- 单测：target 解析、mention、content 解析、去重、配置校验
- 集成测试：websocket/webhook 入站、发送失败重试、热更新
- 基础故障注入：token 失败、429、网络断连

验收标准：

- 覆盖核心分支；关键回归可自动发现

## 阶段 E（可选）：Web 配置面板接入（0.5~1 天）

说明：当前仓库仅有 `webapp/dist`，缺少 `webapp/src` 与对应后端 `web` 命令源码，无法做可维护修改。  
建议先恢复 Web 源码后再接入 Feishu 配置 UI，否则只能改打包产物（高风险、不可维护）。

验收标准：

- Web UI 可编辑 Feishu 配置并保存
- 与文件配置、热更新链路一致

## 6. 推荐落地顺序（实操建议）

1. 先完成阶段 A + B（先稳定收发）
2. 再做阶段 C（完善路由和消息语义）
3. 最后阶段 D（补齐自动化回归）
4. Web UI 放在源码恢复后做阶段 E

## 7. 工时与难度评估

- 仅“可用”：中等，1~2 天
- “可稳定运行”：中偏高，3~5 天
- 含 Web UI：在源码可编辑前提下再加 0.5~1 天

