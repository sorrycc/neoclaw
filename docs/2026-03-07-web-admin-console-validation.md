# Web Admin Console Validation Guide

更新时间：2026-03-07

## 1. 目标

本文用于本地验证 neoclaw Web 管理后台的完整闭环，包括：

- 登录
- Dashboard 摘要
- Config 配置管理
- Chat 会话管理
- Cron 管理
- Skills 本地管理
- Skills 市场搜索与安装反馈

---

## 2. 推荐环境

- Bun 已安装
- 仓库依赖已安装：`bun install`
- Web 前端依赖已安装：`cd webapp && bun install`
- 若要验证 Skills 市场：
  - 推荐安装 `clawhub`
  - 或依赖 `npx clawhub@latest`

---

## 3. 启动方式

### 3.1 开发者常用

```bash
cd /Users/xiaobei/Documents/xiaobei/neoclaw
bun run build
neoclaw web --dev --token your-token --port 3180
```

### 3.2 指定 profile

```bash
cd /Users/xiaobei/Documents/xiaobei/neoclaw
bun run build
neoclaw web --profile demo --token your-token --port 3180
```

浏览器打开：

- `http://127.0.0.1:3180`

---

## 4. 功能检查清单

### 4.1 登录与入口

- 输入 Web token 后可进入后台
- 未完成基础配置时默认进入 `/wizard`
- 已完成基础配置时默认进入 `/app/dashboard`
- 顶部导航可切换：`Dashboard / Chat / Config / Cron / Skills`

### 4.2 Dashboard

- 可看到 Agent 状态、模型、workspace、profile
- 可看到 Channels 摘要
- 可看到 Cron 摘要
- 可看到 Skills 摘要
- 可看到最近错误摘要
- 点击快捷入口可跳转到对应页面

### 4.3 Config

- 保存、导入、导出、快照、回滚可用
- 编辑后出现“未保存变更”提示
- 保存按钮展示变更计数
- 刷新页面后配置仍正确加载

### 4.4 Chat

- 可创建新会话
- 可切换、清空、删除会话
- 刷新页面后会话仍保留
- 会话搜索可按标题/摘要过滤
- 助手消息支持 Markdown 渲染
- 每条消息可点击复制

### 4.5 Cron

- 页面可列出现有任务
- 可创建 `every / at / cron` 类型任务
- 可暂停 / 恢复 / 删除任务
- 可按状态、类型、关键词筛选

### 4.6 Skills

#### 本地 Tab
- 列出本地已安装 skills
- 搜索名称 / 描述 / 目录名
- 查看 `SKILL.md` 内容
- 删除 skill 后列表刷新

#### 市场 Tab
- 显示 `clawhub` 可用性与版本
- 可搜索市场 skills
- 可看到 name / slug / summary / owner / version / score
- 安装成功后刷新本地列表
- 安装失败时展示错误日志

---

## 5. 自动化验证

当前仓库已覆盖以下验证：

```bash
cd /Users/xiaobei/Documents/xiaobei/neoclaw
bun test src/agent/__tests__/skill-manager.test.ts \
  src/commands/__tests__/web.test.ts \
  src/commands/__tests__/web-api.test.ts \
  src/services/__tests__/cron.test.ts

bun run typecheck
bun run build
```

### 覆盖内容

- `SkillManager` 本地 skill 详情/删除/命令展开
- Web helper 行为
- Web API 实进程集成：
  - 鉴权
  - CSRF
  - Cron 增删停启
  - Skills 本地列表/详情/删除
  - Chat 会话 CRUD 与空消息校验
- Cron 服务行为

---

## 6. 浏览器 GUI 回归建议

如需人工或半自动浏览器检查，可按下面流程执行：

1. 登录后台
2. 检查 Dashboard 摘要数据
3. 在 Cron 页面创建一条 `every` 任务
4. 在 Skills 本地页查看 skill 详情并删除测试项
5. 在 Skills 市场页搜索 `markdown`
6. 在 Config 页面确认未保存变更提示
7. 在 Chat 页面创建/切换/删除会话

---

## 7. 已知注意事项

- 未登录时，前端首次请求 `/api/config/current` 返回 `401` 属于预期行为。
- `clawhub install` 依赖远端服务；若遇到 rate limit，页面会展示失败日志，但本地功能和市场搜索不受影响。
- 正式 Chat 的消息生成依赖有效模型/provider 配置；未完成配置时建议先在 `Wizard` 或 `Config` 页面完成基础设置。
