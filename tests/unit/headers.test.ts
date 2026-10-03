import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, withSecurityHeaders } from "../../src/lib/headers";
import worker from "../../src/worker";
import type { Env } from "../../src/types";

const baseEnv = env as unknown as Env;
const TURNSTILE_ENV: Partial<Env> = { TURNSTILE_SITE_KEY: "site-key", TURNSTILE_SECRET_KEY: "secret-key" };

/** 静的アセットの代わり。Worker が応答を作り直してヘッダーを足していることだけを見る。 */
function assetsStub(body = "<!doctype html>ok", init: ResponseInit = {}): Fetcher {
  return {
    fetch: async () =>
      new Response(body, { headers: { "content-type": "text/html; charset=utf-8" }, ...init }),
  } as unknown as Fetcher;
}

async function fetchAsset(overrides: Partial<Env> = {}, assets = assetsStub()): Promise<Response> {
  return worker.fetch(new Request("http://example.com/"), { ...baseEnv, ...overrides, ASSETS: assets });
}

describe("静的アセットのセキュリティヘッダー（I-7）", () => {
  it("既定のCSPは self だけを許す", () => {
    expect(buildContentSecurityPolicy(false)).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
        "manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    expect(buildContentSecurityPolicy(false)).not.toContain("challenges.cloudflare.com");
  });

  it("Turnstile有効時だけ script-src・frame-src・connect-src に challenges.cloudflare.com が入る", () => {
    const policy = buildContentSecurityPolicy(true);
    expect(policy).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(policy).toContain("connect-src 'self' https://challenges.cloudflare.com");
    expect(policy).toContain("frame-src https://challenges.cloudflare.com");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it("Turnstileが無効なWorkerの応答は self のみのCSPを載せる", async () => {
    const response = await fetchAsset();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ok");
    expect(response.headers.get("content-security-policy")).toBe(buildContentSecurityPolicy(false));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    // 元の応答のヘッダーは残す
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  it("鍵を2つ入れるだけでCSPが切り替わる（_headers の差し替えが要らない）", async () => {
    const response = await fetchAsset(TURNSTILE_ENV);
    expect(response.headers.get("content-security-policy")).toBe(buildContentSecurityPolicy(true));
  });

  it("片方の鍵だけならCSPは広げない", async () => {
    const response = await fetchAsset({ TURNSTILE_SITE_KEY: "site-key" });
    expect(response.headers.get("content-security-policy")).toBe(buildContentSecurityPolicy(false));
  });

  it("404などアセット側の状態を書き換えない", async () => {
    const response = await fetchAsset({}, assetsStub("not found", { status: 404 }));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-security-policy")).toBe(buildContentSecurityPolicy(false));
  });

  it("本文を持てない応答でも例外にしない", () => {
    const response = withSecurityHeaders(new Response(null, { status: 304 }), baseEnv);
    expect(response.status).toBe(304);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("APIの応答はアセットを経由せず、nosniff が載る", async () => {
    const response = await worker.fetch(new Request("http://example.com/api/config"), {
      ...baseEnv,
      ASSETS: {
        fetch: async () => {
          throw new Error("API が ASSETS を叩いてはいけない");
        },
      } as unknown as Fetcher,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
