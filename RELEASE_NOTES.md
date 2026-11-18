# dsh-connect-cursor-pro v1.0.0

Use the models from your locally logged-in **Cursor** desktop app directly in **DeepSeek Harness** — no separate API key.

---

## ✨ Highlights

- **New Cursor support (3.27+)** — decrypts `cursor-safe-storage:v1` tokens automatically (Windows DPAPI / macOS Keychain / Linux keyring). The original plugin broke because Cursor started encrypting its login at rest.
- **New dsh support (0.2 kernel)** — structural `LlmAdapter` (no version-pinned base class), matching the `registerAdapter` / `resolveModel(provider, model, signal)` / `prepareCall` contract.
- **Client-version auto-detection** — reads the `cursor-agent` build tag (`cli-YYYY.MM.DD-sha`), fixing the `ERROR_OUTDATED_CLIENT` rejection (a semver like `3.30.14` is refused).
- **Multi-turn continuity** — reuses Cursor's `conversation_state` per session, continuing one conversation instead of starting fresh each turn.
- **Settings page** — credential status, live model catalog (4 shown, expandable), diagnostics, one-click refresh, and an optional credential editor.
- **Configurable endpoints/timeouts** — `apiBase`, `agentHost`, `clientVersion`, `timeoutMs`, `idleMs` via config or environment variables.
- **Robust credential chain** — env var → `state.vscdb` (auto-decrypted) → CLI `auth.json` → `CURSOR_API_KEY`, with expiry detection.

## 📦 Install

```sh
dsh plugin --profile web add /path/to/dsh-connect-cursor-pro
```

Or via the DSH UI: **Plugins → Add plugin** → select the directory. A **`cursor`** group appears in the model picker (restart dsh or refresh the UI if needed).

## 🔐 Credentials

Zero configuration by default — the plugin reads your local Cursor login and decrypts it. Optional overrides via the settings page (**Settings → Connect Cursor → Credentials**) or the `CURSOR_ACCESS_TOKEN` / `CURSOR_API_KEY` environment variables.

## 🧪 Verified

Tested end-to-end on **DSH 0.2.2-rc.3** (desktop): install, activation, credential decryption, live model catalog (47 models), and a real `agent.v1.AgentService/Run` turn. **DSH 0.1.x is untested**, and the peer range reflects that (`@deepseek-ai/dsh-llm: ^0.2.2-rc.2`).

## ⚠️ Risk disclosure

- **Private, reverse-engineered protocol.** Talks to Cursor's proprietary `agent.v1.AgentService/Run`; not an official API. A Cursor update may change the wire format and break the plugin until re-verified.
- **Sensitive credentials.** Reads your local Cursor JWT (decrypting `cursor-safe-storage:v1` via the OS keychain/DPAPI, or `auth.json`) or accepts one from the settings page/env. Never written to config or logs; the settings API never returns the plaintext — but any process running as you can read the same sources.
- **Cursor server access.** Calls Cursor's servers with your token, consuming your Cursor quota.
- **Not audited or endorsed.** The marketplace (DSHX) does not audit plugins or endorse their behavior. Review the source and risks yourself.
- Emits text/reasoning streams only; no dsh-side tool calls (Cursor runs its own agent loop); `tools` is off by default.
- Token usage may be empty when Cursor omits `turn_ended`.

## 📄 License

MIT © kpbl95946-art. See [NOTICE](NOTICE.md) for upstream attribution.

## 💬 Feedback

Found a bug or have a suggestion? Please open an [issue](https://github.com/kpbl95946-art/dsh-connect-cursor-pro/issues) — the author loves learning!

---

# 中文说明

把本机已登录的 **Cursor** 桌面端模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`），无需单独配置密钥。

## ✨ 亮点

- **新版 Cursor 支持（3.27+）**——自动解密 `cursor-safe-storage:v1` 加密的 token（Windows DPAPI / macOS Keychain / Linux keyring）。旧版插件失效正是因为 Cursor 开始加密本地登录态。
- **新版 dsh 支持（0.2 内核）**——结构性 `LlmAdapter`（不依赖版本锁定的基类），对齐 `registerAdapter` / `resolveModel(provider, model, signal)` / `prepareCall` 契约。
- **客户端版本自动识别**——读取 `cursor-agent` 构建标签（`cli-YYYY.MM.DD-sha`），修复 `ERROR_OUTDATED_CLIENT`（填语义化版本如 `3.30.14` 会被拒）。
- **多轮对话续接**——按会话复用 Cursor 的 `conversation_state`，续写同一对话而非每轮新建。
- **设置页**——凭据状态、可用模型清单（默认 4 个，可展开）、诊断信息、一键刷新，以及可选的凭据输入。
- **可配置端点/超时**——`apiBase`、`agentHost`、`clientVersion`、`timeoutMs`、`idleMs` 等可通过配置或环境变量调整。
- **更健壮的凭据链**——环境变量 → `state.vscdb`（自动解密）→ CLI `auth.json` → `CURSOR_API_KEY` 兑换，带过期检测。

## 📦 安装

```sh
dsh plugin --profile web add /path/to/dsh-connect-cursor-pro
```

或用 DSH 界面 **插件 → 添加插件** 选择该目录。安装后模型选择器出现 **`cursor`** 分组（必要时重启 dsh 或刷新界面）。

## 🔐 凭据

默认零配置——插件自动读取本机 Cursor 登录态并解密使用。可在设置页（**设置 → Cursor 接入 → 凭据**）或通过 `CURSOR_ACCESS_TOKEN` / `CURSOR_API_KEY` 环境变量手动覆盖。

## 🧪 实测

已在 **DSH 0.2.2-rc.3**（桌面版）完成端到端验证：安装、激活、凭据解密、实时模型目录（47 个模型）、一次真实 `agent.v1.AgentService/Run` 回合。**DSH 0.1.x 未测试**，peer 范围已如实反映（`@deepseek-ai/dsh-llm: ^0.2.2-rc.2`）。

## ⚠️ 风险披露

- **私有、逆向协议。** 通过 Cursor 私有的 `agent.v1.AgentService/Run` 通信，并非官方 API。Cursor 升级可能改变线路格式，需重新核对。
- **敏感凭证。** 读取本机 Cursor JWT（解密 `cursor-safe-storage:v1`，经系统密钥库/DPAPI，或读 `auth.json`），也可由设置页/环境变量提供。令牌不写配置、不打日志，设置 API 不回传明文；但以你的身份运行的本地进程同样能读取这些来源。
- **访问 Cursor 服务端。** 使用你账号的令牌请求 Cursor 服务器，消耗你的 Cursor 额度。
- **未经审计、非官方认可。** 插件市场（DSHX）不对上架插件做安全审计，也不代表官方认可插件行为。请自行审阅源码与风险后再使用。
- 仅输出文本/推理流，不向 dsh 发出工具调用（Cursor 跑自己的 agent 循环）；`tools` 默认关闭。
- Cursor 不总发 `turn_ended`，token 用量可能为空。

## 📄 许可证

MIT © kpbl95946-art。上游署名见 [NOTICE](NOTICE.md)。

## 💬 反馈

有问题或建议？欢迎提 [Issue](https://github.com/kpbl95946-art/dsh-connect-cursor-pro/issues)——作者热爱学习！！！
