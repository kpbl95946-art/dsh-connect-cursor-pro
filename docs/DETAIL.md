# Connect Cursor

Use the models from your locally logged-in **Cursor** desktop app directly in **DeepSeek Harness** — no separate API key.

## What it does

- Registers a **`cursor`** group in the DSH model picker, populated live from your Cursor account's `AvailableModels`.
- Streams responses through a native `LlmAdapter` that speaks Cursor's `agent.v1.AgentService/Run` bidirectional protocol (ConnectRPC + Protobuf + HTTP/2), so streaming text and reasoning appear in DSH like any other model.
- Reuses the local Cursor login (read-only) and starts no extra OAuth flow.

## Pro additions

- **Safe-storage decryption** — decrypts Cursor 3.27+'s `cursor-safe-storage:v1` tokens (Windows DPAPI / macOS Keychain / Linux keyring) so the local login keeps working on new Cursor.
- **Multi-turn continuity** — consecutive turns reuse one Cursor conversation (keyed by session) instead of starting fresh.
- **Automatic client-version detection** — reads the Cursor agent build tag (`cli-YYYY.MM.DD-sha`) for `x-cursor-client-version` instead of a hard-coded, stale header value.
- **Settings page** — a "Connect Cursor" section under Settings shows credential status, the live model catalog, and diagnostics.
- **Image input** — forwards composer images to Cursor models as inline `SelectedImage` (all models accept images, even those flagged `supports_images: false`).
- **File tools** — executes Cursor's built-in `read`/`write`/`ls`/`shell` tool calls in the DSH workspace, so the agent can create/edit files and run commands instead of hanging on unserved tool calls.
- **Configurable endpoints and timeouts** via bundle config or environment variables.

## ⚠️ Risk disclosure

- **Private, reverse-engineered protocol.** Talks to Cursor's proprietary `agent.v1.AgentService/Run` (ConnectRPC + Protobuf + HTTP/2), not an official Cursor API. A Cursor update may change the wire format or field numbers and break the plugin until re-verified.
- **Sensitive credentials.** Reads your local Cursor JWT — the `cursor-safe-storage:v1` value in `state.vscdb` (decrypted via the OS keychain / DPAPI) or `auth.json` — or accepts one from the settings page / environment. Tokens are never written to config or logs and the settings API never returns the plaintext, but any local process running as you can read the same sources.
- **Cursor server access.** Calls Cursor's servers (e.g. `api2.cursor.sh`, the agent host) with your account's token, consuming your Cursor quota.
- **Not audited or endorsed.** The plugin marketplace (DSHX) does not audit listed plugins and does not endorse their behavior. Review the source and the risks yourself.

## Usage

1. Install and enable the plugin, then restart DSH.
2. Open **Settings → Models** and pick a model under the **`cursor`** group.

## Limitations

- Cursor's agent protocol is reverse-engineered and private; Cursor can change it without notice.
- The adapter streams text and reasoning. DSH-side tool calls are **not** emitted (Cursor runs its own agent loop); tool forwarding is off by default.
- Token usage may be empty when Cursor omits `turn_ended`.

## Feedback

Found a bug or have a suggestion? Please open an [issue](https://github.com/kpbl95946-art/dsh-connect-cursor-pro/issues) — the author loves learning!

## See also

The full README documents credential sources, environment variables, configuration keys, and troubleshooting.
