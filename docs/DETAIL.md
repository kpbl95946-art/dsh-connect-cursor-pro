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
- **Configurable endpoints and timeouts** via bundle config or environment variables.

## Usage

1. Install and enable the plugin, then restart DSH.
2. Open **Settings → Models** and pick a model under the **`cursor`** group.

## Limitations

- Cursor's agent protocol is reverse-engineered and private; Cursor can change it without notice.
- The adapter streams text and reasoning. DSH-side tool calls are **not** emitted (Cursor runs its own agent loop); tool forwarding is off by default.
- Token usage may be empty when Cursor omits `turn_ended`.

## See also

The full README documents credential sources, environment variables, configuration keys, and troubleshooting.
