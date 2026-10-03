import { env, fetchMock, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { handleApi } from "../../src/handlers/api";
import { getAddress, type AddressRecord } from "../../src/lib/store";
import type { Env } from "../../src/types";
import supabase from "../fixtures/supabase-plain.eml?raw";

interface IssuedAddress {
  address: string;
  local: string;
  token: string;
  expiresAt: number;
}

const baseEnv = env as unknown as Env;
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const TURNSTILE_PATH = "/turnstile/v0/siteverify";

async function issue(headers: HeadersInit = {}): Promise<{ response: Response; body: IssuedAddress }> {
  const response = await SELF.fetch(new Request("http://example.com/api/address", { method: "POST", headers }));
  return { response, body: (await response.json()) as IssuedAddress };
}

function auth(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

/**
 * env を差し替えたいときは Worker のルーターを直接呼ぶ。
 * `SELF.fetch` はテスト設定の env で固定されていて、VAPID や Turnstile を1件だけ足せない。
 */
async function callApi(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  const response = await handleApi(request, { ...baseEnv, ...overrides });
  if (!response) throw new Error(`ルートが無い: ${request.method} ${request.url}`);
  return response;
}

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

function subscription(endpoint = "https://push.example.com/send/abc"): unknown {
  return {
    endpoint,
    expirationTime: null,
    keys: { p256dh: base64url(new Uint8Array(65).fill(4)), auth: base64url(new Uint8Array(16).fill(9)) },
  };
}

function post(path: string, body: unknown, headers: HeadersInit = {}): Request {
  return new Request(`http://example.com${path}`, { method: "POST", body: JSON.stringify(body), headers });
}

describe("API", () => {
  it("configはno-storeで公開情報を返す", async () => {
    const response = await SELF.fetch("http://example.com/api/config");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(expect.objectContaining({ mailDomain: "sutemail.test", addressTtlSeconds: 600, push: false }));
  });

  it("発行から認証、注入、一覧、個別、削除まで通る", async () => {
    const { response: issuedResponse, body: issued } = await issue({ "CF-Connecting-IP": "192.0.2.10" });
    expect(issuedResponse.status).toBe(201);
    expect(issued.local).toMatch(/^[a-z2-9]{10}$/);
    expect(issued.token).toHaveLength(43);

    expect((await SELF.fetch(`http://example.com/api/address/${issued.local}`)).status).toBe(401);
    expect((await SELF.fetch("http://example.com/api/address/abcdefgh23", { headers: auth("wrong") })).status).toBe(404);
    expect((await SELF.fetch(`http://example.com/api/address/${issued.local}`, { headers: auth("wrong") })).status).toBe(401);

    const injected = await SELF.fetch(
      `http://example.com/api/dev/inject?to=${encodeURIComponent(issued.address)}&from=noreply%40example.com`,
      { method: "POST", body: supabase },
    );
    expect(injected.status).toBe(202);

    const listResponse = await SELF.fetch(`http://example.com/api/address/${issued.local}/messages`, { headers: auth(issued.token) });
    const list = (await listResponse.json()) as { messages: { id: string; codes: { value: string; confidence: string }[]; text?: string }[] };
    expect(list.messages).toHaveLength(1);
    expect(list.messages[0].codes).toContainEqual(expect.objectContaining({ value: "482913", confidence: "high" }));
    expect(list.messages[0].text).toBeUndefined();

    const detail = await SELF.fetch(`http://example.com/api/address/${issued.local}/messages/${list.messages[0].id}`, { headers: auth(issued.token) });
    expect(await detail.json()).toEqual(expect.objectContaining({ text: expect.stringContaining("482913") }));

    expect((await SELF.fetch(`http://example.com/api/address/${issued.local}`, { method: "DELETE", headers: auth(issued.token) })).status).toBe(204);
    expect((await SELF.fetch(`http://example.com/api/address/${issued.local}`, { headers: auth(issued.token) })).status).toBe(404);
  });

  it("論理失効したアドレスへ410を返して削除する", async () => {
    const { body: issued } = await issue({ "CF-Connecting-IP": "192.0.2.11" });
    const key = `addr:${issued.local}`;
    const record = await env.INBOX.get<AddressRecord>(key, "json");
    await env.INBOX.put(key, JSON.stringify({ ...record, expiresAt: Date.now() - 1 }), { expirationTtl: 60 });
    expect((await SELF.fetch(`http://example.com/api/address/${issued.local}`, { headers: auth(issued.token) })).status).toBe(410);
  });

  it("同一IPの11回目を429にする", async () => {
    let last!: Response;
    for (let index = 0; index < 11; index += 1) {
      last = await SELF.fetch(new Request("http://example.com/api/address", { method: "POST", headers: { "CF-Connecting-IP": "192.0.2.99" } }));
    }
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await last.json()).toEqual(expect.objectContaining({ error: "Rate limit exceeded", retryAfter: expect.any(Number) }));
  });
});

describe("Web Push の購読（FR-17）", () => {
  it("VAPIDが揃っていればconfigでpushを有効にし、公開鍵を渡す", async () => {
    const disabled = await callApi(new Request("http://example.com/api/config"));
    expect(await disabled.json()).not.toHaveProperty("vapidPublicKey");

    const enabled = await callApi(new Request("http://example.com/api/config"), VAPID_ENV);
    expect(await enabled.json()).toEqual(
      expect.objectContaining({ push: true, vapidPublicKey: VAPID_ENV.VAPID_PUBLIC_KEY }),
    );
  });

  it("購読を保存して解除できる", async () => {
    const { body: issued } = await issue({ "CF-Connecting-IP": "192.0.2.20" });
    const saved = await callApi(
      post(`/api/address/${issued.local}/push`, subscription(), auth(issued.token)),
      VAPID_ENV,
    );
    expect(saved.status).toBe(204);
    expect((await getAddress(env.INBOX, issued.local))?.pushSub).toEqual(subscription());

    const removed = await callApi(
      new Request(`http://example.com/api/address/${issued.local}/push`, {
        method: "DELETE",
        headers: auth(issued.token),
      }),
      VAPID_ENV,
    );
    expect(removed.status).toBe(204);
    expect((await getAddress(env.INBOX, issued.local))?.pushSub).toBeUndefined();
  });

  it("VAPID未設定なら購読を受け付けない", async () => {
    const { body: issued } = await issue({ "CF-Connecting-IP": "192.0.2.21" });
    const response = await callApi(post(`/api/address/${issued.local}/push`, subscription(), auth(issued.token)));
    expect(response.status).toBe(404);
    expect((await getAddress(env.INBOX, issued.local))?.pushSub).toBeUndefined();
  });

  it("壊れた購読と認証なしを弾く", async () => {
    const { body: issued } = await issue({ "CF-Connecting-IP": "192.0.2.22" });
    const badKeys = await callApi(
      post(`/api/address/${issued.local}/push`, { endpoint: "https://push.example.com/x" }, auth(issued.token)),
      VAPID_ENV,
    );
    expect(badKeys.status).toBe(400);

    const insecure = await callApi(
      post(`/api/address/${issued.local}/push`, subscription("http://push.example.com/x"), auth(issued.token)),
      VAPID_ENV,
    );
    expect(insecure.status).toBe(400);

    const noToken = await callApi(post(`/api/address/${issued.local}/push`, subscription()), VAPID_ENV);
    expect(noToken.status).toBe(401);
  });
});

describe("届いた・届かなかった報告（FR-18）", () => {
  it("報告すると集計に載り、同じアドレスからの二重報告は数えない", async () => {
    const { body: issued } = await issue({ "CF-Connecting-IP": "192.0.2.30" });
    const report = (host: string, result: string) =>
      SELF.fetch(post("/api/report", { local: issued.local, host, result }, auth(issued.token)));

    expect((await report("example.com", "ok")).status).toBe(204);
    const first = await SELF.fetch("http://example.com/api/stats?host=example.com");
    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await first.json()).toEqual({ host: "example.com", ok: 1, ng: 0 });

    // 同じアドレスから同じホストへ2回目。応答は成功のままだが件数は増えない
    expect((await report("EXAMPLE.com", "ng")).status).toBe(204);
    expect(await (await SELF.fetch("http://example.com/api/stats?host=example.com")).json()).toEqual({
      host: "example.com",
      ok: 1,
      ng: 0,
    });

    // 別のホストなら同じアドレスからでも数える
    expect((await report("shop.example.jp", "ng")).status).toBe(204);
    expect(await (await SELF.fetch("http://example.com/api/stats?host=shop.example.jp")).json()).toEqual({
      host: "shop.example.jp",
      ok: 0,
      ng: 1,
    });
  });

  it("別のアドレスからの報告は同じホストでも数える", async () => {
    const { body: first } = await issue({ "CF-Connecting-IP": "192.0.2.31" });
    const { body: second } = await issue({ "CF-Connecting-IP": "192.0.2.32" });
    for (const issued of [first, second]) {
      const response = await SELF.fetch(
        post("/api/report", { local: issued.local, host: "shared.example.com", result: "ok" }, auth(issued.token)),
      );
      expect(response.status).toBe(204);
    }
    expect(await (await SELF.fetch("http://example.com/api/stats?host=shared.example.com")).json()).toEqual({
      host: "shared.example.com",
      ok: 2,
      ng: 0,
    });
  });

  it("ホスト名と結果の検証で400を返す", async () => {
    const { body: issued } = await issue({ "CF-Connecting-IP": "192.0.2.33" });
    const bad = async (body: unknown) =>
      (await SELF.fetch(post("/api/report", body, auth(issued.token)))).status;

    expect(await bad({ local: issued.local, host: "localhost", result: "ok" })).toBe(400);
    expect(await bad({ local: issued.local, host: "https://example.com/path", result: "ok" })).toBe(400);
    expect(await bad({ local: issued.local, host: "例え.com", result: "ok" })).toBe(400);
    expect(await bad({ local: issued.local, host: "a..b.com", result: "ok" })).toBe(400);
    expect(await bad({ local: issued.local, host: `${"a".repeat(250)}.com`, result: "ok" })).toBe(400);
    expect(await bad({ local: issued.local, host: "example.com", result: "maybe" })).toBe(400);
    expect(await bad({ local: issued.local, host: "example.com" })).toBe(400);
    expect((await SELF.fetch("http://example.com/api/stats?host=localhost")).status).toBe(400);
    expect((await SELF.fetch("http://example.com/api/stats")).status).toBe(400);
  });

  it("認証できない報告は401か404", async () => {
    const { body: issued } = await issue({ "CF-Connecting-IP": "192.0.2.34" });
    const noToken = await SELF.fetch(post("/api/report", { local: issued.local, host: "example.com", result: "ok" }));
    expect(noToken.status).toBe(401);
    const unknown = await SELF.fetch(
      post("/api/report", { local: "abcdefgh23", host: "example.com", result: "ok" }, auth(issued.token)),
    );
    expect(unknown.status).toBe(404);
  });

  it("実績のないホストは0件、上位一覧は件数順に最大10件", async () => {
    const empty = await SELF.fetch("http://example.com/api/stats?host=never.example.com");
    expect(await empty.json()).toEqual({ host: "never.example.com", ok: 0, ng: 0 });

    // 12アドレスを使い、k番目のアドレスは h1〜hk を報告する。h1が12件、h12が1件になる
    const hosts = Array.from({ length: 12 }, (_, index) => `h${index + 1}.example.com`);
    for (let addressIndex = 0; addressIndex < hosts.length; addressIndex += 1) {
      const { body: issued } = await issue({ "CF-Connecting-IP": `192.0.2.${100 + addressIndex}` });
      expect(issued.local, JSON.stringify(issued)).toMatch(/^[a-z2-9]{10}$/);
      for (const host of hosts.slice(0, addressIndex + 1)) {
        const response = await SELF.fetch(
          post("/api/report", { local: issued.local, host, result: "ok" }, auth(issued.token)),
        );
        expect(response.status).toBe(204);
      }
    }
    const top = await SELF.fetch("http://example.com/api/stats/top");
    expect(top.headers.get("cache-control")).toBe("public, max-age=60");
    const body = (await top.json()) as { stats: { host: string; ok: number; ng: number }[] };
    expect(body.stats).toHaveLength(10);
    expect(body.stats[0]).toEqual({ host: "h1.example.com", ok: 12, ng: 0 });
    expect(body.stats.at(-1)).toEqual({ host: "h10.example.com", ok: 3, ng: 0 });
  });

  it("1アドレスからの報告は20ホストで打ち止め", async () => {
    const { body: issued } = await issue({ "CF-Connecting-IP": "192.0.2.60" });
    for (let index = 0; index < 21; index += 1) {
      const response = await SELF.fetch(
        post("/api/report", { local: issued.local, host: `cap${index}.example.com`, result: "ok" }, auth(issued.token)),
      );
      // 上限を超えた分も応答は成功のまま。数えないだけ
      expect(response.status).toBe(204);
    }
    expect(await (await SELF.fetch("http://example.com/api/stats?host=cap19.example.com")).json()).toEqual({
      host: "cap19.example.com",
      ok: 1,
      ng: 0,
    });
    expect(await (await SELF.fetch("http://example.com/api/stats?host=cap20.example.com")).json()).toEqual({
      host: "cap20.example.com",
      ok: 0,
      ng: 0,
    });
  });
});

describe("Turnstile（FR-12）", () => {
  const TURNSTILE_ENV: Partial<Env> = { TURNSTILE_SITE_KEY: "site-key", TURNSTILE_SECRET_KEY: "secret-key" };

  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterAll(() => {
    fetchMock.deactivate();
  });
  afterEach(() => {
    fetchMock.assertNoPendingInterceptors();
  });

  function interceptSiteverify(reply: { success: boolean }): void {
    fetchMock.get(TURNSTILE_ORIGIN).intercept({ path: TURNSTILE_PATH, method: "POST" }).reply(200, reply);
  }

  it("両方の鍵が揃ったときだけconfigにサイトキーを出す", async () => {
    const onlySite = await callApi(new Request("http://example.com/api/config"), { TURNSTILE_SITE_KEY: "site-key" });
    expect(await onlySite.json()).not.toHaveProperty("turnstileSiteKey");
    const both = await callApi(new Request("http://example.com/api/config"), TURNSTILE_ENV);
    expect(await both.json()).toEqual(expect.objectContaining({ turnstileSiteKey: "site-key" }));
  });

  it("検証に通れば発行できる", async () => {
    interceptSiteverify({ success: true });
    const response = await callApi(
      post("/api/address", { turnstileToken: "good" }, { "CF-Connecting-IP": "192.0.2.40" }),
      TURNSTILE_ENV,
    );
    expect(response.status).toBe(201);
  });

  it("検証に落ちたら403", async () => {
    interceptSiteverify({ success: false });
    const response = await callApi(
      post("/api/address", { turnstileToken: "bad" }, { "CF-Connecting-IP": "192.0.2.41" }),
      TURNSTILE_ENV,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Turnstile verification failed" });
  });

  it("トークンが無ければsiteverifyを呼ばずに403", async () => {
    const response = await callApi(post("/api/address", {}, { "CF-Connecting-IP": "192.0.2.42" }), TURNSTILE_ENV);
    expect(response.status).toBe(403);
  });

  it("siteverifyに届かなければ503で、発行もレート制限の消費もしない", async () => {
    fetchMock
      .get(TURNSTILE_ORIGIN)
      .intercept({ path: TURNSTILE_PATH, method: "POST" })
      .replyWithError(new Error("network down"));
    const response = await callApi(
      post("/api/address", { turnstileToken: "good" }, { "CF-Connecting-IP": "192.0.2.43" }),
      TURNSTILE_ENV,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({ error: "Turnstile verification unavailable" });
  });

  it("秘密鍵だけ・サイトキーだけなら検証しない", async () => {
    const response = await callApi(post("/api/address", {}, { "CF-Connecting-IP": "192.0.2.44" }), {
      TURNSTILE_SITE_KEY: "site-key",
    });
    expect(response.status).toBe(201);
  });
});
