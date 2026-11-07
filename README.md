<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/darkdarin/ha-chatgpt-gateway/main/assets/brand/dark_logo.png">
    <img alt="ChatGPT Gateway" src="https://raw.githubusercontent.com/darkdarin/ha-chatgpt-gateway/main/assets/brand/logo.png" width="420">
  </picture>
</p>

# ChatGPT Gateway for Home Assistant

[![Release](https://img.shields.io/github/v/release/darkdarin/ha-chatgpt-gateway?sort=semver)](https://github.com/darkdarin/ha-chatgpt-gateway/releases)
[![CI](https://github.com/darkdarin/ha-chatgpt-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/darkdarin/ha-chatgpt-gateway/actions/workflows/ci.yml)
[![Release build](https://github.com/darkdarin/ha-chatgpt-gateway/actions/workflows/release.yml/badge.svg)](https://github.com/darkdarin/ha-chatgpt-gateway/actions/workflows/release.yml)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-2026.10%2B-18BCF2?logo=homeassistant&logoColor=white)](https://www.home-assistant.io/)
![aarch64](https://img.shields.io/badge/aarch64-yes-green.svg)
![amd64](https://img.shields.io/badge/amd64-yes-green.svg)
[![License](https://img.shields.io/github/license/darkdarin/ha-chatgpt-gateway)](LICENSE)

Use your **ChatGPT plan** (Plus or Pro) instead of paying for the OpenAI API at home. The app signs
in with OpenAI's official **Sign in with ChatGPT** and serves the plan's models on your home
network as an **OpenAI-compatible API**: [FlowPilot](https://github.com/darkdarin/flowpilot)'s LLM
agent, Home Assistant integrations with a configurable OpenAI address, scripts and tools use it like
any OpenAI endpoint.

> Early version (0.1, not released yet). Sign-in, the model list and streamed answers with tool
> calls work end to end with FlowPilot's LLM agent. Not translated yet: web search, files and
> audio.

## What you get

- **The official sign-in.** OpenAI's Sign in with ChatGPT, which lets open-source projects that run
  locally use a ChatGPT plan. No borrowed client of another app, no session cookies.
- **An OpenAI-compatible API.** `GET /v1/models` lists your plan's models;
  `POST /v1/chat/completions` answers, streamed as the model writes, so a voice assistant can start
  speaking before the answer is complete.
- **Sign in from any browser.** The app runs on your Home Assistant machine, you sign in on your
  laptop or phone: paste one address back into the app page, and that's it. Tokens renew by
  themselves for weeks.
- **Your key, your network.** Clients use an API key the app generates (regenerate it any time).
  The ChatGPT sign-in is kept out of Home Assistant backups.
- **Honest errors.** A reached usage limit is a proper HTTP 429 that clients understand, and the app
  page says what happened.

## What you need

- Home Assistant OS or Supervised, **2026.10 or newer** (the app runs on aarch64 and amd64, for
  example a Raspberry Pi 5).
- A **ChatGPT Plus or Pro** plan. Requests count against the plan's usage, like using ChatGPT
  itself; you can set a separate limit for the app in ChatGPT settings.

## Installation

### Step 1. Install the app

[![Open the app in Home Assistant](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=d9eec4fe_chatgpt_gateway&repository_url=https%3A%2F%2Fgithub.com%2Fdarkdarin%2Fha-chatgpt-gateway)

1. Press the button: Home Assistant offers to add the repository and opens the app page.
   By hand: **Settings → Apps → App Store → ⋮ → Repositories**, add
   `https://github.com/darkdarin/ha-chatgpt-gateway`, then find **ChatGPT Gateway** in the store.
2. Install the app and start it. **ChatGPT Gateway** appears in the sidebar.

### Step 2. Sign in with ChatGPT

1. Open **ChatGPT Gateway** in the sidebar and press **Sign in with ChatGPT**.
2. Sign in on OpenAI's page and allow the app to use your plan.
3. The browser then tries to open `http://127.0.0.1:…/auth/callback?…` and fails: that is
   expected. Copy that address from the address bar, paste it on the app page and press **Finish
   sign-in**.

### Step 3. Connect a client

The app page shows the API address and key. In FlowPilot's **LLM agent** node, set the base URL to
`http://d9eec4fe-chatgpt-gateway:8780/v1` and the API key to a FlowPilot secret holding the key;
the node lists the models itself.

## Configuration

### App options

| Option | What for |
|---|---|
| `log_level` | how much the gateway writes to the app log (`debug` for troubleshooting); tokens, keys and requests are never logged |

### Clients outside Home Assistant

Apps on the same Home Assistant reach the API at `http://d9eec4fe-chatgpt-gateway:8780/v1`. For
other machines on your network, set a host port for `8780/tcp` on the app's **Network** tab and use
`http://<home-assistant-address>:<port>/v1`. Never forward the port to the internet: the plan is
for your household only.

### What the API accepts

| Field | Support |
|---|---|
| `model` | a slug from `GET /v1/models` |
| `messages` | `system`, `developer`, `user`, `assistant` (with `tool_calls`) and `tool` messages; text, and images as `image_url` parts |
| `stream` | `true` (Server-Sent Events, with `stream_options.include_usage`) or `false` |
| `tools`, `tool_choice`, `parallel_tool_calls` | function tools: the model asks, the client runs them (the gateway never does) |
| `reasoning_effort` | `none`, `low`, `medium`, `high`… as the model allows |
| `response_format` | `json_object` and `json_schema` |
| `temperature`, `top_p`, `max_tokens`, `stop`… | accepted and ignored: ChatGPT plan usage does not support them |

## If something does not work

- **401 `invalid_api_key`.** The client's key is not the one on the app page (it may have been
  regenerated).
- **503 `not_signed_in`.** Sign in on the app page; if you were signed in, the sign-in may have
  been revoked in ChatGPT settings or lost with a restored backup.
- **429 usage limit.** Your plan's limit, or one you set for the app in ChatGPT **Settings →
  Usage**, is reached. The page says when this happened; ChatGPT shows when the limit resets.

## How it works

```
FlowPilot, integrations,     OpenAI Chat Completions      ChatGPT          Responses API
scripts on your network  ──────────────────────────────>  Gateway  ──────────────────────────> OpenAI
                         <──────────── streamed ─────────  (app)  <──────── streamed ─────────  (your plan)
```

The app keeps the ChatGPT sign-in (OAuth with PKCE; the access token is renewed before it expires)
and translates each Chat Completions request into a Responses API request with your plan's token,
then streams the answer back as Chat Completions chunks. It is a thin gateway: it does not run
tools or keep conversations, so clients decide what the model may do.

## Development

| Path | What |
|---|---|
| `src/` | the gateway (TypeScript, run by Node 26 directly, no build step) |
| `test/` | tests (`node:test`, no network or ChatGPT account needed) |
| `addon/` | Home Assistant app |
| `scripts/` | brand images, local app folder |

```sh
npm ci
npm run check                                  # lint, type check, tests
DATA_DIR=/tmp/gateway npm start                # the API on port 8780
```

Checks and conventions: [CONTRIBUTING.md](CONTRIBUTING.md). Rules for coding agents:
[AGENTS.md](AGENTS.md). Research and decisions are kept in the owner's Notion.

## License

[Apache License 2.0](LICENSE). ChatGPT and OpenAI are trademarks of OpenAI; this project is not
affiliated with OpenAI.
