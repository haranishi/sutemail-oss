import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleApi } from "../../src/handlers/api";
import { handleIncoming } from "../../src/handlers/email";
import { hashToken } from "../../src/lib/address";
import { notifyNewMessage } from "../../src/lib/push";
import {
  deleteAllMessages,
  getAddress,
  getMessage,
  getMessageIndex,
  listMessages,
  markHostReported,
  putAddress,
  putMessage,
  reservePushSend,
  setPushSubscription,
  type StoredMessage,
} from "../../src/lib/store";
import type { Env } from "../../src/types";
import supabase from "../fixtures/supabase-plain.eml?raw";

const baseEnv = env as unknown as Env;
const local = "abcdefgh23";
const to = `${local}@sutemail.test`;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const VAPID_ENV: Partial<Env> = {
  VAPID_SUBJECT: "mailto:abuse@example.com",
  VAPID_PUBLIC_KEY: base64url(new Uint8Array(65).fill(4)),
  VAPID_PRIVATE_KEY: base64url(new Uint8Array(32).fill(7)),
};

const subscription = {
  endpoint: "https://push.example.com/send/abc",
  expirationTime: null,
  keys: { p256dh: base64url(new Uint8Array(65).fill(4)), auth: base64url(new Uint8Array(16).fill(9)) },
};

async function issue(expiresAt = Date.now() + 600_000): Promise<void> {
  await putAddress(env.INBOX, local, { tokenHash: await hashToken("token"), createdAt: Date.now(), expiresAt }, 600);
}

function message(id: string, receivedAt: number): StoredMessage {
  return { id, from: "a@example.com", subject: "s", receivedAt, codes: [], links: [], text: `本文 ${id}` };
}

/** `kv.list` の呼び出し回数を数える KV。ポーリング経路が list を使っていないことを機械的に見る。 */
function countingKv(): { kv: KVNamespace; calls: () => number } {
  let listCalls = 0;
  const target = env.INBOX;
  const kv = new Proxy(target, {
    get(_target, property, receiver) {
      if (property === "list") {
        return (...args: Parameters<KVNamespace["list"]>) => {
          listCalls += 1;
          return target.list(...args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { kv, calls: () => listCalls };
}

async function callApi(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  const response = await handleApi(request, { ...baseEnv, ...overrides });
  if (!response) throw new Error(`ルートが無い: ${request.method} ${request.url}`);
  return response;
}

const authHeaders = { Authorization: "Bearer token" };

describe("メッセージ索引（I-2）", () => {
  it("受信すると idx: に索引が載り、addr: は索引を持たない（N-1）", async () => {
    await issue();
    await handleIncoming({ from: "noreply@example.com", to, raw: supabase, rawSize: supabase.length }, baseEnv);
    const entries = await getMessageIndex(env.INBOX, local);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({ key: expect.stringMatching(new RegExp(`^msg:${local}:`)) as unknown as string }),
    );
    // 索引は専用キーにある。`addr:` の中身には入れない（他の書き戻しで消えるため）
    expect(await env.INBOX.get(`idx:${local}`, "json")).not.toBeNull();
    expect(Object.keys((await getAddress(env.INBOX, local)) ?? {})).not.toContain("messages");
  });

  it("一覧と個別取得は kv.list を1回も呼ばない", async () => {
    await issue();
    await putMessage(env.INBOX, local, message("msg-0001", 1_700_000_000_000), 600, 600);
    await putMessage(env.INBOX, local, message("msg-0002", 1_700_000_001_000), 600, 600);

    const counting = countingKv();
    const list = await callApi(
      new Request(`http://example.com/api/address/${local}/messages`, { headers: authHeaders }),
      { INBOX: counting.kv },
    );
    const body = (await list.json()) as { messages: { id: string; textPreview: string }[] };
    // 応答の形は変えない（id・textPreview まで従来どおり）
    expect(body.messages.map((entry) => entry.id)).toEqual(["msg-0002", "msg-0001"]);
    expect(body.messages[0].textPreview).toBe("本文 msg-0002");

    const detail = await callApi(
      new Request(`http://example.com/api/address/${local}/messages/msg-0001`, { headers: authHeaders }),
      { INBOX: counting.kv },
    );
    expect(await detail.json()).toEqual(expect.objectContaining({ id: "msg-0001", text: "本文 msg-0001" }));

    const summary = await callApi(new Request(`http://example.com/api/address/${local}`, { headers: authHeaders }), {
      INBOX: counting.kv,
    });
    expect(await summary.json()).toEqual(expect.objectContaining({ messageCount: 2 }));

    expect(counting.calls()).toBe(0);
  });

  it("同じミリ秒でも並びが決まる（索引でも従来と同じ順）", async () => {
    await issue();
    const receivedAt = 1_700_000_000_000;
    for (const id of ["msg-0003", "msg-0001", "msg-0002"]) {
      await putMessage(env.INBOX, local, message(id, receivedAt), 600, 600);
    }
    expect((await listMessages(env.INBOX, local)).map((entry) => entry.id)).toEqual([
      "msg-0003",
      "msg-0002",
      "msg-0001",
    ]);
  });

  it("索引に無い本文は取り出せない", async () => {
    await issue();
    await putMessage(env.INBOX, local, message("msg-0001", 1_700_000_000_000), 600, 600);
    expect(await getMessage(env.INBOX, local, "msg-9999")).toBeNull();
  });

  it("DELETE は索引から漏れた鍵も list で掃除し、idx: 自身も消す", async () => {
    await issue();
    await putMessage(env.INBOX, local, message("msg-0001", 1_700_000_000_000), 600, 600);
    // 索引を書けなかった（競合した）ぶんを手で作る
    await env.INBOX.put(`msg:${local}:1700000002000-9999`, JSON.stringify(message("msg-9999", 1_700_000_002_000)), {
      expirationTtl: 600,
    });
    await deleteAllMessages(env.INBOX, local);
    expect((await env.INBOX.list({ prefix: `msg:${local}:` })).keys).toEqual([]);
    expect(await env.INBOX.get(`idx:${local}`)).toBeNull();
  });
});

/* レビュー r2 N-1 の再現。索引を `addr:` に相乗りさせていたとき、
   `addr:` を read-modify-write する処理（購読・報告・pushSent）が
   受信の書いた索引を古い値で上書きし、届いたメールが一覧から消えていた。
   ここでは「受信の直前に読んだ `addr:` を、受信の直後に書き戻す」＝競合そのものを作る。 */
describe("索引が addr: の書き戻しで消えないこと（N-1）", () => {
  async function receiveWhileHolding(
    stale: (record: Awaited<ReturnType<typeof getAddress>>) => Promise<unknown>,
  ): Promise<number> {
    await issue();
    // 受信より前に `addr:` を読む（別リクエストが read したところ）
    const before = await getAddress(env.INBOX, local);
    await handleIncoming({ from: "noreply@example.com", to, raw: supabase, rawSize: supabase.length }, baseEnv);
    // 受信の後に、古い値を根拠にした書き戻しが走る
    await stale(before);
    return (await listMessages(env.INBOX, local)).length;
  }

  it("受信 → 購読の保存 でも一覧に残る", async () => {
    const remaining = await receiveWhileHolding(async (record) => {
      // 実際の経路（POST /push）と同じ read-modify-write。古い値を掴んだまま書き戻す
      await putAddress(env.INBOX, local, { ...record!, pushSub: subscription }, 600);
      return setPushSubscription(env.INBOX, local, subscription);
    });
    expect(remaining).toBe(1);
  });

  it("受信 → 報告 でも一覧に残る", async () => {
    const remaining = await receiveWhileHolding(async (record) => {
      await putAddress(env.INBOX, local, { ...record!, reportedHosts: ["example.com"] }, 600);
      return markHostReported(env.INBOX, local, "example.com");
    });
    expect(remaining).toBe(1);
  });

  it("受信処理の中の pushSent 更新でも一覧に残る", async () => {
    const remaining = await receiveWhileHolding(async (record) => {
      // handleIncoming は保存の直後に notifyNewMessage → reservePushSend を呼ぶ
      await putAddress(env.INBOX, local, { ...record!, pushSent: 1 }, 600);
      return reservePushSend(env.INBOX, local);
    });
    expect(remaining).toBe(1);
  });

  it("索引を消しても本文の鍵は list で拾える（DELETE の掃除が保険になる）", async () => {
    await issue();
    await putMessage(env.INBOX, local, message("msg-0001", 1_700_000_000_000), 600, 600);
    await env.INBOX.delete(`idx:${local}`);
    expect(await listMessages(env.INBOX, local)).toEqual([]);
    await deleteAllMessages(env.INBOX, local);
    expect((await env.INBOX.list({ prefix: `msg:${local}:` })).keys).toEqual([]);
  });
});

describe("Push の送信上限（レビューの申し送り）", () => {
  it("1アドレス20回で打ち切る", async () => {
    await issue();
    for (let index = 0; index < 20; index += 1) {
      expect(await reservePushSend(env.INBOX, local)).toBe(true);
    }
    expect(await reservePushSend(env.INBOX, local)).toBe(false);
    expect((await getAddress(env.INBOX, local))?.pushSent).toBe(20);
  });

  it("上限に達したら送信そのものを試みない", async () => {
    await issue();
    const record = await getAddress(env.INBOX, local);
    await putAddress(env.INBOX, local, { ...record!, pushSent: 20 }, 600);
    // 送信を試みれば sendPush が failed を返す。limited は fetch まで行かなかった証拠
    expect(await notifyNewMessage({ ...baseEnv, ...VAPID_ENV }, local, subscription)).toBe("limited");
  });

  it("失効したアドレスには送らない", async () => {
    await issue(Date.now() - 1);
    expect(await reservePushSend(env.INBOX, local)).toBe(false);
  });
});
