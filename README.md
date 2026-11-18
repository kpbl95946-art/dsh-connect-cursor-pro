# dsh-connect-cursor-pro

> **English** · [中文](README.zh.md)

Use the models from your locally logged-in **Cursor** desktop app directly in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — no separate API key.

> This is the **Pro** fork of the community plugin `greatyao/dsh-connect-cursor`: built on the original protocol implementation, adapted and enhanced for the new dsh (0.2 kernel) and new Cursor.
>
> Unofficial. The protocol is reverse-engineered from Cursor's private `agent.v1.AgentService/Run` (ConnectRPC + Protobuf + HTTP/2 bidirectional stream). Not affiliated with Cursor (Anysphere) or DeepSeek. For personal study/research only.

## Improvements over the original

| Capability | Description |
| --- | --- |
| **Credential decryption (Cursor 3.27+)** | New Cursor encrypts tokens in `state.vscdb` with `cursor-safe-storage:v1`; Pro decrypts them automatically (Windows DPAPI / macOS Keychain / Linux keyring) |
| New dsh compatibility | Structural `LlmAdapter` (no version-pinned base class), matching the dsh 0.2 kernel's `registerAdapter` / `resolveModel(provider, model, signal)` / `prepareCall` contract |
| Client-version auto-detection | Reads the `cursor-agent` build tag (`cli-YYYY.MM.DD-sha`) for `x-cursor-client-version`, replacing the stale hard-coded value (a semver like `3.30.14` is rejected with `ERROR_OUTDATED_CLIENT`) |
| Multi-turn continuity | Reuses Cursor's `conversation_state` per session, continuing one conversation instead of starting fresh each turn |
| Configurable endpoints/timeouts | `apiBase`, `agentHost`, `clientVersion`, `timeoutMs`, `idleMs` via config or environment variables |
| Robust credential chain | env var → `state.vscdb` (auto-decrypted) → CLI `auth.json` → `CURSOR_API_KEY` exchange, with expiry detection |
| Settings page | A "Connect Cursor" page under Settings: credential status, model catalog, diagnostics, one-click refresh |

## How it works

- Reads the local Cursor login read-only; no extra OAuth, never writes Cursor's files
- Streams over the HTTP/2 bidirectional `agent.v1.AgentService/Run`, mapping deltas to dsh `StreamChunk` via a native `LlmAdapter`
- Fetches the model catalog live via the `aiserver.v1.AiService/AvailableModels` unary call

## Install

```sh
dsh plugin --profile web add /path/to/dsh-connect-cursor-pro
```

Or via the DSH UI: **Plugins → Add plugin** and select the directory. After install, a **`cursor`** group appears in the model picker (restart dsh or refresh the UI if needed).

## Credentials

### Overview: zero configuration by default

Normally you configure **nothing** — after install the plugin reads your local Cursor login and decrypts it. You only provide credentials manually in these cases:

| Scenario | What to use | Configure? |
| --- | --- | --- |
| Cursor desktop signed in locally (most common) | Auto-read `state.vscdb` | No |
| Signed in to the Cursor CLI | Auto-read `auth.json` | No |
| No local login (remote / headless / server / CI) | `CURSOR_API_KEY` or `CURSOR_ACCESS_TOKEN` | Yes |
| Use a different account | `CURSOR_ACCESS_TOKEN` | Yes |

### Credential sources (priority order, all read-only)

| # | Source | Stored form | When |
| --- | --- | --- | --- |
| 1 | `CURSOR_ACCESS_TOKEN` env var | Plain JWT | Optional override: no local login, switch account |
| 2 | Desktop `state.vscdb` | Encrypted (`cursor-safe-storage:v1`) | Automatic, primary |
| 3 | CLI `auth.json` | Plain JWT | Automatic fallback |
| 4 | `CURSOR_API_KEY` | `crsr_`-prefixed API key | Optional: exchange for a token with no local login |

Source 2 is encrypted on Cursor 3.27+; the plugin decrypts it automatically (Windows DPAPI / macOS Keychain / Linux keyring). Source 3 is usually plaintext and needs no decryption. Credentials are JWTs; the plugin reads their `exp` to detect expiry. If expired, reopen Cursor and the desktop app renews them.

### How to obtain

#### `CURSOR_ACCESS_TOKEN` (JWT)

Cursor's access token — an `eyJhbGci…` string in three dot-separated parts. Three ways to get it:

1. **CLI `auth.json` (plaintext, easiest)** — present after signing in to the Cursor CLI:

   ```powershell
   Get-Content "$env:APPDATA\Cursor\auth.json"   # Windows
   ```
   ```bash
   cat ~/.config/cursor/auth.json                 # macOS / Linux
   ```

   Copy the `accessToken` field.

2. **Browser DevTools** — sign in to [cursor.com](https://cursor.com) → F12 → Network → `Authorization: Bearer <JWT>` on any request.

3. **Desktop `state.vscdb` (encrypted)** — encrypted with `cursor-safe-storage:v1`; decrypting it manually follows the `lib/safestorage.js` chain (DPAPI/Keychain → AES key → AES-GCM). Not recommended — the plugin already does it.

#### `CURSOR_API_KEY`

A `crsr_`-prefixed API key generated from the Cursor account dashboard. The plugin exchanges it for a short-lived token via `auth/exchange_user_api_key`, suitable for server scenarios with no local login.

### How to set them (settings page vs environment)

`CURSOR_ACCESS_TOKEN` / `CURSOR_API_KEY` can be set two ways:

- **Settings page (recommended)**: fill in "Settings → Connect Cursor → Credentials (optional)" and save; written to the DSH credentials service, effective immediately, no restart.
- **Environment variable**: the DSH desktop inherits its process environment only **at launch** — `set`/`export` in a terminal does not affect an already-running DSH; set it as a system/user environment variable and **fully quit and restart DSH**, or launch DSH from a terminal that has the variable set.

A token is a password: never post it publicly or commit it to git; it has an `exp` expiry and must be re-obtained when it lapses.

## Settings page

After install and enable, the "Settings → Connect Cursor" page shows:

- **Credential status**: whether a Cursor login was found, its source (`state.vscdb` / `cli-auth` / `env` / `api-key`) and expiry
- **Available models**: the account's live model catalog (with context window), 4 shown by default with expand/collapse
- **Diagnostics**: client version, API base, agent host, multi-turn / tools toggles, last refresh time
- **Credentials (optional)**: fill in `CURSOR_ACCESS_TOKEN` / `CURSOR_API_KEY` and save — written to the DSH credentials service (encrypted storage, effective immediately)
- **Refresh**: one click to re-probe credentials and refresh the catalog

The page reads from Host JSON APIs (`/status`, `/refresh`, `/credentials`); credential reads/writes never echo the plaintext token.

## Configuration & environment variables

Set via the bundle `config` (`config: {}` in `cordis.patch.yml`) or environment variables; env vars take precedence:

| Config key | Env var | Default | Description |
| --- | --- | --- | --- |
| `apiBase` | `CURSOR_API_BASE_URL` | `https://api2.cursor.sh` | Catalog / token-exchange endpoint |
| `agentHost` | `CURSOR_AGENT_HOST` | `agentn.global.api5.cursor.sh` | Run bidirectional stream host |
| `clientVersion` | `CURSOR_CLI_VERSION` | auto (`cli-YYYY.MM.DD-sha`) | `x-cursor-client-version` header; must be the agent build-tag format (`cli-…`), a semver is rejected with `ERROR_OUTDATED_CLIENT` |
| `appPath` | `CURSOR_APP_PATH` | detected | Cursor app root |
| `workbenchBundle` | `CURSOR_WORKBENCH_BUNDLE` | detected | Path to `workbench.desktop.main.js` |
| `timeoutMs` | `CURSOR_TIMEOUT_MS` | `300000` | Whole-turn timeout (ms) |
| `idleMs` | `CURSOR_IDLE_MS` | `12000` | Content-idle fallback end (ms) |
| `poolSize` | `CURSOR2API_POOL` | `2` | HTTP/2 prewarm pool size |
| `multiTurn` | `CURSOR_MULTITURN` | `true` | Multi-turn continuity; `false` = independent turns |
| `tools` | `CURSOR_TOOLS` | `false` | Forward dsh tools as Cursor MCP tools (experimental) |
| `includeHidden` | `CURSOR_INCLUDE_HIDDEN` | `false` | Include hidden models in the catalog |

## Platform support

macOS / Windows / Linux (Windows tested). Install location is detected via "`cursor` on PATH (`where`/`which`) → platform default paths":

- macOS: `/Applications/Cursor.app/Contents/Resources/app`
- Windows: `%LOCALAPPDATA%\Programs\cursor\resources\app`
- Linux: `/usr/share/cursor/resources/app`, `/opt/Cursor/resources/app`

The client version prefers the build directory name under `%LOCALAPPDATA%\cursor-agent\versions\` (`YYYY.MM.DD-sha`). For non-default installs, point `CURSOR_APP_PATH` at the app root, or `CURSOR_WORKBENCH_BUNDLE` directly at `workbench.desktop.main.js`.

## Known limitations

- Private protocol with version gating: `x-cursor-client-version` must be a `cli-YYYY.MM.DD-sha` build tag (auto-detected, overridable via `CURSOR_CLI_VERSION`); after a Cursor upgrade field numbers may change — re-verify with `lib/schema.js` `inspectType('agent.v1.AgentRunRequest')`
- `model_details.model_id` must be the default variant slug (e.g. `claude-sonnet-5-thinking-high`); a base id is rejected with `ERROR_BAD_MODEL_NAME`
- `UserMessageAction` must carry `request_context` (otherwise the server only sends heartbeats, no output)
- This plugin emits **text and reasoning** streams; it does not emit dsh-side tool calls (Cursor runs its own agent loop); `tools` is off by default
- Token usage: Cursor does not always send `turn_ended`, so `usage` may be empty

## Development & tests

```sh
node --test test/
```

## Disclaimer

For personal study and research only. You are responsible for complying with Cursor's terms of service; use at your own risk.

## License

MIT. Based on [greatyao/dsh-connect-cursor](https://github.com/greatyao/dsh-connect-cursor) (MIT).
