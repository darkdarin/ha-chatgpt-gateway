# ChatGPT Gateway

The app signs in to your ChatGPT plan (Plus or Pro) with OpenAI's official **Sign in with
ChatGPT** and serves the plan's models on your home network as an OpenAI-compatible API. Requests
count against your plan's usage, the same as using ChatGPT itself.

## Install

1. Install and start the app. **ChatGPT Gateway** appears in the sidebar.
2. Open it and press **Sign in with ChatGPT**. Sign in on OpenAI's page and allow the app to use
   your plan.
3. After signing in, the browser tries to open an address starting with
   `http://127.0.0.1:…/auth/callback` and shows an error: that is expected, since the app runs on
   another machine. Copy that address from the address bar, paste it on the app page and press
   **Finish sign-in**.
4. The page shows the models of your plan, the API address and the API key for clients.

## Clients

Any client of the OpenAI API works: set its base URL and API key.

| Client | Base URL |
|---|---|
| FlowPilot (another app on the same Home Assistant) | `http://d9eec4fe-chatgpt-gateway:8780/v1` |
| Anything else on your network | `http://<home-assistant-address>:8780/v1` (map port 8780 first, see below) |

The key goes into the `Authorization: Bearer <key>` header (the "API key" field of most clients).
Regenerate it on the app page if it leaks; clients then need the new one.

Supported: `GET /v1/models`, `POST /v1/chat/completions` (streamed or not) with text and image
messages, function tools (the client runs them), `reasoning_effort` and `response_format`.
`temperature`, `max_tokens` and similar options are accepted and ignored: ChatGPT plan usage does
not support them.

## Network

The API listens on port 8780 inside Home Assistant. To reach it from other machines, set a host
port for `8780/tcp` on the app's **Network** tab. Never forward it to the internet: the plan is for
your household only.

## Options

- **Log level**: how much the gateway writes to the app log. Tokens, keys and the contents of
  requests are never logged.

## Data and backups

The app's data folder keeps the API key and the ChatGPT sign-in. The sign-in is kept out of Home
Assistant backups: after restoring a backup, sign in again on the app page.

## Limits

When your plan's usage limit (or a limit you set for this app in ChatGPT settings) is reached,
requests fail with HTTP 429 and the app page says so. Manage limits in ChatGPT: **Settings →
Usage**. To disconnect the app from your account, use **Sign out** on the app page.
