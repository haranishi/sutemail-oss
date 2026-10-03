import { generateLocalPart, generateToken, hashToken, isValidLocalPart, timingSafeEqualHex } from "../lib/address";
import { getAddressTtlSeconds, getIssueLimitPerHour, isTurnstileEnabled } from "../lib/env";
import { getVapidKeys, parsePushSubscription } from "../lib/push";
import { hashIp, checkAndCount } from "../lib/ratelimit";
import {
  bumpStat,
  deleteAddress,
  deleteAllMessages,
  getAddress,
  getMessage,
  getStat,
  listMessages,
  listStats,
  markHostReported,
  POLL_CACHE_TTL,
  putAddress,
  setPushSubscription,
  type AddressRecord,
} from "../lib/store";
import type { Env } from "../types";
import { handleIncoming } from "./email";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const STATS_CACHE_CONTROL = "public, max-age=60";
const TOP_STATS_LIMIT = 10;

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extraHeaders },
  });
}

function noContent(): Response {
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

/** 小さな JSON だけを受ける。壊れていれば null（呼び出し側が 400 を返す）。 */
async function readJsonBody(request: Request, maxBytes = 8192): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function authenticate(
  request: Request,
  env: Env,
  local: string,
): Promise<{ record: AddressRecord } | Response> {
  if (!isValidLocalPart(local)) return json({ error: "Not found" }, 404);
  const record = await getAddress(env.INBOX, local);
  if (!record) return json({ error: "Not found" }, 404);
  if (record.expiresAt <= Date.now()) {
    await Promise.all([deleteAddress(env.INBOX, local), deleteAllMessages(env.INBOX, local)]);
    return json({ error: "Address expired" }, 410);
  }
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return json({ error: "Unauthorized" }, 401);
  const suppliedHash = await hashToken(match[1]);
  if (!timingSafeEqualHex(suppliedHash, record.tokenHash)) return json({ error: "Unauthorized" }, 401);
  return { record };
}

type TurnstileOutcome = "skipped" | "passed" | "failed" | "unavailable";

async function verifyTurnstile(request: Request, env: Env, ip: string): Promise<TurnstileOutcome> {
  if (!isTurnstileEnabled(env)) return "skipped";
  // 本文はサイズ上限つきで読む（M-3）。clone を素の json() で読むと上限なしに読み込める
  const body = (await readJsonBody(request.clone())) as { turnstileToken?: unknown } | null;
  const token = typeof body?.turnstileToken === "string" ? body.turnstileToken : "";
  // トークンが無いのは検証の失敗。siteverify を呼ばずに落とす（総当たりで外部へ投げない）
  if (!token) return "failed";

  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY as string);
  form.set("response", token);
  form.set("remoteip", ip);
  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: form });
    if (!response.ok) return "unavailable";
    const result = (await response.json()) as { success?: boolean };
    return result.success === true ? "passed" : "failed";
  } catch {
    // 検証できない以上は発行を通さない。利用者の落ち度ではないので 503 で返す
    return "unavailable";
  }
}

async function issueAddress(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip") ?? "127.0.0.1";

  // Turnstile を先に見る。落ちた分でレート制限の持ち回数を減らさないため
  const turnstile = await verifyTurnstile(request, env, ip);
  if (turnstile === "failed") return json({ error: "Turnstile verification failed" }, 403);
  if (turnstile === "unavailable") {
    return json({ error: "Turnstile verification unavailable" }, 503, { "Retry-After": "5" });
  }

  const ipHash = await hashIp(ip, env.IP_HASH_SECRET);
  const limited = await checkAndCount(env.INBOX, ipHash, getIssueLimitPerHour(env), Date.now());
  if (!limited.ok) {
    return json({ error: "Rate limit exceeded", retryAfter: limited.retryAfter }, 429, {
      "Retry-After": String(limited.retryAfter),
    });
  }

  // 衝突したら引き直す。引き直しきれないときに使い回すと、前の持ち主の本文が新しい token で読めてしまう（M-2）
  let local = "";
  for (let attempt = 0; attempt < 5 && !local; attempt += 1) {
    const candidate = generateLocalPart();
    if (!(await getAddress(env.INBOX, candidate))) local = candidate;
  }
  if (!local) return json({ error: "Address space busy" }, 503, { "Retry-After": "1" });
  const token = generateToken();
  const now = Date.now();
  const ttl = getAddressTtlSeconds(env);
  const expiresAt = now + ttl * 1000;
  await putAddress(env.INBOX, local, { tokenHash: await hashToken(token), createdAt: now, expiresAt }, ttl);
  return json({ address: `${local}@${env.MAIL_DOMAIN}`, local, token, expiresAt }, 201);
}

/** 報告に使えるホスト名か。小文字化して返し、駄目なら null（呼び出し側が 400）。 */
export function normalizeReportHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,253}$/.test(host)) return null;
  if (!host.includes(".")) return null;
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return null;
  if (host.startsWith("-") || host.endsWith("-")) return null;
  return host;
}

/**
 * 届いた・届かなかったの報告（FR-18）。
 * どのアドレスからの報告かを二重計上の判定に使うので、body に `local` を取る
 * （token だけでは持ち主のアドレスを引けない。逆引き索引は作らない）。
 */
async function reportDelivery(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request, 1024);
  const payload = (body ?? {}) as { local?: unknown; host?: unknown; result?: unknown };
  const local = typeof payload.local === "string" ? payload.local : "";
  const auth = await authenticate(request, env, local);
  if (auth instanceof Response) return auth;
  const host = normalizeReportHost(payload.host);
  if (!host) return json({ error: "Invalid host" }, 400);
  if (payload.result !== "ok" && payload.result !== "ng") return json({ error: "Invalid result" }, 400);

  const mark = await markHostReported(env.INBOX, local, host);
  // 二重報告と上限超えは数えないが、利用者には成功として返す（押し直しでエラーを出さない）
  if (mark === "recorded") await bumpStat(env.INBOX, host, payload.result);
  return noContent();
}

function messageSummary(message: Awaited<ReturnType<typeof listMessages>>[number]) {
  return {
    id: message.id,
    from: message.from,
    subject: message.subject,
    receivedAt: message.receivedAt,
    codes: message.codes,
    links: message.links,
    textPreview: message.text.slice(0, 240),
  };
}

export async function handleApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && path === "/api/config") {
    const vapid = getVapidKeys(env);
    return json({
      mailDomain: env.MAIL_DOMAIN,
      addressTtlSeconds: getAddressTtlSeconds(env),
      push: vapid !== null,
      ...(vapid ? { vapidPublicKey: vapid.publicKey } : {}),
      ...(isTurnstileEnabled(env) ? { turnstileSiteKey: env.TURNSTILE_SITE_KEY } : {}),
    });
  }
  if (request.method === "POST" && path === "/api/address") return issueAddress(request, env);
  if (request.method === "POST" && path === "/api/report") return reportDelivery(request, env);

  if (request.method === "GET" && path === "/api/stats/top") {
    const stats = await listStats(env.INBOX);
    return json({ stats: stats.slice(0, TOP_STATS_LIMIT) }, 200, { "Cache-Control": STATS_CACHE_CONTROL });
  }

  if (request.method === "GET" && path === "/api/stats") {
    const host = normalizeReportHost(url.searchParams.get("host"));
    if (!host) return json({ error: "Invalid host" }, 400);
    const stat = await getStat(env.INBOX, host);
    return json({ host, ok: stat?.ok ?? 0, ng: stat?.ng ?? 0 }, 200, { "Cache-Control": STATS_CACHE_CONTROL });
  }

  if (request.method === "POST" && path === "/api/dev/inject") {
    if (env.DEV_INJECT !== "1") return json({ error: "Not found" }, 404);
    const to = url.searchParams.get("to") ?? "";
    const from = url.searchParams.get("from") ?? "";
    const raw = await request.arrayBuffer();
    const result = await handleIncoming({ from, to, raw, rawSize: raw.byteLength }, env);
    if (!result.ok) return json({ error: result.reason }, result.reason === "Message too large" ? 413 : 404);
    return json({ accepted: true, id: result.message.id }, 202);
  }

  const pushMatch = path.match(/^\/api\/address\/([a-z2-9]{10})\/push$/);
  if (pushMatch && (request.method === "POST" || request.method === "DELETE")) {
    const local = pushMatch[1];
    const auth = await authenticate(request, env, local);
    if (auth instanceof Response) return auth;
    if (request.method === "DELETE") {
      // 解除は VAPID の有無に関わらず通す（消す操作を塞がない）
      await setPushSubscription(env.INBOX, local, null);
      return noContent();
    }
    if (!getVapidKeys(env)) return json({ error: "Not found" }, 404);
    const subscription = parsePushSubscription(await readJsonBody(request));
    if (!subscription) return json({ error: "Invalid subscription" }, 400);
    if (!(await setPushSubscription(env.INBOX, local, subscription))) return json({ error: "Not found" }, 404);
    return noContent();
  }

  const detailMatch = path.match(/^\/api\/address\/([a-z2-9]{10})\/messages\/([^/]+)$/);
  if (detailMatch && request.method === "GET") {
    const [, local, id] = detailMatch;
    const auth = await authenticate(request, env, local);
    if (auth instanceof Response) return auth;
    let decodedId: string;
    try {
      decodedId = decodeURIComponent(id);
    } catch {
      // 壊れたパーセント符号は 404。例外のまま 500 にしない（M-1）
      return json({ error: "Not found" }, 404);
    }
    const message = await getMessage(env.INBOX, local, decodedId, { cacheTtl: POLL_CACHE_TTL });
    return message ? json({ ...messageSummary(message), text: message.text }) : json({ error: "Not found" }, 404);
  }

  const messagesMatch = path.match(/^\/api\/address\/([a-z2-9]{10})\/messages$/);
  if (messagesMatch && request.method === "GET") {
    const local = messagesMatch[1];
    const auth = await authenticate(request, env, local);
    if (auth instanceof Response) return auth;
    return json({
      messages: (await listMessages(env.INBOX, local, { cacheTtl: POLL_CACHE_TTL })).map(messageSummary),
    });
  }

  const addressMatch = path.match(/^\/api\/address\/([a-z2-9]{10})$/);
  if (addressMatch) {
    const local = addressMatch[1];
    const auth = await authenticate(request, env, local);
    if (auth instanceof Response) return auth;
    if (request.method === "DELETE") {
      await Promise.all([deleteAddress(env.INBOX, local), deleteAllMessages(env.INBOX, local)]);
      return noContent();
    }
    if (request.method === "GET") {
      const messages = await listMessages(env.INBOX, local, { cacheTtl: POLL_CACHE_TTL });
      return json({
        address: `${local}@${env.MAIL_DOMAIN}`,
        expiresAt: auth.record.expiresAt,
        remainingSeconds: Math.max(0, Math.ceil((auth.record.expiresAt - Date.now()) / 1000)),
        messageCount: messages.length,
      });
    }
  }
  return null;
}
