# Changelog

## 0.1.0

Not released yet.

- First version: sign in with your ChatGPT plan on the app page, and use its models from FlowPilot
  and other clients through an OpenAI-compatible API (`/v1/models`, `/v1/chat/completions`,
  streamed), with a key the app generates.
- Function calling passes through (FlowPilot's "remember…" works), as do images and
  `reasoning_effort`.
- The sign-in renews itself in the background and stays out of Home Assistant backups; a reached
  usage limit is an HTTP 429 for clients and a note on the app page.
