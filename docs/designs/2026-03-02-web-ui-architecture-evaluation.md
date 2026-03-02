# Neoclaw Web UI 架构评估（原生 vs React+Vite）

日期：2026-03-02

## 1. 现状

当前 `web` 页面以内联模板字符串形式写在 `src/commands/web.ts`。问题：

- UI/状态/接口逻辑耦合在一个文件，修改风险高。
- 三步向导、OAuth 状态流、字段联动会继续抬高复杂度。
- 缺少组件化和可测试边界。

## 2. 方案对比

## 2.1 方案 A：原生静态页（HTML + TS/JS）

优点：

- 引入成本最低，无新增前端框架依赖。
- 打包链路简单，可直接静态文件托管。

缺点：

- 状态管理与表单联动代码会快速膨胀。
- 后续扩展（向导、复杂校验、OAuth 异步流程）维护成本高。
- 组件复用和 UI 一致性差。

适用：

- 页面非常小、短期一次性交付。

## 2.2 方案 B：React + Vite

优点：

- 组件化 + 状态管理更适配当前需求（多步骤、联动、异步状态机）。
- 开发体验和后续迭代效率明显更高。
- 可逐步补充单元测试（例如表单校验、步骤流转）。

缺点：

- 增加前端依赖和构建步骤。
- CLI 包发布需增加静态资源拷贝流程。

适用：

- 需要长期维护和持续演进的配置中心（当前就是这个场景）。

## 3. 结论

推荐 **方案 B（React + Vite）**。

原因：你的 Web 配置中心已经从“临时表单”升级为“长期产品入口”，未来还会加 provider 类型分流、OAuth 状态流、错误引导、渠道配置扩展，用原生脚本会持续累积维护债务。

## 4. 落地方案（建议）

## 4.1 目录结构

```text
webapp/
  index.html
  package.json
  vite.config.ts
  src/
    main.tsx
    App.tsx
    api/
    components/
    pages/
    styles/
src/commands/web.ts   # 仅保留 API + 静态资源服务
```

## 4.2 后端职责调整

`src/commands/web.ts` 调整为：

- API 路由层（`/api/...`）
- 静态资源服务（`/assets/...`）
- `GET /` 返回 `webapp` 构建产物 `index.html`

不再拼接大段 HTML 模板。

## 4.3 构建与发布

在根 `package.json` 增加：

- `build:web`: 构建 React Web
- `build`: 先 `build:web`，再 `bun build` CLI，最后把 web 构建产物拷贝到 `dist/web`

关键点：发布包 `files` 已包含 `dist`，所以只要资源在 `dist/web` 就可随 npm 发布。

## 4.4 开发模式

- 本地前端开发：Vite dev server（仅前端）。
- 联调：Vite 代理 `/api` 到 `neoclaw web` 服务端。

## 5. 风险与控制

风险：

- 新增前端工具链，初期改造量增加。

控制：

- 分阶段迁移，不一次性推翻：
  1. 先抽离静态资源服务。
  2. 再迁移页面到 React。
  3. 最后删除旧模板字符串。

## 6. 与当前设计的关系

不影响既定业务设计（provider 分流、模型下拉、channels 多选、OAuth 无浏览器补全）。

只是在实现层，把 UI 从内联模板改为独立前端工程，提高可维护性与扩展能力。

## 7. 下一步建议

1. 先创建 `webapp/` 脚手架和最小页面壳（空向导框架 + API client）。
2. 服务端改为支持静态资源与 `index.html`。
3. 按 Step1/Step2/Step3 逐步迁移页面逻辑。
