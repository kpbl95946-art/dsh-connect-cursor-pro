# Notice

This project is released under the MIT License (see `LICENSE`).

## Upstream attribution

Portions of this project are derived from the following MIT-licensed works. Their
copyright notices are retained here as required by the MIT License:

- **dsh-connect-cursor** — <https://github.com/greatyao/dsh-connect-cursor>
  - Copyright (c) greatyao
  - The original Cursor `agent.v1` protocol implementation (protobuf/Connect
    framing, the bidi HTTP/2 Run client, credential sourcing, model catalog, and
    stream translation) that this project's `lib/` modules adapt and extend.

- **cursor2api** — <https://github.com/Yuki13929/cursor2api>
  - Copyright (c) the cursor2api authors
  - Behavior reference for the Cursor `h2stream` transport and the
    `AvailableModels` field-number decoding.

## Cursor protocol

The Cursor `agent.v1.AgentService/Run` protocol is private and reverse-engineered
from Cursor's own client bundle. This project is not affiliated with, endorsed
by, or supported by Cursor (Anysphere). Use it in compliance with Cursor's terms
of service.
