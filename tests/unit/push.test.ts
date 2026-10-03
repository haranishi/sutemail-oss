import { createExecutionContext, env, fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildDeclarativePayload,
  buildNewMessageNotification,
  getVapidKeys,
  isPushEnabled,
  notifyNewMessage,
  parsePushSubscription,
  sendPush,
  type VapidKeys,
} from "../../src/lib/push";
import { handleEmail } from "../../src/handlers/email";
import { hashToken } from "../../src/lib/address";
import { getAddress, listMessages, putAddress, type PushSubscriptionRecord } from "../../src/lib/store";
import type { Env } from "../../src/types";
import supabase from "../fixtures/supabase-plain.eml?raw";

const baseEnv = env as unknown as Env;
const PUSH_ORIGIN = "https://push.example.com";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** 実鍵でテストする（ライブラリを差し替えず、署名と暗号化まで本物を通す）。 */
async function makeVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { subject: "mailto:abuse@example.com", publicKey: base64url(raw), privateKey: jwk.d as string };
}

async function makeSubscription(path = "/send/abc"): Promise<PushSubscriptionRecord> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    endpoint: `${PUSH_ORIGIN}${path}`,
    expirationTime: null,
    keys: { p256dh: base64url(raw), auth: base64url(crypto.getRandomValues(new Uint8Array(16))) },
  };
}

interface CapturedRequest {
  headers: Headers;
  body: BodyInit | undefined;
}

/** 送信先を差し替えて、実際の Push サービスを叩かずにヘッダーと本文を覗く。 */
function interceptPush(path: string, statusCode: number): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  fetchMock
    .get(PUSH_ORIGIN)
    .intercept({ path, method: "POST" })
    .reply((options) => {
      const headers =
        options.headers instanceof Headers ? options.headers : new Headers(options.headers as Record<string, string>);
      captured.push({ headers, body: options.body });
      return { statusCode };
    });
  return captured;
}

const payload = buildDeclarativePayload({
  title: "認証コードが届きました",
  body: "タップしてコードを確認",
  navigate: "https://example.com/",
});

describe("push", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => {
    fetchMock.assertNoPendingInterceptors();
  });

  it("Declarative Web Push の形で組み立てる", () => {
    expect(payload).toEqual({
      web_push: 8030,
      notification: {
        title: "認証コードが届きました",
        body: "タップしてコードを確認",
        navigate: "https://example.com/",
        app_badge: "1",
      },
    });
  });

  it("受信通知にコードを載せない", () => {
    const notification = buildNewMessageNotification("http://127.0.0.1:8788").notification;
    // 遷移先は APP_ORIGIN の直下だけ。メールの中身は URL にも入らない
    expect(notification.navigate).toBe("http://127.0.0.1:8788/");
    // ロック画面に出る文字（title と body）に数字が1つも無い＝コードが載る余地が無い
    expect(`${notification.title}${notification.body}`).not.toMatch(/\d/);
    expect(notification.app_badge).toBe("1");
  });

  it("VAPIDが1つでも欠けるとPushは無効", () => {
    expect(isPushEnabled(baseEnv)).toBe(false);
    expect(getVapidKeys({ ...baseEnv, VAPID_SUBJECT: "mailto:a@example.com" })).toBeNull();
    expect(
      getVapidKeys({ ...baseEnv, VAPID_SUBJECT: "mailto:a@example.com", VAPID_PUBLIC_KEY: "pub" }),
    ).toBeNull();
    expect(
      getVapidKeys({
        ...baseEnv,
        VAPID_SUBJECT: "mailto:a@example.com",
        VAPID_PUBLIC_KEY: "pub",
        VAPID_PRIVATE_KEY: "  ",
      }),
    ).toBeNull();
    expect(
      getVapidKeys({
        ...baseEnv,
        VAPID_SUBJECT: "mailto:a@example.com",
        VAPID_PUBLIC_KEY: "pub",
        VAPID_PRIVATE_KEY: "priv",
      }),
    ).toEqual({ subject: "mailto:a@example.com", publicKey: "pub", privateKey: "priv" });
  });

  it("壊れた購読を受け付けない", () => {
    expect(parsePushSubscription(null)).toBeNull();
    expect(parsePushSubscription({ endpoint: "http://push.example.com/x", keys: { p256dh: "a", auth: "b" } })).toBeNull();
    expect(parsePushSubscription({ endpoint: "not a url", keys: { p256dh: "a", auth: "b" } })).toBeNull();
    expect(parsePushSubscription({ endpoint: `${PUSH_ORIGIN}/x` })).toBeNull();
    expect(parsePushSubscription({ endpoint: `${PUSH_ORIGIN}/x`, keys: { p256dh: "short", auth: "short" } })).toBeNull();
  });

  it("整った購読はexpirationTimeを補って通す", async () => {
    const subscription = await makeSubscription();
    const parsed = parsePushSubscription({ endpoint: subscription.endpoint, keys: subscription.keys });
    expect(parsed).toEqual({ ...subscription, expirationTime: null });
  });

  it("TTLとUrgencyを付けて暗号化した本文を送る", async () => {
    const vapid = await makeVapidKeys();
    const subscription = await makeSubscription("/send/ttl");
    const captured = interceptPush("/send/ttl", 201);

    expect(await sendPush(subscription, payload, vapid)).toBe("sent");
    expect(captured).toHaveLength(1);
    expect(captured[0].headers.get("TTL")).toBe("60");
    expect(captured[0].headers.get("Urgency")).toBe("high");
    expect(captured[0].headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(captured[0].headers.get("Authorization")).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    // 本文は暗号化されているので、平文の日本語がそのまま流れないことを確かめる
    expect(String(captured[0].body)).not.toContain("認証コード");
  });

  it("410は購読が消えた合図として扱う", async () => {
    const vapid = await makeVapidKeys();
    const subscription = await makeSubscription("/send/gone");
    interceptPush("/send/gone", 410);
    expect(await sendPush(subscription, payload, vapid)).toBe("gone");
  });

  it("送信が失敗しても投げずにfailedを返す", async () => {
    const vapid = await makeVapidKeys();
    const subscription = await makeSubscription("/send/boom");
    interceptPush("/send/boom", 500);
    expect(await sendPush(subscription, payload, vapid)).toBe("failed");
  });

  it("VAPID未設定なら送信しない", async () => {
    const subscription = await makeSubscription("/send/never");
    // 傍受を仕掛けない＝ここで fetch が走れば disableNetConnect が落とす
    expect(await notifyNewMessage(baseEnv, "abcdefgh24", subscription)).toBe("skipped");
  });

  it("410を受けたら保存済みの購読を消す", async () => {
    const local = "abcdefgh25";
    const vapid = await makeVapidKeys();
    const subscription = await makeSubscription("/send/drop");
    const pushEnv: Env = {
      ...baseEnv,
      VAPID_SUBJECT: vapid.subject,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
    };
    await putAddress(
      env.INBOX,
      local,
      { tokenHash: await hashToken("token"), createdAt: Date.now(), expiresAt: Date.now() + 600_000, pushSub: subscription },
      600,
    );
    interceptPush("/send/drop", 410);

    expect(await notifyNewMessage(pushEnv, local, subscription)).toBe("gone");
    expect((await getAddress(env.INBOX, local))?.pushSub).toBeUndefined();
  });

  it("受信するとwaitUntil経由で通知を送り、保存は先に終わっている", async () => {
    const local = "abcdefgh26";
    const vapid = await makeVapidKeys();
    const subscription = await makeSubscription("/send/incoming");
    const pushEnv: Env = {
      ...baseEnv,
      VAPID_SUBJECT: vapid.subject,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
    };
    await putAddress(
      env.INBOX,
      local,
      {
        tokenHash: await hashToken("token"),
        createdAt: Date.now(),
        expiresAt: Date.now() + 600_000,
        pushSub: subscription,
      },
      600,
    );
    const captured = interceptPush("/send/incoming", 201);

    const ctx = createExecutionContext();
    await handleEmail(
      {
        from: "noreply@supabase.com",
        to: `${local}@sutemail.test`,
        raw: new Response(supabase).body,
        rawSize: supabase.length,
        setReject: () => {},
      } as unknown as ForwardableEmailMessage,
      pushEnv,
      ctx,
    );
    // handleEmail が返った時点でメールは読める（通知は waitUntil に預けてある）
    expect(await listMessages(env.INBOX, local)).toHaveLength(1);
    await waitOnExecutionContext(ctx);
    expect(captured).toHaveLength(1);
  });
});
