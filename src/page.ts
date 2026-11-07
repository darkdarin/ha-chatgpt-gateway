// The app page: one self-contained HTML document (no external requests), in English and Russian.
// It talks to ui.ts with relative URLs, so it works under the Ingress path prefix.

const MARK = `<svg viewBox="15 150 955.5 780" width="40" height="33" aria-hidden="true"><g stroke-width="70" stroke-linecap="round"><path d="M100 660 L500 660" stroke="#9C7BF0"/><path d="M500 660 L860 660" stroke="#E9A23B"/></g><path d="M300 880 L300 400 A200 200 0 0 1 700 400 L700 880" fill="none" stroke="#2BB8A6" stroke-width="100" stroke-linecap="round"/><circle cx="100" cy="660" r="85" fill="#9C7BF0"/><path d="M860 549.5 L970.5 660 L860 770.5 L749.5 660 Z" fill="#E9A23B"/></svg>`;

const TEXTS = {
  en: {
    status: {
      signed_out: "Not signed in",
      signing_in: "Signing in",
      signed_in: "Signed in",
      reauth_required: "Sign in again",
    },
    signedInAs: "Signed in as {who}.",
    signedIn: "Signed in to ChatGPT.",
    notSignedIn: "Sign in with your ChatGPT plan (Plus or Pro) to let clients use its models.",
    reauth: "The sign-in expired or was revoked. Sign in again; clients keep their key.",
    sharingOff:
      "The app may not use your ChatGPT plan: sign in again and allow it on OpenAI's page.",
    signIn: "Sign in with ChatGPT",
    step1:
      "Open OpenAI's sign-in page, sign in with your ChatGPT account and allow the app to use your plan.",
    openLink: "Open the sign-in page",
    step2:
      "Afterwards the browser tries to open an address starting with http://127.0.0.1 and shows an error. That is expected: copy that address from the address bar.",
    step3: "Paste it here and finish:",
    placeholder: "http://127.0.0.1:…/auth/callback?code=…",
    finish: "Finish sign-in",
    cancel: "Cancel",
    signOut: "Sign out",
    confirmSignOut: "Sign out and revoke the app's access to your ChatGPT account?",
    clients: "Clients",
    clientsHint: "Any OpenAI API client works: set its base URL and API key.",
    fromApps: "From other apps (FlowPilot)",
    fromNetwork: "From your network",
    networkHint:
      "Set a host port for 8780/tcp on the app's Network tab, then use http://<Home Assistant address>:<port>/v1. Never forward it to the internet.",
    apiKey: "API key",
    show: "Show",
    hide: "Hide",
    copy: "Copy",
    copied: "Copied",
    regenerate: "New key",
    confirmRegenerate:
      "Generate a new key? Clients using the current one stop working until they get the new one.",
    models: "Models of your plan",
    modelsError: "Could not load the models: {error}",
    limitTitle: "Usage limit reached",
    limitText:
      "Requests fail until the limit resets. Check your plan's usage and the app's own limit in ChatGPT settings.",
    usageLink: "ChatGPT usage settings",
    problem: "Last problem",
    at: "at {time}",
    error: "Error",
  },
  ru: {
    status: {
      signed_out: "Вход не выполнен",
      signing_in: "Вход",
      signed_in: "Вход выполнен",
      reauth_required: "Войдите снова",
    },
    signedInAs: "Вход выполнен: {who}.",
    signedIn: "Вход в ChatGPT выполнен.",
    notSignedIn:
      "Войдите с подпиской ChatGPT (Plus или Pro), чтобы клиенты могли пользоваться её моделями.",
    reauth: "Вход истёк или был отозван. Войдите снова; ключ у клиентов останется прежним.",
    sharingOff:
      "Приложению не разрешено использовать подписку ChatGPT: войдите снова и разрешите это на странице OpenAI.",
    signIn: "Войти через ChatGPT",
    step1:
      "Откройте страницу входа OpenAI, войдите своим аккаунтом ChatGPT и разрешите приложению использовать подписку.",
    openLink: "Открыть страницу входа",
    step2:
      "После входа браузер попробует открыть адрес, начинающийся с http://127.0.0.1, и покажет ошибку. Так и должно быть: скопируйте этот адрес из адресной строки.",
    step3: "Вставьте его сюда и завершите вход:",
    placeholder: "http://127.0.0.1:…/auth/callback?code=…",
    finish: "Завершить вход",
    cancel: "Отмена",
    signOut: "Выйти",
    confirmSignOut: "Выйти и отозвать доступ приложения к аккаунту ChatGPT?",
    clients: "Клиенты",
    clientsHint: "Подойдёт любой клиент OpenAI API: укажите ему адрес и ключ.",
    fromApps: "Из других приложений (FlowPilot)",
    fromNetwork: "Из вашей сети",
    networkHint:
      "Задайте порт для 8780/tcp на вкладке «Сеть» приложения и используйте http://<адрес Home Assistant>:<порт>/v1. Никогда не открывайте его в интернет.",
    apiKey: "Ключ API",
    show: "Показать",
    hide: "Скрыть",
    copy: "Копировать",
    copied: "Скопировано",
    regenerate: "Новый ключ",
    confirmRegenerate:
      "Создать новый ключ? Клиенты с текущим ключом перестанут работать, пока не получат новый.",
    models: "Модели вашей подписки",
    modelsError: "Не удалось загрузить модели: {error}",
    limitTitle: "Лимит исчерпан",
    limitText:
      "Запросы не проходят, пока лимит не сбросится. Проверьте расход подписки и лимит приложения в настройках ChatGPT.",
    usageLink: "Настройки расхода ChatGPT",
    problem: "Последняя проблема",
    at: "в {time}",
    error: "Ошибка",
  },
};

const SCRIPT = `
const TEXTS = ${JSON.stringify(TEXTS)};
const T = TEXTS[(navigator.language || "en").toLowerCase().startsWith("ru") ? "ru" : "en"];
document.documentElement.lang = T === TEXTS.ru ? "ru" : "en";
const $ = (id) => document.getElementById(id);
const fill = (s, values) => s.replace(/\\{(\\w+)\\}/g, (_, k) => values[k] ?? "");
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
let state = null, showKey = false, busy = false, timer = null, typed = "";

async function call(path, body) {
  busy = true; render();
  try {
    const res = await fetch(path, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || res.statusText);
    return data;
  } finally { busy = false; }
}
async function act(path, body) {
  $("error").textContent = "";
  try {
    const data = await call(path, body);
    if (data.session) state = data;
    if (data.authUrl) await refresh();
  } catch (e) { $("error").textContent = T.error + ": " + e.message; }
  render();
}
async function refresh() {
  try { state = await call("api/state"); $("error").textContent = ""; }
  catch (e) { $("error").textContent = T.error + ": " + e.message; }
  render(); schedule();
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(refresh, state?.session.status === "signing_in" ? 3000 : 30000);
}
function copy(text, button) {
  navigator.clipboard?.writeText(text).then(() => {
    button.textContent = T.copied; setTimeout(() => { button.textContent = T.copy; }, 1500);
  });
}
function account(s) {
  const card = h("section", { class: "card" });
  const badge = h("span", { class: "badge " + s.status }, T.status[s.status]);
  card.append(h("div", { class: "row" }, h("h2", {}, "ChatGPT"), badge));
  if (s.status === "signed_in") {
    const who = s.email || s.name;
    card.append(h("p", {}, who ? fill(T.signedInAs, { who }) : T.signedIn));
    if (!s.sharing) card.append(h("p", { class: "warn" }, T.sharingOff));
    card.append(h("div", { class: "actions" },
      !s.sharing && h("button", { onclick: () => act("api/signin", {}), disabled: busy }, T.signIn),
      h("button", { class: "secondary", disabled: busy,
        onclick: () => confirm(T.confirmSignOut) && act("api/signout", {}) }, T.signOut)));
  } else if (s.status === "signing_in") {
    const input = h("input", { id: "address", type: "url", placeholder: T.placeholder, autocomplete: "off", spellcheck: "false",
      oninput: (e) => { typed = e.target.value; } });
    input.value = typed;
    card.append(h("ol", { class: "steps" },
      h("li", {}, T.step1, " ", h("a", { href: s.authUrl, target: "_blank", rel: "noreferrer noopener" }, T.openLink)),
      h("li", {}, T.step2),
      h("li", {}, T.step3, input)));
    card.append(h("div", { class: "actions" },
      h("button", { disabled: busy, onclick: () => act("api/callback", { address: typed }) }, T.finish),
      h("button", { class: "secondary", disabled: busy, onclick: () => act("api/cancel", {}) }, T.cancel)));
  } else {
    card.append(h("p", {}, s.status === "reauth_required" ? T.reauth : T.notSignedIn));
    card.append(h("div", { class: "actions" },
      h("button", { disabled: busy, onclick: () => act("api/signin", {}) }, T.signIn)));
  }
  return card;
}
function problem(p) {
  if (!p) return null;
  const time = new Date(p.at).toLocaleTimeString();
  if (p.code === "subscription_sharing_usage_limit_exceeded") {
    return h("section", { class: "card alert" }, h("h2", {}, T.limitTitle),
      h("p", {}, T.limitText, " ", h("a", { href: "https://chatgpt.com/settings/usage", target: "_blank", rel: "noreferrer noopener" }, T.usageLink)),
      h("p", { class: "muted" }, fill(T.at, { time })));
  }
  return h("section", { class: "card alert" }, h("h2", {}, T.problem),
    h("p", {}, p.message), h("p", { class: "muted" }, p.code + " · " + fill(T.at, { time })));
}
function clients(st) {
  const key = h("code", { class: "key" }, showKey ? st.apiKey : "•".repeat(24));
  const urlButton = (url) => { const b = h("button", { class: "small secondary", onclick: () => copy(url, b) }, T.copy); return b; };
  const keyCopy = h("button", { class: "small secondary", onclick: () => copy(st.apiKey, keyCopy) }, T.copy);
  return h("section", { class: "card" }, h("h2", {}, T.clients), h("p", { class: "muted" }, T.clientsHint),
    h("dl", {},
      h("dt", {}, T.fromApps), h("dd", {}, h("code", {}, st.internalUrl), urlButton(st.internalUrl)),
      h("dt", {}, T.fromNetwork), h("dd", { class: "muted" }, T.networkHint),
      h("dt", {}, T.apiKey), h("dd", {}, key,
        h("button", { class: "small secondary", onclick: () => { showKey = !showKey; render(); } }, showKey ? T.hide : T.show),
        keyCopy,
        h("button", { class: "small secondary", disabled: busy,
          onclick: () => confirm(T.confirmRegenerate) && act("api/key", {}) }, T.regenerate))));
}
function models(st) {
  if (st.session.status !== "signed_in") return null;
  const body = st.models ? h("ul", { class: "models" }, st.models.map((m) =>
    h("li", {}, h("code", {}, m.slug), m.displayName !== m.slug ? h("span", { class: "muted" }, " " + m.displayName) : null)))
    : h("p", { class: "warn" }, fill(T.modelsError, { error: st.modelsError || "" }));
  return h("section", { class: "card" }, h("h2", {}, T.models), body);
}
function render() {
  if (!state) return;
  const focused = document.activeElement?.id === "address";
  if (state.session.status !== "signing_in") typed = "";
  $("main").replaceChildren(...[account(state.session), problem(state.session.problem), models(state), clients(state)].filter(Boolean));
  if (focused && $("address")) $("address").focus();
  $("version").textContent = "ChatGPT Gateway " + state.version;
}
refresh();
`;

const STYLE = `
:root { color-scheme: light dark; --fg: #1D2330; --muted: #6B7484; --bg: #F4F5F7; --card: #FFFFFF;
  --line: #E1E4EA; --accent: #2BB8A6; --accent-fg: #FFFFFF; --warn: #B7791F; --alert: #FDF3E4; }
@media (prefers-color-scheme: dark) { :root { --fg: #E4E7EC; --muted: #8A93A3; --bg: #111418;
  --card: #1B1F26; --line: #2A303A; --warn: #E9A23B; --alert: #2A2418; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
header { display: flex; align-items: center; gap: 12px; max-width: 760px; margin: 24px auto 8px; padding: 0 16px; }
header h1 { font-size: 22px; margin: 0; font-weight: 600; }
main { max-width: 760px; margin: 0 auto; padding: 0 16px 24px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px 20px; margin: 12px 0; }
.card.alert { background: var(--alert); border-color: var(--warn); }
h2 { font-size: 17px; margin: 0 0 8px; font-weight: 600; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.badge { font-size: 13px; padding: 2px 10px; border-radius: 999px; background: var(--line); }
.badge.signed_in { background: var(--accent); color: var(--accent-fg); }
.badge.reauth_required { background: var(--warn); color: #fff; }
.muted { color: var(--muted); }
.warn { color: var(--warn); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
button { font: inherit; border: 0; border-radius: 8px; padding: 8px 16px; cursor: pointer; background: var(--accent); color: var(--accent-fg); }
button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--line); }
button.small { padding: 2px 10px; font-size: 13px; margin-left: 8px; }
button:disabled { opacity: .6; cursor: default; }
input { width: 100%; font: 14px ui-monospace, monospace; padding: 8px 10px; margin-top: 6px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
.steps { padding-left: 20px; margin: 8px 0 0; } .steps li { margin: 8px 0; }
a { color: var(--accent); }
code { font: 13px ui-monospace, monospace; background: var(--bg); padding: 2px 6px; border-radius: 6px; word-break: break-all; }
dl { margin: 8px 0 0; } dt { font-weight: 600; margin-top: 12px; } dd { margin: 4px 0 0; }
.models { list-style: none; padding: 0; margin: 0; columns: 2; } .models li { margin: 4px 0; }
#error { color: #D64545; max-width: 760px; margin: 0 auto; padding: 0 16px; }
footer { max-width: 760px; margin: 0 auto 24px; padding: 0 16px; font-size: 12px; color: var(--muted); }
`;

export function page(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChatGPT Gateway</title><style>${STYLE}</style></head>
<body><header>${MARK}<h1>ChatGPT Gateway</h1></header>
<p id="error" role="alert"></p><main id="main"></main><footer id="version"></footer>
<script>${SCRIPT}</script></body></html>`;
}
