# AGENTS.md

**ChatGPT Gateway** is a Home Assistant app (add-on) that signs in to the owner's ChatGPT plan with
OpenAI's official **Sign in with ChatGPT** and exposes the plan's models on the local network as an
**OpenAI-compatible API** (`/v1/models`, `/v1/chat/completions`, streamed). Clients in the home use
it like any OpenAI endpoint: first of all the **LLM agent** node of
[FlowPilot](https://github.com/darkdarin/flowpilot) (`~/Projects/ha-flow-pilot`), then Home
Assistant integrations with a configurable OpenAI address, scripts and tools.

The spike below is done (2026-11-07; answers and evidence on the Notion project page). Next: the
app.

## Owner and communication

- The owner writes in Russian; answer in Russian. Everything **in the repository** is in English
  (code, comments, docs, commit messages). Research, plans and decisions go to Notion, in Russian.
- Releases, publishing (making the repository public, pushing tags) and anything on the owner's
  live Home Assistant (Raspberry Pi 5, reachable as `ssh ha`; it runs a real home) only with the
  owner's explicit consent each time. Committing and pushing finished, green work to `main` is fine.

## Documentation (Notion; read before working)

- **[ChatGPT Gateway](https://app.notion.com/p/410e74ee720f819a84bdd2aba61d0979)** — the project
  page: what was found about Sign in with ChatGPT (with sources), rejected approaches, decisions,
  the spike checklist, the app plan, risks, status and roadmap. Start here.
- **[Поставка в Home Assistant](https://app.notion.com/p/410e74ee720f81f184cfc6ecf07080ba)** —
  how this family of projects ships: repository layout, branding (`scripts/brand.py`), README
  style, the app's `config.yaml`, prebuilt multi-arch images, changelog with `### App` /
  `### Integration`, `release.yml`, CI rules, testing on the dev Home Assistant. Follow it.
- Both pages live under **AI Personal Assistant** (page id `40de74ee720f80c9b562f4ecd6994808`),
  next to [FlowPilot](https://app.notion.com/p/40de74ee720f8085816fccb77ca103f7) and
  [Telegram Assist](https://app.notion.com/p/410e74ee720f81b2a43aff42b25bf396). The decisions
  behind this project are also in FlowPilot's "07 · Roadmap" (ADR-018: tools, skills and MCP live
  in FlowPilot, not in the gateway).
- Sibling repositories to copy conventions from: `~/Projects/ha-telegram-assist` (smallest) and
  `~/Projects/ha-flow-pilot` (the app: `addon/`, `Dockerfile`, `.github/workflows/release.yml`,
  `scripts/brand.py`).

### Working with Notion

- Use the Notion MCP tools: `notion-fetch` (by URL or page id) to read, `notion-update-page` to
  edit (prefer targeted `update_content` replacements over rewriting a whole page),
  `notion-create-pages` with the parent page id for new child pages.
- Notion is **in Russian**; the repository stays in English. Do not duplicate Notion in the
  repository: link it.
- Keep the project page current as you work: after the spike, write the answers with evidence
  into its spike section; record each decision with its trade-offs (what was chosen, what was
  rejected and why); update **Status** and the **Roadmap** when a step is done or plans change.
  If you learn something about shipping that applies to all projects, add it to the delivery
  page.
- Never put secrets, tokens, API keys, account data or personal data in Notion.

## What was decided (and why)

1. **A thin gateway, not an agent.** Only: sign-in and token refresh, the model list, translating
   OpenAI Chat Completions to the Responses API and back, streaming. **No skills, no MCP, no tool
   execution** in the gateway: tools are executed by FlowPilot, which checks the asking person's
   rights at the moment of the call (ADR-018). Passing a client's own tool definitions through
   (function calling) is fine later; executing tools is not.
2. **The official way only.** OpenAI's Sign in with ChatGPT lets a user spend their ChatGPT plan
   (Plus, Pro; possibly Go) in apps; plan usage is available to "open-source projects, personal
   projects that run locally, and selected private apps"
   ([cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt),
   [DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit)). **Never** reuse another app's
   OAuth client (the Codex CLI trick of ChatMock and similar proxies): that is a ToS grey zone with
   a risk of losing the account.
3. **One user, the home network.** It serves the owner's own household on the LAN: never expose it
   to the internet, never share the plan with other people. Clients authenticate with an API key
   the app generates (`Authorization: Bearer …`).
4. **A Home Assistant app**, not an integration: it needs its own HTTP server and port with its own
   key (an integration could only serve through Home Assistant with a Home Assistant token), and a
   sign-in page, which opens in the sidebar through Ingress. It does not depend on FlowPilot.
5. **Node + our own implementation of the documented protocol** (TypeScript), not the DevKit.
   Decided after the spike: `@siwc/local` is not published to npm and is under OpenAI's
   *noncommercial* DevKit license (it would not be Apache-2.0 inside our image), it requires an
   OS-backed token encryption a container does not have, and its `streamResponse` cannot set
   `reasoning` or tools, so model calls go to the Responses API directly anyway. Write the sign-in
   from OpenAI's [docs](https://developers.openai.com/siwc/token-sharing-open-source) (OAuth 2.0 +
   PKCE + OIDC, dynamic client registration, refresh token rotation); **do not copy DevKit code**.
   The DevKit stays a reference to compare behaviour against.

## The spike (do this first, on the owner's Mac)

Questions to answer, with evidence, before building the app:

1. **Sign-in from another machine.** The DevKit runtime listens on `127.0.0.1` and redirects the
   browser there after sign-in; no device-code or manual flow is documented. The app runs on the
   Pi, the browser is on a laptop. Planned workaround: the browser lands on
   `http://127.0.0.1:<port>/callback?code=…&state=…` (the page fails to load, that is expected),
   the owner pastes that address into the app's page, and the app replays it to its own listener
   inside the container (an HTTP GET to `127.0.0.1:<port>/callback?...`), so the DevKit completes
   as usual. Verify it works.
2. **Streaming.** The cookbook's `streamResponse` returns after `response.completed`. Voice needs
   deltas as they come (FlowPilot speaks while the model writes). Find out whether the DevKit
   exposes deltas (callbacks, an async iterator); if not, call the Responses API directly with the
   profile's access token (find how: URL, headers) and stream its SSE events.
3. **Models and limits.** What `listModels()` returns for the owner's plan, what the slugs look
   like, and what errors look like when a limit is hit.
4. **Latency.** Time to first token for a short spoken-style question (e.g. "Сколько будет 2+2?
   Ответь одним словом."), several runs, compared with the plain OpenAI API if a key is at hand.
5. **Token lifetime.** How long the access token lives, that refresh works unattended (the app
   runs for weeks), and what happens when the refresh token is revoked.
6. **Terms.** Re-read OpenAI's terms and the SIWC docs: confirm a single user's LAN use fits
   "personal projects that run locally". If it does not, stop and tell the owner.

The owner signs in interactively with their own ChatGPT account: prepare everything up to "open
this link and sign in", then ask. Never print, log or commit tokens; keep spike credentials
outside the repository (e.g. `~/.config/chatgpt-gateway-spike/`). Write the findings to the Notion
page and summarize them for the owner before building.

## The app (after the spike)

- **API** (OpenAI-compatible, what FlowPilot's `llm.agent` already speaks):
  - `GET /v1/models` → `{"data": [{"id": "<slug>", "object": "model", ...}]}`
  - `POST /v1/chat/completions` with `messages` (system, user, assistant), `model`, `stream`,
    optional `temperature`, `max_tokens`; streamed as SSE `data: {"choices": [{"delta":
    {"content": "..."}}]}` lines and `data: [DONE]`; errors as `{"error": {"message": ...}}` with
    a proper status. Translate to and from the Responses API (`instructions` + `input`).
  - Later, if needed: function calling pass-through (definitions in, tool-call deltas out) for
    Home Assistant LLM integrations.
- **Auth:** an API key generated on first start, shown (and regenerable) on the app's page; the
  app's own data folder keeps the profile and tokens (`/data`, mode 600). Decided: the ChatGPT
  sign-in (`/data/chatgpt/`) is excluded from Home Assistant backups (`backup_exclude`); after a
  restore the owner signs in again. The API key (`/data/api_key`) stays in backups.
- **Page (Ingress):** sign-in status, the paste field for the sign-in step, the model list, the
  API address and key for clients, usage/limit errors. English and Russian.
- **Packaging like FlowPilot:** a prebuilt multi-arch image (amd64 + arm64) on
  `ghcr.io/darkdarin/ha-chatgpt-gateway`, `repository.yaml` at the repository root, the app in
  its own folder, `release.yml` building on native runners and creating the GitHub release from
  the changelog. Discovery for clients is not needed at first.
- **FlowPilot side** needs nothing new: the LLM agent node takes the gateway's address
  (`http://d9eec4fe-chatgpt-gateway:8780/v1` from another app; `d9eec4fe` is the Supervisor's
  hash of the repository URL), the key as a FlowPilot secret, and lists the models itself.
- **Ports:** the API on 8780 (mapped by the user for LAN clients, `null` by default); the page on
  the Ingress port 8099, trusting only the Supervisor (`172.30.32.2`); the sign-in callback
  listener on `127.0.0.1` inside the container.

## Environment and checks

- Node 26 (LTS) runs the TypeScript sources directly (type stripping, erasable syntax only, no
  build step); `tsc` only type checks, Biome lints and formats, tests use `node:test`. Keep
  dependencies few and pinned (lockfile). Tests run without a network and without a ChatGPT
  account (a fake Responses API, as FlowPilot's tests fake OpenAI and Soniox).
- The owner's Mac has Node 22 system-wide; do not change it. Node 26 for this project is in
  `~/.cache/chatgpt-gateway-dev/node-v26.13.0-darwin-arm64/bin`: prefix commands with
  `PATH="$HOME/.cache/chatgpt-gateway-dev/node-v26.13.0-darwin-arm64/bin:$PATH"` (download it
  again from nodejs.org if missing). `npm run check` runs lint, type check and tests.
- Brand images: `uv run --no-project --with pillow python -I scripts/brand.py --font <Onest TTF>`
  (the font is in `~/.cache/chatgpt-gateway-dev/Onest.ttf`, not committed).
- CI must stay fast (a few minutes): no slow system package installs (the GitHub apt mirror stalls
  for minutes; FlowPilot and Telegram Assist were bitten by `apt install ffmpeg`). Lint, type
  check, tests; the app linter (`frenck/action-addon-linter`) like FlowPilot.
- A local Home Assistant for development is in `~/Projects/ha-dev` (see its README): HA 2026.10.4
  on port 8123 and 2026.11.0 on 8124, with the owner's dev setup; FlowPilot's local runtime runs on
  8765. Use them, not the live Pi.

## Repository

- GitHub: `darkdarin/ha-chatgpt-gateway`, public (created with the owner's consent, 2026-11-07).
  Push over SSH (`git@github.com:darkdarin/ha-chatgpt-gateway.git`). Upload
  `assets/brand/social-preview.png` by hand (Settings → General → Social preview).
- The global `gh` account is a work account; do not run `gh auth switch`. Use the personal one per
  command: `GH_TOKEN="$(gh auth token --user darkdarin)" gh ...`; never print the token.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`); the git author is configured
  locally in this repository. No AI attribution lines in commits or PRs.
- License: Apache-2.0.

## Rules

- Never commit or print secrets, tokens, API keys or account data; never read `.env`/`.envrc`
  files with secrets in sibling repositories.
- Do not mark a feature done without a real end-to-end test (here: a streamed answer to
  FlowPilot's LLM agent through the gateway with the owner's plan).
- Record decisions with their trade-offs in Notion; keep the page's status and roadmap current
  (see "Working with Notion").
