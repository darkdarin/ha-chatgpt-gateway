# Changelog

## 0.2.0

- **Answers start about 0.8 s sooner.** The app keeps a WebSocket connection to OpenAI open and
  warm instead of making a new HTTP request for every answer: the first words of an answer now
  come in about 0.7 s instead of 1.6 s. If the connection cannot be used, answers go over HTTP as
  before; the new option **Keep a connection to OpenAI open** turns it off.

## 0.1.0

- First version: sign in with your ChatGPT plan on the app page, and use its models from FlowPilot
  and other clients through an OpenAI-compatible API (`/v1/models`, `/v1/chat/completions`,
  streamed), with a key the app generates.
- Function calling passes through (FlowPilot's "remember…" works), as do images and
  `reasoning_effort`.
- The sign-in renews itself in the background and stays out of Home Assistant backups; a reached
  usage limit is an HTTP 429 for clients and a note on the app page.
