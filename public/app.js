/* 捨てメール（仮）のクライアント。docs/02_ux_design.md ③④⑤ と docs/01_requirements.md FR-08〜FR-11 が正本。
   状態は idle / waiting / received / expired の4つだけで、render() が <main data-state> ごと描き直す。
   フレームワークは使わない。メール由来の文字列は必ず textContent で入れる（HTMLとして解釈させない）。 */

const STORAGE_KEY = "sutemail.v1";
const POLL_FAST_MS = 3000;
const POLL_SLOW_MS = 10000;
const POLL_SLOW_AFTER_MS = 120000;
const TOAST_MS = 4000;
// 報告欄を出すまでの待ち時間（FR-18・採点r1 P10）。届く前に訊くと材料が無く、誤報告を誘う
const REPORT_AFTER_MS = 60000;
// 残り時間を太字にする境界（採点r1 P12）
const REMAINING_SOON_MS = 60000;

const main = document.getElementById("app");
const announceRegion = document.getElementById("announce");
const toast = document.getElementById("toast");
const reportSection = document.getElementById("report");
const statsSection = document.getElementById("stats");

const state = {
  name: "loading",
  address: null, // {local, token, expiresAt, address}
  lastAddress: "", // 期限切れ画面に「どれが消えたか」を出すために覚えておく（採点r1 P19）
  messages: [],
  config: null,
  busy: false,
  error: "",
  flashMessageId: null,
  push: { subscribed: false, busy: false, note: "" },
};

// 描き直しでも保ちたい画面側の状態（折りたたみの開閉と、取得済みの本文）
const ui = { openDetails: new Set(), bodyTexts: new Map() };

// 報告欄は <main> の外にあり、入力中の文字を消さないために組み立ては1度だけ（更新は差分のみ）
const report = { nodes: null, reported: new Set(), message: "", statHost: "", stat: null, busy: false, statTicket: 0 };
const stats = { top: null, loading: false };
const turnstile = { requested: false, ready: false };

let lastSignature = "";
let seenMessageIds = new Set();
let pollTimer = null;
let pollStartedAt = 0;
let tickTimer = null;
let toastTimer = null;
let turnstileToken = "";
// 起動時点ですでに期限切れだったアドレスのローカル部（設定が届いてから画面に出す）
let expiredLocal = "";

/* ---- 小道具 --------------------------------------------------------- */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function formatRemaining(milliseconds) {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.min(99, Math.floor(total / 60));
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatTime(receivedAt) {
  try {
    return new Date(receivedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function ttlMinutes() {
  const seconds = state.config?.addressTtlSeconds;
  return typeof seconds === "number" && seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : 10;
}

/** 報告欄を出してよいか（採点r1 P10）。待受は発行から60秒たってから、受信は即。 */
function reportGateOpen(model) {
  if (model.name === "received") return true;
  if (model.name !== "waiting" || !model.address) return false;
  const ttlMs = (model.config?.addressTtlSeconds ?? 600) * 1000;
  // 再読み込みで戻ってきたときも「発行からの経過」で判定する（残り時間から逆算できる）
  const issuedAt = model.address.expiresAt - ttlMs;
  return Date.now() - issuedAt >= REPORT_AFTER_MS;
}

function visibleCodes(message) {
  // low（文脈のない数字）は既定で出さない。誤ったコードを大きく見せる方が害が大きい
  return (message?.codes ?? []).filter((code) => code.confidence === "high" || code.confidence === "medium");
}

/**
 * 貼り付けられた文字列からホスト名を取り出す。URL でも「example.com/signup」でもよい。
 * スキームが無ければ付けてから `new URL()` に通す。日本語ドメインもここで punycode になる。
 * `www.` は落とさない（利用者が見たままのホストを送る）。
 */
function hostFromInput(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(candidate).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** サーバー（POST /api/report）と同じ判定。押す前に弾いて 400 を見せない。 */
function isReportableHost(host) {
  if (!/^[a-z0-9.-]{1,253}$/.test(host)) return false;
  if (!host.includes(".") || host.includes("..")) return false;
  return !/^[.-]/.test(host) && !/[.-]$/.test(host);
}

/** VAPID 公開鍵（base64url の文字列）を applicationServerKey が要る形に直す。 */
function urlBase64ToUint8Array(base64Url) {
  const padded = base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** iOS はホーム画面に追加しないと通知を許可できない（FR-17）。 */
function isIosBrowser() {
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS は既定で Mac を名乗るので、タッチの有無で見分ける
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

function isStandalone() {
  return navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/* ---- localStorage（1端末1アドレス） ---------------------------------- */

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (typeof value?.local === "string" && typeof value?.token === "string" && typeof value?.expiresAt === "number") {
      const reported = Array.isArray(value.reported) ? value.reported.filter((host) => typeof host === "string") : [];
      return { local: value.local, token: value.token, expiresAt: value.expiresAt, reported };
    }
  } catch {
    // 壊れていたら無かったことにする
  }
  return null;
}

function saveStored(address) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        local: address.local,
        token: address.token,
        expiresAt: address.expiresAt,
        // 同じサイトを2度押したときに「記録済み」と言えるようにする（サーバーは二重報告も204を返す）
        reported: [...report.reported],
      }),
    );
  } catch {
    // プライベートモード等で書けなくても発行そのものは続けられる
  }
}

function clearStored() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 消せなくても実害はない
  }
}

/* ---- API ------------------------------------------------------------ */

async function apiGet(path) {
  const headers = new Headers();
  if (state.address?.token) headers.set("authorization", `Bearer ${state.address.token}`);
  return fetch(path, { headers, cache: "no-store" });
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) return;
    state.config = await response.json();
    // 起動時にすでに期限切れだった分は、ドメインが分かってからアドレスを組み立てる（採点r1 P19）
    if (!state.lastAddress && expiredLocal && state.config?.mailDomain) {
      state.lastAddress = `${expiredLocal}@${state.config.mailDomain}`;
    }
    if (state.config?.turnstileSiteKey) ensureTurnstile(state.config.turnstileSiteKey);
    render(state);
    if (state.config?.push === true) refreshPushState();
  } catch {
    // 設定が取れなくても既定値で動く
  }
}

async function issue() {
  if (state.busy) return;
  state.busy = true;
  state.error = "";
  render(state);
  try {
    const response = await fetch("/api/address", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(turnstileToken ? { turnstileToken } : {}),
    });
    if (response.status === 429) {
      const detail = await response.json().catch(() => ({}));
      const wait = Number(detail.retryAfter) || 60;
      state.error = `発行の上限に達しました。${Math.ceil(wait / 60)}分ほど待ってからもう一度お試しください。`;
      return;
    }
    if (response.status === 403) {
      // Turnstile の判定に通らなかった。使い終わったトークンは再利用できないので取り直す
      resetTurnstile();
      state.error = "自動発行の確認に通りませんでした。下の確認にチェックを入れて、もう一度お試しください。";
      return;
    }
    if (response.status === 503) {
      resetTurnstile();
      state.error = "確認の仕組みが応答しませんでした。少し待ってからもう一度お試しください。";
      return;
    }
    if (!response.ok) {
      state.error = "アドレスを発行できませんでした。少し待ってからもう一度お試しください。";
      return;
    }
    const data = await response.json();
    state.address = { local: data.local, token: data.token, expiresAt: data.expiresAt, address: data.address };
    state.messages = [];
    state.flashMessageId = null;
    seenMessageIds = new Set();
    ui.openDetails.clear();
    ui.bodyTexts.clear();
    resetReport();
    resetTurnstile();
    saveStored(state.address);
    state.name = "waiting";
    startPolling();
    refreshPushState();
  } catch {
    state.error = "通信できませんでした。電波の状態を確かめて、もう一度お試しください。";
  } finally {
    state.busy = false;
    render(state);
  }
}

async function refreshMessages({ announceArrival = true } = {}) {
  if (!state.address) return;
  try {
    const response = await apiGet(`/api/address/${state.address.local}/messages`);
    if (response.status === 410 || response.status === 404 || response.status === 401) {
      expire();
      return;
    }
    if (!response.ok) {
      state.error = "受信の確認に失敗しました。";
      render(state);
      return;
    }
    const data = await response.json();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const arrived = messages.filter((message) => !seenMessageIds.has(message.id));
    for (const message of messages) seenMessageIds.add(message.id);
    state.messages = messages;
    state.error = "";
    state.name = messages.length > 0 ? "received" : "waiting";
    if (arrived.length > 0 && announceArrival) {
      state.flashMessageId = messages[0].id;
      announceRegion.textContent = visibleCodes(messages[0]).length > 0
        ? "認証コードが届きました"
        : "メールが届きました";
    }
    render(state);
  } catch {
    // 直前の表示は残したまま「再試行」を出す（docs/02_ux_design.md ③ 分岐と復帰）
    state.error = "通信に失敗しました。";
    render(state);
  }
}

async function loadBodyText(message, target) {
  if (!state.address || ui.bodyTexts.has(message.id)) return;
  try {
    const response = await apiGet(
      `/api/address/${state.address.local}/messages/${encodeURIComponent(message.id)}`,
    );
    if (!response.ok) return;
    const data = await response.json();
    const text = typeof data.text === "string" ? data.text : "";
    ui.bodyTexts.set(message.id, text);
    if (target.isConnected) target.textContent = text || "（本文はありません）";
  } catch {
    // 取れなければプレビューのまま置く
  }
}

/* ---- 状態遷移 -------------------------------------------------------- */

function expire() {
  stopPolling();
  clearStored();
  // 何が消えたのかを期限切れ画面に残す（採点r1 P19）。復元中はアドレス文字列が空なので組み立てる
  state.lastAddress = state.address?.address
    || (state.address?.local && state.config?.mailDomain ? `${state.address.local}@${state.config.mailDomain}` : "");
  state.address = null;
  state.messages = [];
  state.flashMessageId = null;
  state.error = "";
  seenMessageIds = new Set();
  ui.openDetails.clear();
  ui.bodyTexts.clear();
  resetReport();
  state.push = { subscribed: false, busy: false, note: "" };
  state.name = "expired";
  render(state);
  loadTopStats();
}

/**
 * 「新しいアドレス」の入口。すぐ隣が「更新」なので、誤タップで届いたメールを消させない（採点r2 TOP5-⑤）。
 * 確認を出すのはここだけで、replaceAddress() 自体は確認を持たない（テストと再利用のため）。
 */
function confirmReplaceAddress() {
  if (!window.confirm("いまのアドレスと届いたメールを消して、新しいアドレスを発行します。よろしいですか？")) return;
  replaceAddress();
}

/**
 * いま持っているアドレスを捨てて、すぐ次を発行する（採点r1 P11）。
 * 貼り先を間違えた・迷惑メールが来たときの逃げ道。localStorage の1件はそのまま置き換わる。
 */
async function replaceAddress() {
  if (state.busy || !state.address) return;
  const { local, token } = state.address;
  stopPolling();
  // 先に手元の記録を消す。発行に失敗しても、消えたアドレスを掴んだままにしない
  clearStored();
  state.address = null;
  state.messages = [];
  state.flashMessageId = null;
  state.name = "idle";
  try {
    await fetch(`/api/address/${local}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    // 消せなくても10分で失効する。次の発行を止める理由にはしない
  }
  await issue();
}

function pollIntervalMs() {
  return Date.now() - pollStartedAt < POLL_SLOW_AFTER_MS ? POLL_FAST_MS : POLL_SLOW_MS;
}

function stopPolling() {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
}

function scheduleNextPoll(delay) {
  stopPolling();
  pollTimer = setTimeout(runPoll, delay);
}

function startPolling() {
  pollStartedAt = Date.now();
  scheduleNextPoll(0);
}

async function runPoll() {
  pollTimer = null;
  if (!state.address) return;
  if (Date.now() >= state.address.expiresAt) {
    expire();
    return;
  }
  if (document.visibilityState !== "visible") return; // 見えていない間は止める（FR-11）
  await refreshMessages();
  if (state.address) scheduleNextPoll(pollIntervalMs());
}

function tick() {
  if (!state.address) return;
  const remaining = state.address.expiresAt - Date.now();
  if (remaining <= 0) {
    expire();
    return;
  }
  const node = document.getElementById("remaining-value");
  if (node) node.textContent = formatRemaining(remaining);
  // 残り1分を切ったら太字にする（色は足さない。採点r1 P12）
  const row = document.getElementById("remaining");
  if (row) row.classList.toggle("remaining--soon", remaining < REMAINING_SOON_MS);
  // 待受のまま60秒たったら報告欄を出す（採点r1 P10）。1秒ごとの見張りはここに相乗りする
  if (reportSection.hidden && reportGateOpen(state)) updateAside(state);
}

function startTicker() {
  if (tickTimer === null) tickTimer = setInterval(tick, 1000);
}

/* ---- コピーとトースト ------------------------------------------------ */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // クリップボードAPIが無い・拒否された環境向けの逃げ道
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.append(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }
}

function showToast(message) {
  toast.hidden = false;
  toast.textContent = message;
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.textContent = "";
    toast.hidden = true;
    toastTimer = null;
  }, TOAST_MS);
}

async function copyAndTell(text) {
  const copied = await copyText(text);
  showToast(copied ? "コピーしました" : "コピーできませんでした。長押しで選択してください");
}

/* ---- Turnstile（FR-12。サイトキーが配られたときだけ動く） --------------- */

/* 既定（開発・テスト）ではサイトキーが無いので、api.js は1度も読み込まれない。
   明示レンダーにしているのは、状態が変わるたびに <main> ごと描き直すため。
   暗黙レンダーだと、読み込み後に現れたウィジェット枠が描かれないまま残る。 */
function ensureTurnstile(siteKey) {
  if (!siteKey || turnstile.requested) return;
  turnstile.requested = true;
  window.onTurnstileReady = () => {
    turnstile.ready = true;
    drawTurnstile();
  };
  document.head.append(
    el("script", {
      id: "turnstile-script",
      src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileReady",
      async: true,
      defer: true,
    }),
  );
}

function drawTurnstile() {
  const siteKey = state.config?.turnstileSiteKey;
  if (!turnstile.ready || !window.turnstile || !siteKey) return;
  const holder = document.getElementById("turnstile");
  if (!holder || holder.dataset.rendered === "true") return;
  holder.dataset.rendered = "true";
  window.turnstile.render(holder, {
    sitekey: siteKey,
    callback: (token) => {
      turnstileToken = token;
    },
    "expired-callback": () => {
      turnstileToken = "";
    },
    "error-callback": () => {
      turnstileToken = "";
    },
  });
}

/** トークンは1回しか使えない。発行に失敗したら取り直す。 */
function resetTurnstile() {
  turnstileToken = "";
  const holder = document.getElementById("turnstile");
  if (!holder || !window.turnstile) return;
  try {
    window.turnstile.reset(holder);
  } catch {
    // ウィジェットが未描画なら何もしなくてよい
  }
}

/* ---- 通知（FR-17） ---------------------------------------------------- */

/* サーバーが VAPID を持っていないと config.push は false になり、この節は丸ごと動かない。
   通知の中身にコードは載らない（サーバーが「届きました」しか送らない）。 */

async function currentPushSubscription() {
  if (!pushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

async function refreshPushState() {
  if (state.config?.push !== true) return;
  const subscription = await currentPushSubscription();
  state.push = { ...state.push, subscribed: Boolean(subscription) };
  render(state);
}

async function enablePush() {
  if (state.push.busy || !state.address) return;
  state.push = { ...state.push, busy: true, note: "" };
  render(state);
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      state.push.note = "ブラウザ側で通知が許可されていません。設定を確かめてからもう一度お試しください。";
      return;
    }
    const key = state.config?.vapidPublicKey;
    if (!key) {
      state.push.note = "いまは通知を使えません。";
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
    const response = await fetch(`/api/address/${state.address.local}/push`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${state.address.token}` },
      cache: "no-store",
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!response.ok) {
      await subscription.unsubscribe().catch(() => {});
      state.push.note = "通知を登録できませんでした。少し待ってからもう一度お試しください。";
      return;
    }
    state.push.subscribed = true;
    showToast("通知をオンにしました");
  } catch {
    state.push.note = "通知を登録できませんでした。少し待ってからもう一度お試しください。";
  } finally {
    state.push.busy = false;
    render(state);
  }
}

async function disablePush() {
  if (state.push.busy) return;
  state.push = { ...state.push, busy: true, note: "" };
  render(state);
  try {
    const subscription = await currentPushSubscription();
    if (subscription) await subscription.unsubscribe().catch(() => {});
    if (state.address) {
      await fetch(`/api/address/${state.address.local}/push`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${state.address.token}` },
        cache: "no-store",
      }).catch(() => {});
    }
    state.push.subscribed = false;
  } finally {
    state.push.busy = false;
    render(state);
  }
}

function pushBlock(model) {
  if (model.config?.push !== true) return null;
  // iOS はホーム画面に追加したときだけ通知を許可できる。ボタンを出しても必ず失敗する
  if (isIosBrowser() && !isStandalone()) {
    return el("p", { class: "hint", id: "push-ios-hint", text: "ホーム画面に追加すると通知が使えます。" });
  }
  if (!pushSupported()) return null;

  const children = [];
  if (model.push.subscribed) {
    children.push(el("p", { class: "push__state", id: "push-state", text: "通知はオン" }));
    children.push(
      el("button", {
        class: "btn",
        type: "button",
        id: "push-off",
        text: model.push.busy ? "解除しています…" : "オフにする",
        disabled: model.push.busy,
        onclick: disablePush,
      }),
    );
  } else {
    children.push(
      el("button", {
        class: "btn",
        type: "button",
        id: "push-on",
        text: model.push.busy ? "登録しています…" : "通知をオンにする",
        disabled: model.push.busy,
        onclick: enablePush,
      }),
    );
    children.push(
      el("p", {
        class: "hint",
        text: "画面を閉じていても、メールが届いたことをお知らせします。認証コードは通知に出しません。",
      }),
    );
  }
  if (model.push.note) children.push(el("p", { class: "notice", role: "alert", text: model.push.note }));
  return el("div", { class: "push" }, children);
}

/* ---- 報告と実績（FR-18） ---------------------------------------------- */

function resetReport() {
  report.reported = new Set();
  report.message = "";
  report.statHost = "";
  report.stat = null;
  report.busy = false;
  if (report.nodes) report.nodes.input.value = "";
}

function buildReport() {
  if (report.nodes) return report.nodes;
  const input = el("input", {
    class: "input",
    id: "report-host",
    type: "text",
    inputmode: "url",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: "example.com",
  });
  const stat = el("p", { class: "hint", id: "report-stat" });
  const message = el("p", { class: "report__message", id: "report-message", role: "status", "aria-live": "polite" });
  const ok = el("button", {
    class: "btn",
    type: "button",
    id: "report-ok",
    text: "届いた",
    onclick: () => sendReport("ok"),
  });
  const ng = el("button", {
    class: "btn",
    type: "button",
    id: "report-ng",
    text: "届かなかった",
    onclick: () => sendReport("ng"),
  });
  input.addEventListener("change", () => loadHostStat(hostFromInput(input.value)));

  reportSection.replaceChildren(
    el("h2", { class: "report__title", text: "このサイトで使えましたか" }),
    el("p", { class: "hint", text: "報告は集計だけに使います。ほかの人が事前に見分けられるようになります。" }),
    el("label", { class: "label", for: "report-host", text: "使ったサイト（任意）" }),
    input,
    stat,
    el("div", { class: "report__buttons" }, [ok, ng]),
    message,
  );
  report.nodes = { input, stat, message, ok, ng };
  return report.nodes;
}

async function loadHostStat(host) {
  // 入力中に何度も投げるので、いちばん新しい問い合わせだけを画面に反映する
  const ticket = (report.statTicket += 1);
  if (!host || !isReportableHost(host)) {
    report.statHost = "";
    report.stat = null;
    updateAside(state);
    return;
  }
  try {
    // 応答は60秒キャッシュされる。報告した直後に古い数字を出さないよう no-store で取る
    const response = await fetch(`/api/stats?host=${encodeURIComponent(host)}`, { cache: "no-store" });
    if (!response.ok || ticket !== report.statTicket) return;
    const data = await response.json();
    if (ticket !== report.statTicket) return;
    report.statHost = host;
    report.stat = { ok: Number(data.ok) || 0, ng: Number(data.ng) || 0 };
    updateAside(state);
  } catch {
    // 実績が出ないだけで報告そのものは続けられる
  }
}

async function sendReport(result) {
  if (report.busy || !state.address) return;
  const nodes = buildReport();
  const host = hostFromInput(nodes.input.value);
  if (!host || !isReportableHost(host)) {
    report.message = "使ったサイトを入れてから押してください（例: example.com）。";
    updateAside(state);
    return;
  }
  if (report.reported.has(host)) {
    report.message = "このサイトは記録済みです。";
    updateAside(state);
    return;
  }
  report.busy = true;
  updateAside(state);
  try {
    const response = await fetch("/api/report", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${state.address.token}` },
      cache: "no-store",
      body: JSON.stringify({ local: state.address.local, host, result }),
    });
    if (response.status === 401 || response.status === 404 || response.status === 410) {
      expire();
      return;
    }
    if (!response.ok) {
      report.message = "記録できませんでした。少し待ってからもう一度お試しください。";
      return;
    }
    report.reported.add(host);
    if (state.address) saveStored(state.address);
    report.message = "ありがとうございます。記録しました。";
    report.statHost = "";
    report.stat = null;
    await loadHostStat(host);
    stats.top = null; // 次に未発行・期限切れへ戻ったときに取り直す
  } catch {
    report.message = "記録できませんでした。通信の状態を確かめてください。";
  } finally {
    report.busy = false;
    updateAside(state);
  }
}

async function loadTopStats() {
  if (stats.loading || stats.top) return;
  stats.loading = true;
  try {
    const response = await fetch("/api/stats/top", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    stats.top = Array.isArray(data.stats) ? data.stats : [];
    updateAside(state);
  } catch {
    // 実績表は無くても本体は使える
  } finally {
    stats.loading = false;
  }
}

function statsTable(rows) {
  // 見出しは「そのサイトの性質」なので現在形。押すボタン（届いた／届かなかった）とは言い方を分ける
  const head = el("tr", {}, [
    el("th", { scope: "col", text: "サイト" }),
    el("th", { scope: "col", text: "届いた" }),
    el("th", { scope: "col", text: "届かない" }),
  ]);
  /* 480px以下は2段組にする（採点r1 P13）。そこでは列見出しが隠れて表のロールも失われるので、
     件数のラベルを各セルに置く（広い画面では CSS で隠し、列見出しに任せる）。 */
  const count = (label, value) =>
    el("td", {}, [el("span", { class: "stats__cell-label", text: `${label} ` }), document.createTextNode(`${value}件`)]);
  const body = rows.map((row) =>
    el("tr", {}, [
      el("th", { scope: "row", text: row.host }),
      count("届いた", row.ok),
      count("届かない", row.ng),
    ]),
  );
  return el("table", { class: "stats__table" }, [
    el("thead", {}, [head]),
    el("tbody", {}, body),
  ]);
}

/** <main> の外にある報告欄と実績表を、入力中の文字を消さずに更新する。 */
function updateAside(model) {
  // 届く前に「使えましたか」と訊かない。受信あり、または待受のまま60秒（採点r1 P10）
  const showReport = Boolean(model.address) && reportGateOpen(model);
  reportSection.hidden = !showReport;
  if (showReport) {
    const nodes = buildReport();
    nodes.ok.disabled = report.busy;
    nodes.ng.disabled = report.busy;
    nodes.message.textContent = report.message;
    nodes.stat.textContent = report.stat
      ? `${report.statHost} の実績: 届いた ${report.stat.ok}件／届かなかった ${report.stat.ng}件`
      : "";
  }

  const showStats = model.name === "idle" || model.name === "expired";
  statsSection.hidden = !showStats;
  if (!showStats) return;
  const rows = stats.top ?? [];
  statsSection.replaceChildren(
    el("h2", { class: "stats__title", text: "最近の実績" }),
    el("p", { class: "hint", text: "利用者からの報告を数えたものです。届くかどうかはサイト側の判断で変わります。" }),
    rows.length > 0
      ? statsTable(rows.slice(0, 10))
      : el("p", { class: "stats__empty", id: "stats-empty", text: "まだ実績がありません。" }),
  );
}

/* ---- 描画 ------------------------------------------------------------ */

function signature(model) {
  return JSON.stringify([
    model.name,
    model.address?.address ?? null,
    model.address?.expiresAt ?? null,
    model.lastAddress,
    model.busy,
    model.error,
    model.config?.turnstileSiteKey ?? null,
    model.config?.addressTtlSeconds ?? null,
    model.config?.push ?? null,
    model.push.subscribed,
    model.push.busy,
    model.push.note,
    model.messages.map((message) => message.id),
  ]);
}

function detailsBlock(key, summaryText, className, buildChildren) {
  const node = el("details", { class: className }, [el("summary", { text: summaryText })]);
  if (ui.openDetails.has(key)) node.open = true;
  node.append(...[].concat(buildChildren(node)).filter(Boolean));
  node.addEventListener("toggle", () => {
    if (node.open) ui.openDetails.add(key);
    else ui.openDetails.delete(key);
  });
  return node;
}

function noticeBlock(model) {
  if (!model.error) return null;
  const children = [el("span", { text: model.error })];
  if (model.address) {
    children.push(
      el("button", {
        class: "btn notice__retry",
        type: "button",
        text: "再試行",
        onclick: () => {
          state.error = "";
          render(state);
          scheduleNextPoll(0);
        },
      }),
    );
  }
  return el("p", { class: "notice", role: "alert" }, children);
}

/* ウィジェットを入れる枠だけを置く。中身は drawTurnstile() が明示レンダーで作る
   （data-callback は使わない。コールバックは render の引数で渡している）。 */
function turnstileBlock(model) {
  if (!model.config?.turnstileSiteKey) return null;
  return el("div", {
    class: "turnstile cf-turnstile",
    id: "turnstile",
    "data-sitekey": model.config.turnstileSiteKey,
  });
}

/**
 * アドレスカード。受信後はコピーを白抜きに降格する（採点r1 P1）。
 * 青の塗りボタンは各状態で1つだけ＝受信後は「コードをコピー」に譲る。
 * 高さは待受・受信で同じ（到着時に下がずれないため。採点r1 P9）。
 */
function addressCard(model, { hero, primary }) {
  return el("section", { class: "card", "aria-label": "使い捨てアドレス" }, [
    el("p", { class: "label", text: "あなたの使い捨てアドレス" }),
    el("p", {
      class: "address",
      id: "address",
      "data-hero": hero ? "true" : null,
    }, [document.createTextNode(model.address.address)]),
    el("button", {
      class: primary ? "btn btn--primary" : "btn",
      type: "button",
      id: "copy-address",
      text: "コピー",
      onclick: () => copyAndTell(model.address.address),
    }),
  ]);
}

/**
 * 残り時間の行。右端に「更新」と「新しいアドレス」を控えめなテキストボタンで置く（採点r1 P11）。
 * 待受・受信のどちらでも同じ形で出す（下がずれないため）。
 *
 * 2つは役割が正反対（片方はその場の再取得、もう片方はいまのアドレスの破棄）なのに、
 * 同じ青・同じ大きさで8px隣に並んでいた（採点r2 TOP5-⑤）。見た目で分け、間隔を16px以上あけ、
 * 破棄のほうは押しても1段確認をはさむ。
 */
function remainingBlock(model) {
  return el("div", { class: "remaining", id: "remaining", "aria-live": "off" }, [
    // 390px で行を折り返させない長さにする（折り返すとコードが上端160pxに入らない。採点r1 P2）
    el("p", { class: "remaining__text" }, [
      document.createTextNode("あと "),
      el("span", {
        class: "remaining__value",
        id: "remaining-value",
        text: formatRemaining(model.address.expiresAt - Date.now()),
      }),
      document.createTextNode(" で消えます"),
    ]),
    el("div", { class: "remaining__actions" }, [
      el("button", {
        class: "linkbtn",
        type: "button",
        id: "poll-now",
        disabled: model.busy,
        onclick: () => {
          if (state.address) scheduleNextPoll(0);
        },
      }, [
        // 記号はこちら（安全なほう）にだけ付ける。読み上げには出さない
        el("span", { class: "linkbtn__mark", "aria-hidden": "true", text: "↻" }),
        document.createTextNode("更新"),
      ]),
      el("button", {
        // 破棄する側は青を持たせない（--muted）。記号も付けない
        class: "linkbtn linkbtn--quiet",
        type: "button",
        id: "new-address",
        text: "新しいアドレス",
        disabled: model.busy,
        onclick: confirmReplaceAddress,
      }),
    ]),
  ]);
}

function linkBlock(link, primary) {
  return el("div", { class: "link" }, [
    el("p", { class: "label", text: "メールの中のリンク" }),
    link.label ? el("p", { class: "link__label", text: link.label }) : null,
    el("p", { class: "link__host", text: link.host }),
    el("a", {
      // コードがあるときは「コードをコピー」が主行動。リンクは白抜きに降ろす（採点r1 P1）
      class: primary ? "btn btn--primary" : "btn",
      href: link.url,
      target: "_blank",
      rel: "noopener noreferrer",
      text: "開く",
    }),
    detailsBlock(`url:${link.url}`, "URL全体を表示", "link__details", () => [
      el("p", { class: "link__url", text: link.url }),
    ]),
  ]);
}

/**
 * 認証コードカード。並びは「コード → 送信元・件名・受信の3行 → コードをコピー」（採点r1 P2・P5）。
 * 送信元は「そのサイトからのメールか」を確かめる材料なので、押す前に読める位置に置く。
 * 1024px以上では CSS のグリッド領域で「左＝コード／右＝メタ」の2カラムになる（採点r1 P3）。
 */
function latestMessageCard(model) {
  const message = model.messages[0];
  const codes = visibleCodes(message);
  const arrived = message.id === model.flashMessageId;
  const children = [];

  let labelText = "認証コードは見つかりませんでした";
  if (codes.length === 1) labelText = "認証コード";
  else if (codes.length > 1) labelText = "認証コードの候補です。どちらかを使ってください";
  const labelChildren = [document.createTextNode(labelText)];
  // 到着の合図。動きを止めている環境ではこのラベルだけが手がかりになる（採点r1 P4・P23）
  if (arrived) labelChildren.push(el("span", { class: "badge", id: "arrived-badge", text: "新着" }));
  children.push(el("p", { class: "label" }, labelChildren));

  if (codes.length === 1) {
    children.push(el("p", { class: "code", "data-hero": "true", text: codes[0].value }));
  } else if (codes.length > 1) {
    children.push(
      el("div", { class: "code-choices" }, codes.map((code, index) =>
        el("div", { class: "code-choice" }, [
          el("p", { class: "code", "data-hero": index === 0 ? "true" : null, text: code.value }),
          el("button", {
            class: "btn btn--primary",
            type: "button",
            text: "このコードをコピー",
            onclick: () => copyAndTell(code.value),
          }),
        ]),
      )),
    );
  } else {
    children.push(el("p", { class: "hint", text: "下の「本文を表示」で中身を確かめてください。" }));
  }

  children.push(
    el("dl", { class: "meta" }, [
      el("dt", { text: "送信元" }),
      el("dd", { text: message.from || "（不明）" }),
      el("dt", { text: "件名" }),
      el("dd", { text: message.subject || "（件名なし）" }),
      el("dt", { text: "受信" }),
      el("dd", { text: formatTime(message.receivedAt) }),
    ]),
  );

  if (codes.length === 1) {
    children.push(
      el("div", { class: "card__actions" }, [
        el("button", {
          class: "btn btn--primary",
          type: "button",
          id: "copy-code",
          text: "コードをコピー",
          onclick: () => copyAndTell(codes[0].value),
        }),
      ]),
    );
  }

  // コードがあるならリンクは副次。無いなら「開く」が主行動になる（青の塗りは常に1つ）
  if (message.links?.length) children.push(linkBlock(message.links[0], codes.length === 0));

  return el("section", {
    class: arrived ? "card card--code card--arrived" : "card card--code",
    id: "latest-message",
    "aria-label": "最新のメール",
  }, children);
}

/**
 * コードの居場所（採点r1 P8・P9）。待受のあいだも同じ場所に同じ大きさの枠を置き、
 * 到着したらこの中身だけを差し替える。下にある報告欄・実績・フッターは1pxも動かさない。
 * 高さは app.css の --slot-h（＋受信後にだけ増える「本文を表示」ぶんの --extras-h）で予約する。
 */
function codeSlot(model) {
  if (model.name === "received" && model.messages.length > 0) {
    return el("div", { class: "slot slot--filled", id: "code-slot" }, [latestMessageCard(model)]);
  }
  return el("div", { class: "slot slot--waiting", id: "code-slot" }, [
    el("p", { class: "status-line", text: "メールが届くのを待っています…" }),
    el("div", { class: "slot__frame" }, [
      el("p", { class: "slot__title", text: "認証コードはここに大きく出ます" }),
      el("p", { class: "slot__note" }, [
        // 「3秒ごと」と言い切ると、KV のキャッシュぶんの遅れ（最大30秒）が故障に見える（レビュー r2 N-2）
        document.createTextNode("数秒ごとに確認しています"),
        el("span", { class: "slot__pulse", "aria-hidden": "true", text: "…" }),
      ]),
      el("p", {
        class: "slot__note slot__note--weak",
        text: "届いてから表示まで最長1分かかることがあります",
      }),
    ]),
  ]);
}

/**
 * アドレスカードの下に来る、受信後にだけ増える部分（過去分・本文を表示）。
 * 待受のあいだも同じ id の空箱を置き、CSS の --extras-h で高さを先に取っておく。
 * 置かないと、到着したときにこの箱のぶんだけ報告欄・実績・フッターが下がる（採点r1 P9）。
 */
function extrasBlock(model) {
  if (model.name !== "received") return el("div", { class: "extras extras--empty", id: "msg-extras" });
  return el("div", { class: "extras", id: "msg-extras" }, [pastMessagesBlock(model), bodyBlock(model)].filter(Boolean));
}

function pastMessagesBlock(model) {
  const past = model.messages.slice(1);
  if (past.length === 0) return null;
  return detailsBlock(
    "past",
    `前に届いたメール（${past.length}件）`,
    "past",
    () => past.map((message) => {
      const codes = visibleCodes(message);
      return el("div", { class: "past-item" }, [
        codes.length > 0 ? el("p", { class: "past-item__code", text: codes[0].value }) : null,
        codes.length > 0
          ? el("button", {
              class: "btn",
              type: "button",
              text: "このコードをコピー",
              onclick: () => copyAndTell(codes[0].value),
            })
          : null,
        el("dl", { class: "meta" }, [
          el("dt", { text: "送信元" }),
          el("dd", { text: message.from || "（不明）" }),
          el("dt", { text: "件名" }),
          el("dd", { text: message.subject || "（件名なし）" }),
          el("dt", { text: "受信" }),
          el("dd", { text: formatTime(message.receivedAt) }),
        ]),
      ]);
    }),
  );
}

function bodyBlock(model) {
  const message = model.messages[0];
  if (!message) return null;
  return detailsBlock("body", "本文を表示", "body", (node) => {
    const pre = el("pre", {
      class: "body__text",
      id: "body-text",
      text: ui.bodyTexts.get(message.id) ?? message.textPreview ?? "",
    });
    // 全文はここで初めて取りに行く（開くまで取得しない）
    if (node.open) loadBodyText(message, pre);
    node.addEventListener("toggle", () => {
      if (node.open) loadBodyText(message, pre);
    });
    return [pre];
  });
}

function viewFor(model) {
  if (model.name === "idle") {
    return [
      // ファーストビューは押す先だけで足りる。説明は1行に絞る（採点r1 P16）
      el("p", { class: "lede", text: "本物のアドレスを渡さずに、認証コードだけ受け取れます。" }),
      noticeBlock(model),
      el("button", {
        class: "btn btn--primary btn--hero",
        type: "button",
        id: "issue",
        "data-hero": "true",
        text: model.busy ? "発行しています…" : "使い捨てアドレスを発行",
        disabled: model.busy,
        onclick: issue,
      }),
      turnstileBlock(model),
      el("p", {
        class: "hint",
        text: `登録もログインも要りません。発行したアドレスは${ttlMinutes()}分で自動的に消えます。`,
      }),
    ];
  }

  if (model.name === "expired") {
    return [
      el("h2", { class: "headline", text: "アドレスの期限が切れました" }),
      // どれが消えたのかを見せる（採点r1 P19）。コピーはできないが、選んで読むことはできる
      model.lastAddress
        ? el("p", { class: "address address--gone", id: "expired-address", "aria-label": "期限が切れたアドレス" }, [
            document.createTextNode(model.lastAddress),
          ])
        : null,
      el("p", { class: "lede", text: "届いていたメールも一緒に消えました。続けるときは新しいアドレスを発行してください。" }),
      noticeBlock(model),
      el("button", {
        class: "btn btn--primary btn--hero",
        type: "button",
        id: "reissue",
        "data-hero": "true",
        text: model.busy ? "発行しています…" : "新しいアドレスを発行",
        disabled: model.busy,
        onclick: issue,
      }),
      turnstileBlock(model),
    ];
  }

  if ((model.name === "waiting" || model.name === "received") && model.address) {
    const hasCode = model.name === "received" && visibleCodes(model.messages[0]).length > 0;
    /* 待受と受信は「同じ部品・同じ並び・同じ高さ」で描く（docs/02_ux_design.md ④）。
       到着で入れ替わるのは #code-slot の中身（点線枠 → 認証コードカード）だけで、
       残り時間・アドレスカード・報告欄から下は1pxも動かない（採点r2 TOP5-③）。

       並びは「残り時間 → 枠 → アドレス」。DOM の順＝画面の順＝読み上げの順にする
       （CSS の order で見た目だけ入れ替えると、読み上げと Tab が画面と食い違う）。
       この結果 Tab の1回目は「更新」に入る＝採点r2 R3 は満たせない。設計書 ④ の並びを優先した。 */
    const notice = noticeBlock(model);
    const remaining = remainingBlock(model);
    const slot = codeSlot(model);
    const address = addressCard(model, { hero: !hasCode, primary: model.name !== "received" });
    const push = pushBlock(model);
    return [notice, remaining, slot, address, extrasBlock(model), push].filter(Boolean);
  }

  return [el("p", { class: "lede", text: "読み込んでいます…" })];
}

function render(model) {
  // 報告欄と実績表は <main> の外にあり、描き直しの対象ではない（入力中の文字を消さない）
  updateAside(model);
  const next = signature(model);
  if (next === lastSignature) return;
  lastSignature = next;
  main.dataset.state = model.name;
  if (model.name === "loading") main.setAttribute("aria-busy", "true");
  else main.removeAttribute("aria-busy");
  // viewFor は「その状態では出さない部品」を null で返すので、ここで落とす
  main.replaceChildren(...viewFor(model).filter(Boolean));
  drawTurnstile(); // 枠を描き直したので、ウィジェットも入れ直す（サイトキーがある時だけ動く）
}

/* ---- 起動 ------------------------------------------------------------ */

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // 対応していない・権限が無い環境では黙って諦める（本体の機能には影響しない）
    });
  });
}

async function restore(stored) {
  state.address = { local: stored.local, token: stored.token, expiresAt: stored.expiresAt, address: "" };
  report.reported = new Set(stored.reported ?? []);
  try {
    const response = await apiGet(`/api/address/${stored.local}`);
    if (!response.ok) {
      expire();
      return;
    }
    const data = await response.json();
    state.address = {
      local: stored.local,
      token: stored.token,
      expiresAt: data.expiresAt ?? stored.expiresAt,
      address: data.address,
    };
    saveStored(state.address);
    state.name = "waiting";
    render(state);
    await refreshMessages({ announceArrival: false });
    startPolling();
    refreshPushState();
  } catch {
    // 通信できないだけかもしれないので、期限切れにはせず再試行を出す
    state.error = "通信に失敗しました。";
    state.name = "waiting";
    render(state);
  }
}

async function boot() {
  registerServiceWorker();
  startTicker();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (state.address) scheduleNextPoll(0);
    } else {
      stopPolling();
    }
  });

  loadConfig(); // 設定が届いたら signature が変わって描き直される。ここでは待たない

  const stored = loadStored();
  if (!stored) {
    state.name = "idle";
    render(state);
    loadTopStats();
    return;
  }
  if (stored.expiresAt <= Date.now()) {
    clearStored();
    expiredLocal = stored.local;
    if (state.config?.mailDomain) state.lastAddress = `${expiredLocal}@${state.config.mailDomain}`;
    state.name = "expired";
    render(state);
    loadTopStats();
    return;
  }
  await restore(stored);
}

boot();
