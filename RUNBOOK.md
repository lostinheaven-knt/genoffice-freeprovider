# GenOffice FreeProvider Runbook

> 本仓库是 [genspark-ai/genoffice](https://github.com/genspark-ai/genoffice) 的派生版，把 AI provider 从硬锁的 Genspark 切换为 DeepSeek（OpenAI 兼容端点），并解锁了多 provider 抽象层。本 runbook 覆盖从零安装到日常维护的全流程。

---

## 1. 项目概述

GenOffice 是一个桌面端 office 套件（docs / sheets / slides / pdf / shell），基于 TypeScript + React 19 + Electron 43，npm workspaces monorepo。

**本仓库的关键改动**（相对原项目）：
- 引擎层 `packages/ai-provider` 默认 provider 从 `genspark` 改为 `deepseek`
- 新增 `packages/ai-provider/src/bootstrap.ts` 纯函数，实现 ai-settings.json 的自举（首次生成）+ 迁移（旧 genspark 文件自动转换）+ keep（尊重既有非 genspark 配置）
- 3 个 app 主进程（docs / sheets / slides）的 `ai:get-settings` handler 接线 bootstrap，删除原硬锁 `settings.provider = 'genspark'`
- 3 个渲染进程的错误态 `aiGskStatus()` 调用加 provider 门控，避免 deepseek 报错时误显「Sign in to Genspark」登录按钮
- 保留 genspark key 注入分支与 gsk handler 为休眠代码，未来切回 genspark 无需改代码
- **slides 的 cloud generation（精美页面生成）从 gsk 云端 `slide_generate` 改为完全本地**：deepseek 生成 HTML + 本地 `html2pptx` 模块转 pptx，不再依赖 gsk 登录（详见 §11.4）
- 新增 `packages/pptx-engine/src/html2pptx.ts`：HTML -> 单页 pptx 转换模块（pptxgenjs + cheerio），支持 p/h1-6/ul/ol/div/img + CSS absolute 定位
- **slides 生成引擎 kimi-k2.7-code**（Phase 3）：slides 的 HTML 生成 + 视觉功能（AI Beautify / QC pass / 图片附件）用 kimi-k2.7-code（火山引擎方舟，支持 vision），deepseek 兜底；对话文本保持 deepseek

**DeepSeek 配置**：通过项目根 `env_config.json` 提供 API key + model，首次启动自举固化到 `ai-settings.json`。

---

## 2. 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node | ≥ 22.12.0 | `package.json` engines 声明；`.nvmrc` 写的 20 已过时，以 engines 为准 |
| npm | ≥ 10 | 随 Node 22 自带 |
| Rust toolchain | stable | 仅 sheets app 的 xlsx 导入导出需要（`apps/sheets/native/xlsx-engine`，calamine + IronCalc），需 `cargo` 在 PATH |
| OS | macOS 12+ / Windows 10+ / Linux | 桌面应用，非 Docker/k8s |

**npm registry 注意**：`@fluentui/react-icons@^2.0.333` 在 npmmirror 镜像上 tarball 404（镜像只同步到 2.0.316）。如果用 npmmirror，需用官方源安装：

```bash
npm install --registry=https://registry.npmjs.org
```

---

## 3. 初始安装

```bash
# 1. clone
git clone https://github.com/lostinheaven-knt/genoffice-freeprovider.git
cd genoffice-freeprovider

# 2. 安装依赖（用官方源，避免 fluentui 镜像问题）
npm install --registry=https://registry.npmjs.org

# 3. 创建 env_config.json（从模板复制）
cp env_config.example.json env_config.json
# 编辑 env_config.json，填入你的 DeepSeek API key

# 4.（可选）生成测试 fixtures
npm run fixtures
```

`env_config.json` 格式：
```json
{
    "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
    "DEEPSEEK_API_KEY": "sk-your-deepseek-key",
    "DEEPSEEK_MODEL": "deepseek-v4-flash",
    "KIMI_BASE_URL": "https://ark.cn-beijing.volces.com/api/coding/v3",
    "KIMI_API_KEY": "your-volcano-ark-key",
    "KIMI_MODEL": "kimi-k2.7-code"
}
```

> ⚠️ `env_config.json` 含明文 API key，已在 `.gitignore` 中，**勿 `git add`**。`env_config.example.json` 是模板（占位 key），可安全 commit。

---

## 4. 配置机制

### 4.1 配置文件层次

| 文件 | 位置 | 作用 | 是否 commit |
|---|---|---|---|
| `env_config.json` | 项目根 | dev 环境提供 DeepSeek key/model | ❌ gitignore |
| `env_config.example.json` | 项目根 | 模板，占位 key | ✅ commit |
| `ai-settings.json` | `app.getPath('userData')/ai-settings.json` | 运行时 AI 设置（自举生成） | ❌ 运行时生成 |

### 4.2 ai-settings.json 自举逻辑

首次 `ai:get-settings` 调用时（app 启动），主进程执行三分支判定（`packages/ai-provider/src/bootstrap.ts`）：

| 分支 | 条件 | 行为 |
|---|---|---|
| **seed** | 文件不存在 / 旧单端点格式（无 `providers` 字段） | 用默认值 + DeepSeek key/model 生成新文件，落盘 |
| **migrate** | 文件存在但 `provider === 'genspark'`（旧硬锁时代残留） | 改 `provider` 为 `deepseek`，补 `providers.deepseek` slot，**保留其它 provider slot**，落盘 |
| **keep** | 文件存在且 `provider` 非 genspark（含已是 deepseek） | 不改写，原样返回 |

### 4.3 API key 解析优先级

`resolveDeepseekCredentials`（`bootstrap.ts`）按优先级解析 key/model：

1. `process.env.DEEPSEEK_API_KEY` / `process.env.DEEPSEEK_MODEL`（env var，prod 推荐）
2. `env_config.json` 的 `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL`（dev 便利）
3. 默认值：key=空串，model=`deepseek-v4-flash`

解析到的值在自举时固化进 `ai-settings.json`，后续请求直接读文件，不再依赖 env/config。

### 4.4 dev / prod 路径

`app.getPath('userData')` 由 Electron 按 appName 自动解析：

| 模式 | appName | macOS 路径 |
|---|---|---|
| docs dev | `GenOffice Docs Dev` | `~/Library/Application Support/GenOffice Docs Dev/ai-settings.json` |
| docs prod | `GenOffice Docs` | `~/Library/Application Support/GenOffice Docs/ai-settings.json` |
| shell 聚合 | `GenOffice`（或打包名） | `~/Library/Application Support/GenOffice/ai-settings.json`（所有窗口共用） |

Windows: `%APPDATA%\<appName>\ai-settings.json`
Linux: `~/.config/<appName>/ai-settings.json`

### 4.5 ai-settings.json schema

```ts
{
  provider: 'deepseek' | 'genspark' | 'anthropic' | 'gemini' | 'openai' | 'custom',
  providers: {
    [providerId]: { apiKey: string, model: string, baseUrl?: string }
  }
}
```

自举后典型内容：
```json
{
  "provider": "deepseek",
  "providers": {
    "genspark": { "apiKey": "", "model": "claude-opus-4-7" },
    "anthropic": { "apiKey": "", "model": "claude-opus-4-7" },
    "gemini": { "apiKey": "", "model": "gemini-2.5-flash" },
    "deepseek": { "apiKey": "sk-...", "model": "deepseek-v4-flash" },
    "openai": { "apiKey": "", "model": "gpt-4.1-mini" },
    "custom": { "apiKey": "", "model": "", "baseUrl": "" }
  }
}
```

---

## 5. 启动方式

### 5.1 开发模式（推荐先跑这个）

```bash
# 全部 4 个编辑器 + shell（占用大）
npm run dev

# 单跑一个 app（仅 dev:docs 是根脚本别名；sheets/slides/pdf 用 -w 形式）
npm run dev:docs                      # 文档编辑器（根脚本别名，= npm run dev -w @genoffice/docs）
npm run dev -w @genoffice/sheets      # 表格（需 Rust）
npm run dev -w @genoffice/slides      # 幻灯片
npm run dev -w @genoffice/pdf         # PDF
```

dev 模式下 Vite dev server + Electron，支持热更新。首次启动会触发 ai-settings.json 自举。

### 5.2 构建后用 Electron 跑

```bash
npm run build:all     # 构建全部 4 个编辑器 + shell
npm run shell         # = build:all && electron apps/shell
```

### 5.3 shell 聚合模式

`npm run shell` 启动 shell app，它聚合注册所有 ai: IPC handler（复用 docs 的 `registerAiIpc`），所有窗口（docs/sheets/slides/pdf/home）共用 shell userData 下同一份 ai-settings.json。

> **pdf app 独立模式 AI 不可用**：pdf main 进程不注册任何 AI handler，独立运行时 AI 功能失败（"No handler registered"）。只在 shell 聚合模式下可用。

---

## 6. 功能验证

### 6.1 验证自举（首次启动）

```bash
# 1. 启动 docs dev
npm run dev:docs

# 2. 等 Electron 窗口出现后，新终端检查文件
cat ~/Library/Application\ Support/GenOffice\ Docs\ Dev/ai-settings.json
```

**预期**：文件存在，`provider='deepseek'`，`providers.deepseek.apiKey` 为 env_config.json 的 key，`model` 为 `deepseek-v4-flash`。

### 6.2 验证 AI 调用

在 docs app 的 AiPanel 发一条消息（如"你好"）。观察：

- ✅ **正常流式响应** → DeepSeek API 接受 `deepseek-v4-flash`，端到端工作（已实测验证：`/v1/chat/completions` + stream=true + 不带 thinking 参数，流式响应正常，含 reasoning_content）
- ❌ **错误（网络/鉴权类）** -> 见 §8.1 排查（注意：`deepseek-v4-flash` 已验证为有效模型名，不会被 API 以 invalid model 拒绝）

### 6.3 验证错误态门控（Cycle 3）

1. 临时改 ai-settings.json 的 `providers.deepseek.model` 为 `deepseek-invalid-model`
2. 发消息触发失败
3. **确认**：AiPanel 只显示错误文本（如 "Error: ..."），**不出现**「Sign in to Genspark」按钮
4. 验证完改回有效 model，重启 dev mode

### 6.4 验证旧文件迁移（Cycle 2）

```bash
# 预置旧 genspark 文件
cat > ~/Library/Application\ Support/GenOffice\ Docs\ Dev/ai-settings.json <<'EOF'
{"provider":"genspark","providers":{"genspark":{"apiKey":"","model":"claude-opus-4-7"},"anthropic":{"apiKey":"sk-ant-test","model":"claude-opus-4-7"}}}
EOF

# 重启 dev mode（Ctrl+C 后重新 npm run dev:docs）
# 检查文件被迁移
cat ~/Library/Application\ Support/GenOffice\ Docs\ Dev/ai-settings.json
```

**预期**：`provider` 变为 `deepseek`，`providers.deepseek` 含 key + model，`providers.anthropic.apiKey='sk-ant-test'` 保留。

### 6.5 验证 env var 优先级

```bash
# 设 env var 启动
DEEPSEEK_API_KEY=sk-env-test DEEPSEEK_MODEL=deepseek-chat npm run dev:docs

# 检查 ai-settings.json（首次启动自举后）
cat ~/Library/Application\ Support/GenOffice\ Docs\ Dev/ai-settings.json
```

**预期**：`providers.deepseek.apiKey='sk-env-test'`，`model='deepseek-chat'`（env var 优先于 env_config.json）。需先删掉旧 ai-settings.json 才会重新自举。

---

## 7. 自动化测试

```bash
# 引擎层单测（92 个，含 bootstrap 纯函数）
npm test --workspace @genoffice/ai-provider

# 全量测试（聚合所有 workspace）
npm test

# 全量类型检查（16 workspace）
npm run typecheck

# 全量 lint
npm run lint

# 格式检查
npm run format:check

# E2E（Playwright）
npm run test:e2e
```

**期望结果**：
- ai-provider 单测：6 files / 92 tests passed
- typecheck：16 workspace 全过
- lint：0 errors（8 既有 `react-hooks/exhaustive-deps` warnings，分布在 sheets/slides renderer，非本次引入）

---

## 8. 常见问题排查

### 8.1 AI 调用报 model 错误

**现象**：AiPanel 报错 `invalid model` / `model not found` / `Model Not Exist`。

**根因**：`deepseek-v4-flash` 已实测验证为 DeepSeek API 有效模型名（`/v1/chat/completions` + 流式 + 不带 thinking 参数均正常返回，含 reasoning_content）。如果仍报 model 错误，通常是：
- model 名拼写错误（如 `deepseek-v4-fash` 漏字符）
- DeepSeek 下线了该模型（未来可能）
- 用了非 DeepSeek 的端点（custom provider 误配）

**可选的替代模型**（如需切换）：
- `deepseek-chat`（实测 DeepSeek 当前路由到 `deepseek-v4-flash`，即两者等价）
- `deepseek-reasoner`（推理模型，更深但更慢）

**解决**：编辑 ai-settings.json 的 `providers.deepseek.model`，改完**重启 dev mode**（settings 是启动时缓存的）。

### 8.2 ai-settings.json 没有自动生成

**现象**：启动 dev mode 后，userData 目录下没有 ai-settings.json。

**排查**：
1. 确认 `env_config.json` 在项目根，且含 `DEEPSEEK_API_KEY`
2. 确认 dev mode 启动目录是项目根（`process.cwd()` 是 readEnvConfig 的首选候选路径）
3. 检查 dev mode 控制台是否有 readEnvConfig 相关错误
4. 手动触发：在 docs app 里打开 AI 面板（触发 `ai:get-settings` IPC）

**手动创建**：直接写入文件也行（绕过自举）：
```bash
cat > ~/Library/Application\ Support/GenOffice\ Docs\ Dev/ai-settings.json <<'EOF'
{"provider":"deepseek","providers":{"deepseek":{"apiKey":"sk-你的key","model":"deepseek-chat"}}}
EOF
```

### 8.3 AI 调用报 `errNoApiKey`

**现象**：发消息报错 "No API key configured"。

**根因**：ai-settings.json 的 `providers.deepseek.apiKey` 为空。

**排查**：
1. 检查 ai-settings.json 是否有 key
2. 如果是 prod 打包后：`env_config.json` 不随打包发布，prod 首次启动若无 `DEEPSEEK_API_KEY` env var，自举写入空 key
3. **解决**：设 `DEEPSEEK_API_KEY` env var 启动，或手动编辑 ai-settings.json 填 key

### 8.4 误显「Sign in to Genspark」按钮

**现象**：deepseek 请求失败时，AiPanel 出现「Sign in to Genspark」按钮。

**根因**：如果门控失效（不应发生），错误回调无条件调了 `aiGskStatus()`。

**排查**：确认 `apps/<app>/src/renderer/ai/AiPanel.tsx`（或 `App.tsx` for sheets）的错误回调里 `aiGskStatus()` 调用被 `if (settingsRef.current.provider === 'genspark') { ... }` 包裹。

### 8.5 依赖安装失败（@fluentui/react-icons 404）

**现象**：`npm install` 报 `@fluentui/react-icons@2.0.333` tarball 404。

**根因**：npmmirror 镜像只同步到 2.0.316。

**解决**：用官方源安装：
```bash
npm install --registry=https://registry.npmjs.org
```

### 8.6 sheets 编译失败（exactOptionalPropertyTypes）

**现象**：sheets workspace typecheck 报 TS2379（`string | undefined` 不能赋给 `string?`）。

**根因**：sheets 的 `tsconfig.json` 开了 `exactOptionalPropertyTypes: true`。

**解决**：本仓库已在 `bootstrap.ts:26-27` 把 `resolveDeepseekCredentials` 签名改为 `{ KEY?: string | undefined }` 适配。如果新增代码遇到同类问题，参照此模式。

### 8.7 全量 typecheck 在 electron-utils 失败

**现象**：`Cannot find module 'electron'`。

**根因**：`npm install --ignore-scripts` 跳过了 `install-electron` postinstall，electron 二进制未下载。

**解决**：用 `npm install`（不带 `--ignore-scripts`），或手动 `npm rebuild electron`。

### 8.8 prod 首次启动 AI 不可用

**现象**：打包后首次启动，AI 报 `errNoApiKey`。

**根因**：`env_config.json` 不进打包，prod 无 env var 时自举写入空 key。

**解决**（选一）：
- 启动前设 `DEEPSEEK_API_KEY` env var
- 手动放置 ai-settings.json 到 prod userData 路径
- 打包时把 key 注入环境（不推荐，会泄漏到构建产物）

---

## 9. 维护操作

### 9.1 换 DeepSeek model

编辑 ai-settings.json 的 `providers.deepseek.model`，重启 app。可选值：
- `deepseek-chat`（通用）
- `deepseek-reasoner`（推理）
- 其他 DeepSeek 官方模型名

### 9.2 换 API key

**方法 1**（推荐）：删除 ai-settings.json，重启 app 重新自举（需先更新 env_config.json 或 env var）。

**方法 2**：直接编辑 ai-settings.json 的 `providers.deepseek.apiKey`，重启 app。

### 9.3 切回 Genspark provider

本仓库保留 genspark 休眠分支，切回无需改代码：

1. 编辑 ai-settings.json：
   ```json
   { "provider": "genspark", "providers": { "genspark": { "apiKey": "", "model": "claude-opus-4-7" } } }
   ```
2. 确保 gsk 登录态有效（`~/.genoffice/auth.json` 或 `~/.genspark-tool-cli/config.json` 含 key，或设 `GSK_API_KEY` env var）
3. 重启 app

> 注意：切回 genspark 后，**bootstrap 的 migrate 分支会再次把它改回 deepseek**（因为 `stored.provider === 'genspark'` 触发迁移）。如果要长期用 genspark，需把 ai-settings.json 设为 keep 分支不触发的状态——但目前 keep 分支条件是 `provider !== 'genspark'`，所以 genspark 一定会被迁移。如需禁用迁移，注释掉 `bootstrap.ts` 的 migrate 分支或改 keep 条件。

### 9.4 切到其他 provider（OpenAI / Anthropic / Gemini / Custom）

引擎层已支持，只需编辑 ai-settings.json：

```json
{
  "provider": "openai",
  "providers": {
    "openai": { "apiKey": "sk-...", "model": "gpt-4.1-mini" }
  }
}
```

keep 分支会尊重任何非 genspark 的既有配置，不自举覆盖。注意各 provider 的 model id 用官方命名（见 `packages/ai-provider/src/providers.ts` 的 `AI_PROVIDERS`）。

**custom provider**（任意 OpenAI 兼容端点）需额外提供 `baseUrl`：
```json
{
  "provider": "custom",
  "providers": {
    "custom": { "apiKey": "sk-...", "model": "your-model", "baseUrl": "https://your-endpoint.com/v1" }
  }
}
```

### 9.5 同步原项目更新

本仓库保留了 `upstream` remote 指向 `genspark-ai/genoffice`：

```bash
# 拉原项目更新
git fetch upstream

# 查看 upstream 有哪些新提交
git log --oneline upstream/main ^main

# merge 或 rebase（注意冲突，特别是 docs-main.ts / sheets-main.ts / ai-ipc.ts 的硬锁区域）
git merge upstream/main
# 或
git rebase upstream/main
```

> ⚠️ 原项目可能在 `ai:get-settings` handler 重新加硬锁或改 AI 逻辑，merge 时需手动解决冲突并保留本仓库的 bootstrap 接线。

### 9.6 更新依赖

```bash
npm update --registry=https://registry.npmjs.org
npm run typecheck   # 确认无回归
npm test            # 确认测试通过
```

---

## 10. 构建打包

```bash
# 构建全部（4 编辑器 + shell）
npm run build:all

# 打包分发（electron-builder）
npm run dist:mac    # macOS dmg/zip (Apple Silicon)
npm run dist:win    # Windows nsis x64
npm run dist:linux  # Linux deb/AppImage
```

打包产物在 `release/`。`env_config.json` 不进打包（gitignore + 不在 electron-builder resources）。

---

## 11. 架构参考

### 11.1 关键文件

| 文件 | 职责 |
|---|---|
| `packages/ai-provider/src/providers.ts` | AI_PROVIDERS 元数据 + defaultAiSettings + resolveAiSettings |
| `packages/ai-provider/src/bootstrap.ts` | ensureDeepseekSettings（自举/迁移/keep）+ resolveDeepseekCredentials（key 解析）|
| `packages/ai-provider/src/stream.ts` | streamForProvider（provider 路由，deepseek 走 streamOpenAiCompatible）|
| `packages/ai-provider/src/chat.ts` | chatForProvider（非流式）|
| `apps/docs/src/main/docs-main.ts` | docs 主进程，`ai:get-settings` 接线（:2517）+ readEnvConfig（:2011）|
| `apps/sheets/src/main/sheets-main.ts` | sheets 主进程，同构（:2139）|
| `apps/slides/src/main/ai-ipc.ts` | slides 主进程，`readAiSettings`（:104-113）+ ai:stream |
| `apps/slides/src/main/slides-main.ts` | slides cloud generation handlers：cloudSlideEnabled（:1367）+ cloud-page-generate（:1376，deepseek 生成 HTML）+ html-to-pptx（:1454，convertHtmlPage）|
| `packages/pptx-engine/src/html2pptx.ts` | HTML -> 单页 pptx 转换（pptxgenjs + cheerio，Phase 2 新增，482 行）|
| `apps/slides/src/renderer/ai/slides-skill.ts` | generate_deck / regenerate_slide（调 cloud-page-generate + html-to-pptx）|
| `apps/docs/src/renderer/ai/AiPanel.tsx` | docs AI 面板，错误态 gsk 门控（:593）|
| `apps/sheets/src/renderer/App.tsx` | sheets，门控（:919）|
| `apps/slides/src/renderer/ai/AiPanel.tsx` | slides，门控（:1192）|

### 11.2 端到端数据流

```
渲染进程 ai:get-settings
  → 主进程 readJson(ai-settings.json)
  → ensureDeepseekSettings(stored, defaults, creds)
    → resolveDeepseekCreds: env var → env_config.json → 默认
    → 三分支判定（seed/migrate/keep）
  → if writeBack: writeJson 落盘
  → return settings (provider='deepseek')
渲染进程 ai:stream (settings)
  → 主进程 streamForProvider('deepseek', config)
  → streamOpenAiCompatible POST https://api.deepseek.com/v1/chat/completions
    → header: Authorization: Bearer sk-...
    → body: { model: "deepseek-v4-flash", messages, stream: true }
  → SSE chunks → 渲染进程
失败时:
  → onError 回调
  → if (provider === 'genspark') { aiGskStatus()... }  // 门控，deepseek 跳过
  → setBusy(false)  // 收尾始终执行
```

### 11.3 DeepSeek API 端点

- 流式：`POST https://api.deepseek.com/v1/chat/completions`（`stream: true`，SSE）
- 非流式：同端点（`stream: false`）
- 鉴权：`Authorization: Bearer <api_key>`
- 协议：OpenAI 兼容

引擎硬编码 base URL 为 `https://api.deepseek.com/v1`（`stream.ts:841`），不读 `config.baseUrl`（仅 custom provider 读）。`env_config.json` 的 `DEEPSEEK_BASE_URL` 不被引擎消费，DeepSeek API 对根路径与 `/v1` 等价。

### 11.4 Slides Cloud Generation（本地 HTML->pptx）

生成精美 slide 的流程（**不再依赖 gsk 云端，无需 gsk 登录**）：

```
用户说"生成 PPT" -> generate_deck（slides-skill.ts）
  -> Step 0/1/1.5: Style Skill / outline 规划 / 图片搜索（kimi 优先 / Serper）
  -> Step 2: 每页 cloud-page-generate IPC（slides-main.ts:1377）
    -> provider 选择：providers.kimi.apiKey 非空 → kimi；否则 deepseek
    -> kimi 失败（API 错误/超时/空 HTML）→ deepseek 回退重试一次
    -> 流式生成 HTML（CLOUD_PAGE_SYSTEM_PROMPT 强约束 html2pptx 格式）
    -> stripCodeFence -> { ok: true, html }
  -> html-to-pptx IPC（slides-main.ts:1454）
    -> convertHtmlPage: html2pptx（packages/pptx-engine/src/html2pptx.ts）
    -> mergeSlideFromPptx 合并进 deck + promoteSlideBackground
  -> 生成后 QC pass（slide-qc.ts，kimi transport，支持视觉）
```

**启用条件**：`cloudSlideEnabled()`（slides-main.ts:1369）= ai-settings.json 的 `providers.kimi?.apiKey` 或 `providers.deepseek?.apiKey` 任一非空（与对话 provider 解耦）。

**环境变量**：
- `GENOFFICE_CLOUD_SLIDE=0`：kill switch，禁用 cloud generation
- `GENOFFICE_CLOUD_SLIDE_MODEL=<model>`：覆盖**当前生效生成 provider** 的模型（kimi 优先时覆盖 kimi.model，A/B 测试用）
- `KIMI_BASE_URL` / `KIMI_API_KEY` / `KIMI_MODEL`：kimi 凭据（env var > env_config.json > 默认），首次启动自举进 `providers.kimi`

**视觉功能**（AI Beautify / QC pass / 图片附件）：kimi 可用时用 kimi（支持 image_url）；无 kimi 配置时降级文本（AI Beautify 无截图 / QC 禁用 / 图片附件跳过）。

**HTML 格式约束**（html2pptx 要求，生成 prompt 已约束）：
- 文本必须在 `<p>`/`<h1>`-`<h6>`/`<ul>`/`<ol>` 里，`<div>` 只做容器/shape（不带直接文本）
- 字体：web-safe（Arial/Helvetica/Georgia/Times New Roman/Courier New/Verdana/Tahoma/Trebuchet MS）
- 颜色：`#RRGGBB` hex 格式
- 定位：`position:absolute` + `left/top/width/height`（px）；**flexbox 不支持**
- 图片：`<img src="真实URL">`，只使用提供的 URL

---

## 12. 文档索引

本仓库的详细设计/实现/测试文档在 `docs/`（本地保留，未 push 到 public repo）：

| 文档 | 内容 |
|---|---|
| `docs/feature-flow-v1.md` | 改造前现状（v1 基线）|
| `docs/modification.md` | 修改文档（9 决策 + 模块拆分）|
| `docs/technical-design.md` | 技术设计（STATUS: AS_BUILT，含 3 design-gap 更正）|
| `docs/feature-flow-v2.md` | Cycle 1 AS-BUILT（引擎层）|
| `docs/feature-flow-v3.md` | Cycle 2 AS-BUILT（应用主进程层）|
| `docs/feature-flow-v4.md` | Cycle 3 AS-BUILT（渲染进程层）|
| `docs/optimization-checklist-v1/v2/v3.md` | 各 cycle 评估（全 CONVERGED）|
| `docs/test-checklist-v1.md` | 测试清单 |
| `docs/test-report-v1.md` | 测试报告 v1（HAS_FAILURES，A9 prettier）|
| `docs/test-report-v2.md` | 测试报告 v2（ALL_PASSED）|
| `docs/orchestrator-state.md` | 工作流状态（COMPLETE）|

---

## 13. Git 信息

### 13.1 Remote 配置

```
origin    → lostinheaven-knt/genoffice-freeprovider  (本仓库，push/pull 默认)
upstream  → genspark-ai/genoffice                     (原项目，同步更新用)
```

### 13.2 关键 commits（provider 切换）

```
8bf4e87 Merge branch 'feat/slides-html2pptx': local HTML->pptx cloud generation (bug1)
68054ab test(slides): sync cloudGeneratePage mocks to html contract (marker -> html)
7c9a0d5 feat(slides): switch renderer cloud page generation to html (marker -> html)
d2236d7 test(pptx-engine): cover font-size conversion and inline runs
e56f620 feat(slides): local cloud page generation via deepseek + html2pptx
236eb1a feat(pptx-engine): add html2pptx module with TDD
147cb3a build(pptx-engine): move pptxgenjs to dependencies, add cheerio
9409034 fix(sheets): accept inputError/truncated on ai:stream toolCalls
5321d19 chore: gitignore local dev config (env_config.json) and workflow docs
5a2f933 Merge branch 'feat/deepseek-provider': switch AI provider from Genspark to DeepSeek
ac65e44 style(ai-provider): fix pre-existing prettier formatting in providers.test.ts
f2cc5ab fix(ai): gate gsk-status error prompt to genspark provider only
339e069 test(ai-provider): cover legacy single-endpoint migration + document shallow-copy invariant
b46132a feat(ai): bootstrap deepseek settings in docs/sheets/slides get-settings
00118af feat(ai-provider): add deepseek settings bootstrap/migration helpers
f7af8a4 feat(ai-provider): switch default provider to deepseek
```

### 13.3 分支策略

- `main`：稳定分支，含 provider 切换 + .gitignore 防护
- `feat/deepseek-provider`：已删除（已 merge 到 main）
- `feat/slides-html2pptx`：已删除（已 merge 到 main）

---

## 14. 已知限制与风险

| 项 | 说明 |
|---|---|
| `deepseek-v4-flash` 模型名 | 已实测验证为 DeepSeek API 有效模型名（不在引擎 `AI_PROVIDERS.deepseek.models` 元数据清单内，但 API 接受）。默认返回 reasoning_content（推理链），无需加 `thinking` 参数。`deepseek-chat` 是其别名（实测路由到同一模型）。|
| API key 明文存盘 | `ai-settings.json` 明文存 key，与原项目 `~/.genoffice/auth.json` 明文存 genspark key 同等基线。勿共享该文件。|
| prod 首次启动 key 可能为空 | `env_config.json` 不进打包，prod 无 env var 时自举写入空 key。prod 部署需设 `DEEPSEEK_API_KEY` env var 或手动放文件。|
| pdf 独立模式 AI 不可用 | pdf main 不注册 AI handler，仅 shell 聚合模式可用。|
| 切回 genspark 会被迁移 | bootstrap migrate 分支会把 `provider='genspark'` 自动改回 deepseek。如需长期用 genspark，需改 `bootstrap.ts` keep 条件。|
| 无 provider 选择 UI | 本仓库不加 UI（决策 7），换 provider 需编辑 ai-settings.json。|
| `env_config.json` 不进 git | 含 key，已 gitignore。`env_config.example.json` 是模板。|
| slides cloud generation 质量 | 精美页面由 deepseek 生成 HTML + 本地 html2pptx 转 pptx（html2pptx.ts）。主观质量可能低于 gsk 专有管线（已知风险，人工评估项）。布局约束 position:absolute（flexbox 不支持）。质量不足时用 `GENOFFICE_CLOUD_SLIDE_MODEL=deepseek-reasoner` 切换模型测试。|
| slides 生成引擎 kimi | slides 的 HTML 生成 + 视觉功能用 kimi-k2.7-code（火山引擎方舟），deepseek 兜底（kimi 失败自动回退）。**kimi max_tokens 上限 32768**（deepseek 100000），引擎已按 provider 动态设置。无 kimi 配置时视觉功能降级文本（AI Beautify 无截图 / QC 禁用 / 图片附件跳过）。|

---

## 15. 快速参考

### 15.1 日常开发

```bash
npm run dev:docs                              # 启动 docs dev
npm test --workspace @genoffice/ai-provider   # 引擎单测
npm run typecheck                             # 全量类型检查
npm run lint                                  # 全量 lint
```

### 15.2 紧急排查

```bash
# ai-settings.json 在哪
find ~/Library/Application\ Support -name ai-settings.json

# 当前 provider
cat ~/Library/Application\ Support/GenOffice\ Docs\ Dev/ai-settings.json | grep provider

# 重置 AI 配置（删文件重新自举）
rm ~/Library/Application\ Support/GenOffice\ Docs\ Dev/ai-settings.json
# 重启 dev mode

# 确认硬锁已删
grep -rn "settings.provider = 'genspark'" apps/   # 应无输出

# 确认 bootstrap 接线
grep -rn "ensureDeepseekSettings" apps/            # 应 6 处（3 app × import + 调用）
```

### 15.3 联系点

- 本仓库 issue：https://github.com/lostinheaven-knt/genoffice-freeprovider/issues
- 原项目：https://github.com/genspark-ai/genoffice
- DeepSeek API 文档：https://platform.deepseek.com/docs
