# dsh-connect-cursor-pro

> [English](README.md) · **中文**

把本机已登录的 **Cursor** 桌面端模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`），在 dsh 的模型选择器里直接使用 Cursor 账号能调用的模型，无需单独配置密钥。

> 这是社区插件 `greatyao/dsh-connect-cursor` 的 **Pro 版**：基于旧版协议实现，针对新版 dsh（0.2 内核）与新版 Cursor 做了适配与增强。
>
> 非官方。协议逆向自 Cursor 的 `agent.v1.AgentService/Run` 私有协议（ConnectRPC + Protobuf + HTTP/2 双向流），与 Cursor（Anysphere）、DeepSeek 均无关联，仅供个人学习研究。

## 相比旧版的改进

| 能力 | 说明 |
| --- | --- |
| **凭据解密（Cursor 3.27+）** | 新版 Cursor 用 `cursor-safe-storage:v1` 加密 `state.vscdb` 里的 token；Pro 版自动解密（Windows DPAPI / macOS Keychain / Linux keyring）后再使用 |
| 新版 dsh 适配 | 结构性实现 `LlmAdapter`（不依赖版本锁定的基类），适配 dsh 0.2 内核的 `registerAdapter` / `resolveModel(provider, model, signal)` / `prepareCall` 契约 |
| 客户端版本自动识别 | 读取 `cursor-agent` 构建标签（`cli-YYYY.MM.DD-sha`）作为 `x-cursor-client-version`，替代旧版写死的过期值（填语义化版本 `3.30.14` 会被拒 `ERROR_OUTDATED_CLIENT`） |
| 多轮对话续接 | 按会话复用 Cursor 的 `conversation_state`，续写同一对话而非每轮新建 |
| 可配置端点/超时 | `apiBase`、`agentHost`、`clientVersion`、`timeoutMs`、`idleMs` 等可通过配置或环境变量调整 |
| 更健壮的凭据链 | 环境变量 → `state.vscdb`（自动解密）→ CLI `auth.json` → `CURSOR_API_KEY` 兑换，带过期检测 |
| 设置页 | 浏览器侧「设置 → Cursor 接入」页：凭据状态、模型清单、诊断信息与一键刷新 |

## 工作原理

- 只读获取 Cursor 桌面应用的登录态，不启动额外 OAuth，不写入桌面应用文件
- 通过 HTTP/2 双向流调用 `agent.v1.AgentService/Run`，用原生 `LlmAdapter` 把流式增量翻成 dsh 的 `StreamChunk`
- 模型目录通过 `aiserver.v1.AiService/AvailableModels` unary 调用实时拉取

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-connect-cursor-pro
```

或用 DSH 界面 **插件 → 添加插件** 选择该目录。安装后模型选择器出现 **`cursor`** 分组（必要时重启 dsh 或刷新界面）。

## 凭据

### 概览：日常零配置

正常情况**什么都不用配**——装好插件后，它自动读取本机 Cursor 登录态并解密使用。只有下面这些场景才需要手动提供凭据：

| 使用场景 | 用什么 | 需要配置？ |
| --- | --- | --- |
| 本机已登录 Cursor 桌面端（最常见） | 自动读 `state.vscdb` | 不用 |
| 本机登录过 Cursor CLI | 自动读 `auth.json` | 不用 |
| 无本地登录态（远程 / 无头 / 服务器 / CI） | `CURSOR_API_KEY` 或 `CURSOR_ACCESS_TOKEN` | 要 |
| 想用另一个账号（不是本机登录的） | `CURSOR_ACCESS_TOKEN` | 要 |

### 凭据来源（按优先级，均只读）

| # | 来源 | 存储形态 | 何时用 |
| --- | --- | --- | --- |
| 1 | `CURSOR_ACCESS_TOKEN` 环境变量 | 明文 JWT | 可选覆盖：无本地登录态、换账号 |
| 2 | 桌面 `state.vscdb` | 加密（`cursor-safe-storage:v1`） | 自动，主路径 |
| 3 | CLI `auth.json` | 明文 JWT | 自动兜底 |
| 4 | `CURSOR_API_KEY` | `crsr_` 前缀 API key | 可选：无本地登录态时换 token |

来源 2 在 Cursor 3.27+ 已被加密，插件自动解密（Windows DPAPI / macOS Keychain / Linux keyring）；来源 3 通常是明文，无需解密。凭据解密后是 JWT，插件读取其 `exp` 字段判断是否过期；过期时重新打开 Cursor，由桌面应用自行续期。

### 获取方式

#### `CURSOR_ACCESS_TOKEN`（JWT）

即 Cursor 的访问令牌，`eyJhbGci…` 开头、点分三段。三种拿法：

1. **CLI `auth.json`（明文，最简单）**——登录过 Cursor CLI 即有：

   ```powershell
   Get-Content "$env:APPDATA\Cursor\auth.json"   # Windows
   ```
   ```bash
   cat ~/.config/cursor/auth.json                 # macOS / Linux
   ```

   取 `accessToken` 字段。

2. **浏览器 DevTools**——登录 [cursor.com](https://cursor.com) → F12 → Network → 任一请求头里的 `Authorization: Bearer <JWT>`。

3. **桌面 `state.vscdb`（加密）**——已被 `cursor-safe-storage:v1` 加密，需按 `lib/safestorage.js` 的解密链路手动解（DPAPI/Keychain → AES 密钥 → AES-GCM），不推荐（插件已自动完成）。

#### `CURSOR_API_KEY`

`crsr_` 开头的 API key，从 Cursor 账户后台生成。插件用它调 `auth/exchange_user_api_key` 换成短期 token，适合无本地登录态的服务器场景。

### 设置方式（设置页 vs 环境变量）

`CURSOR_ACCESS_TOKEN` / `CURSOR_API_KEY` 有两种设置方式：

- **设置页（推荐）**：「设置 → Cursor 接入 → 凭据（可选）」直接填入并保存，写入 DSH 凭据服务，即改即生效、无需重启。
- **环境变量**：DSH 桌面端只在**启动时**继承当时的进程环境——终端里 `set`/`export` 对已运行的 DSH 不生效；需设为系统 / 用户环境变量后**完全退出并重启 DSH**，或在带变量的终端里启动。

token 等价于密码：别贴到公开处、别写进 git；它有 `exp` 有效期，过期后需重新获取。

## 设置页

安装并启用后，浏览器侧「设置 → Cursor 接入」页展示：

- **凭据状态**：是否找到 Cursor 登录态、来源（`state.vscdb` / `cli-auth` / `env` / `api-key`）与过期时间
- **可用模型**：实时拉取账号可用的模型清单（含上下文窗口），默认展示 4 个，可展开/收起
- **诊断信息**：客户端版本、API 端点、多轮续接 / 工具转发开关、上次刷新时间
- **凭据（可选）**：直接填入 `CURSOR_ACCESS_TOKEN` / `CURSOR_API_KEY` 并保存——写入 DSH 凭据服务（密文存储、即改即生效），无需折腾环境变量
- **刷新**：一键重新探测凭据并刷新模型清单

设置页数据由 Host 的 JSON API（`/status`、`/refresh`、`/credentials`）提供，读写凭据永不回传明文 token。

## 配置与环境变量

通过 bundle 的 `config`（`cordis.patch.yml` 的 `config: {}`）或环境变量设置，环境变量优先于默认值：

| 配置键 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `apiBase` | `CURSOR_API_BASE_URL` | `https://api2.cursor.sh` | 模型目录 / token 兑换端点 |
| `agentHost` | `CURSOR_AGENT_HOST` | `agentn.global.api5.cursor.sh` | Run 双向流主机 |
| `clientVersion` | `CURSOR_CLI_VERSION` | 自动识别（`cli-YYYY.MM.DD-sha`） | `x-cursor-client-version` 头；必须用 agent 构建标签格式（`cli-…`），用语义化版本会被拒 `ERROR_OUTDATED_CLIENT` |
| `appPath` | `CURSOR_APP_PATH` | 按平台探测 | Cursor 应用根目录 |
| `workbenchBundle` | `CURSOR_WORKBENCH_BUNDLE` | 按平台探测 | `workbench.desktop.main.js` 路径 |
| `timeoutMs` | `CURSOR_TIMEOUT_MS` | `300000` | 整回合超时（毫秒） |
| `idleMs` | `CURSOR_IDLE_MS` | `12000` | 内容空闲兜底结束（毫秒） |
| `poolSize` | `CURSOR2API_POOL` | `2` | HTTP/2 预热连接数 |
| `multiTurn` | `CURSOR_MULTITURN` | `true` | 多轮对话续接；`false` 则每轮独立 |
| `tools` | `CURSOR_TOOLS` | `false` | 转发 dsh 工具为 Cursor MCP 工具（实验性） |
| `includeHidden` | `CURSOR_INCLUDE_HIDDEN` | `false` | 目录是否包含隐藏模型 |

## 平台支持

macOS / Windows / Linux（Windows 已实测）。安装位置按「PATH 上的 `cursor`（`where`/`which`）→ 平台默认路径」探测：

- macOS：`/Applications/Cursor.app/Contents/Resources/app`
- Windows：`%LOCALAPPDATA%\Programs\cursor\resources\app`
- Linux：`/usr/share/cursor/resources/app`、`/opt/Cursor/resources/app`

客户端版本优先读取 `%LOCALAPPDATA%\cursor-agent\versions\` 下的构建目录名（`YYYY.MM.DD-sha`）。非默认安装位置用 `CURSOR_APP_PATH` 指向应用根目录，或用 `CURSOR_WORKBENCH_BUNDLE` 直接指向 `workbench.desktop.main.js`。

## 已知限制

- **仅在 DSH 0.2.2-rc.3 上实测。** 适配器为结构性实现（不继承 `LlmAdapter` 基类），设计上可跨内核版本，但只有 0.2.2-rc.3 完成过端到端验证（安装、激活、凭据解密、模型目录、一次真实 Run 回合）；DSH 0.1.x 未测试。
- 协议私有、版本门控：`x-cursor-client-version` 必须是 `cli-YYYY.MM.DD-sha` 构建标签（自动识别，可用 `CURSOR_CLI_VERSION` 覆盖）；Cursor 升级后字段号可能变化，可用 `lib/schema.js` 的 `inspectType('agent.v1.AgentRunRequest')` 重新核对
- `model_details.model_id` 必须是默认 variant 的 slug（如 `claude-sonnet-5-thinking-high`），基础 id 会被拒为 `ERROR_BAD_MODEL_NAME`
- `UserMessageAction` 必须带 `request_context`（缺了服务端只发心跳不产出）
- 本插件输出**文本与推理**流；不会向 dsh 发出工具调用（Cursor 跑自己的 agent 循环），`tools` 默认关闭
- token 用量统计：Cursor 不总发 `turn_ended`，`usage` 可能为空

## 开发与自测

```sh
node --test test/
```

## 免责声明

仅供个人学习研究使用。使用者需遵守 Cursor 的服务条款，因使用本项目产生的后果由使用者自行承担。

## 许可证

MIT © kpbl95946-art。上游署名见 [NOTICE](NOTICE.md)。
