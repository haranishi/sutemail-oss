import { buildPushPayload } from "@block65/webcrypto-web-push";
import { MAX_PUSH_SENDS, reservePushSend, setPushSubscription, type PushSubscriptionRecord } from "./store";
import type { Env } from "../types";

/**
 * Declarative Web Push の本文。`web_push: 8030` が宣言型であることの目印で、
 * 対応ブラウザはサービスワーカーを起こさずにこの JSON だけで通知を出す。
 */
export type DeclarativePushPayload = {
  web_push: number;
  notification: {
    title: string;
    body: string;
    navigate: string;
    app_badge: string;
  };
};

export interface VapidKeys {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export type PushSendResult = "sent" | "gone" | "failed";
/** 送らなかった理由。`limited` は1アドレスの送信上限に達した状態（レビューの申し送り）。 */
export type PushNotifyResult = PushSendResult | "skipped" | "limited";

/**
 * 通知の TTL（秒）。認証コードは数分で使えなくなるので、端末が長く圏外なら
 * 届かないほうがよい。push サービスはこの秒数を過ぎた通知を捨てる。
 */
export const PUSH_TTL_SECONDS = 60;

const DECLARATIVE_WEB_PUSH_VERSION = 8030;

/** VAPID の3つが揃っているときだけ Push を有効にする（FR-17）。 */
export function getVapidKeys(env: Env): VapidKeys | null {
  const subject = env.VAPID_SUBJECT?.trim();
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!subject || !publicKey || !privateKey) return null;
  return { subject, publicKey, privateKey };
}

export function isPushEnabled(env: Env): boolean {
  return getVapidKeys(env) !== null;
}

export function buildDeclarativePayload(input: {
  title: string;
  body: string;
  navigate: string;
  appBadge?: string;
}): DeclarativePushPayload {
  return {
    web_push: DECLARATIVE_WEB_PUSH_VERSION,
    notification: {
      title: input.title,
      body: input.body,
      navigate: input.navigate,
      app_badge: input.appBadge ?? "1",
    },
  };
}

/**
 * ブラウザの `PushSubscription.toJSON()` を検証して受け入れる。
 * 送信先は https 固定。鍵の長さも見て、壊れた購読を KV に入れない。
 */
export function parsePushSubscription(value: unknown): PushSubscriptionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const endpoint = candidate.endpoint;
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > 1024) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const keys = candidate.keys;
  if (typeof keys !== "object" || keys === null) return null;
  const { p256dh, auth } = keys as Record<string, unknown>;
  // p256dh は非圧縮 P-256 点65バイト、auth は16バイト。base64/base64url どちらの表記も来る
  if (typeof p256dh !== "string" || !/^[A-Za-z0-9_\-+/]{80,120}={0,2}$/.test(p256dh)) return null;
  if (typeof auth !== "string" || !/^[A-Za-z0-9_\-+/]{16,32}={0,2}$/.test(auth)) return null;
  const expirationTime = typeof candidate.expirationTime === "number" ? candidate.expirationTime : null;
  return { endpoint, expirationTime, keys: { p256dh, auth } };
}

/**
 * 1件の購読へ送る。失敗しても投げない（受信処理を巻き込まないため）。
 * 404/410 は購読が消えた合図なので `gone` を返し、呼び出し側が控えを消す。
 */
export async function sendPush(
  subscription: PushSubscriptionRecord,
  payload: DeclarativePushPayload,
  vapid: VapidKeys,
): Promise<PushSendResult> {
  try {
    const built = await buildPushPayload(
      { data: payload, options: { ttl: PUSH_TTL_SECONDS, urgency: "high" } },
      subscription,
      vapid,
    );
    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: built.headers,
      body: built.body,
    });
    if (response.status === 404 || response.status === 410) return "gone";
    if (!response.ok) {
      console.warn(`push send failed: ${response.status}`);
      return "failed";
    }
    return "sent";
  } catch (error) {
    console.warn(`push send error: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}

/**
 * 受信通知の中身。メールから来た値を一切受け取らない形にしてある。
 * **コードは載せない**——ロック画面に出て他人に見えるため（FR-17）。
 */
export function buildNewMessageNotification(appOrigin: string): DeclarativePushPayload {
  return buildDeclarativePayload({
    title: "認証コードが届きました",
    body: "タップしてコードを確認",
    navigate: new URL("/", appOrigin).toString(),
  });
}

/**
 * 受信時の通知。VAPID 未設定・購読なし・購読が壊れているときは何もしない。
 * 送信の失敗は受信処理へ返さない（メールの保存は済んでいる）。
 */
export async function notifyNewMessage(
  env: Env,
  local: string,
  subscription: unknown,
): Promise<PushNotifyResult> {
  const vapid = getVapidKeys(env);
  if (!vapid) return "skipped";
  const parsed = parsePushSubscription(subscription);
  if (!parsed) return "skipped";
  // 1アドレスにつき上限まで。受信1通で1回 POST が出るので、上限が無いと外向き POST の増幅装置になる
  if (!(await reservePushSend(env.INBOX, local, MAX_PUSH_SENDS))) return "limited";
  const result = await sendPush(parsed, buildNewMessageNotification(env.APP_ORIGIN), vapid);
  if (result === "gone") await setPushSubscription(env.INBOX, local, null);
  return result;
}
