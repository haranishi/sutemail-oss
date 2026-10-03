import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleApi } from "../../src/handlers/api";
import { handleIncoming } from "../../src/handlers/email";
import { hashToken } from "../../src/lib/address";
import {
  getAddressTtlSeconds,
  getIssueLimitPerHour,
  getMaxRawBytes,
  getMessageTtlSeconds,
  readIntEnv,
} from "../../src/lib/env";
import { putAddress } from "../../src/lib/store";
import type { Env } from "../../src/types";

const baseEnv = env as unknown as Env;

async function callApi(request: Request, overrides: Partial<Env> = {}): Promise<Response> {
  const response = await handleApi(request, { ...baseEnv, ...overrides });
  if (!response) throw new Error(`ルートが無い: ${request.method} ${request.url}`);
  return response;
}

function issueRequest(ip: string): Request {
  return new Request("http://example.com/api/address", { method: "POST", headers: { "CF-Connecting-IP": ip } });
}

describe("数値envの読み出し（I-4）", () => {
  it.each([
    ["欠落", undefined, 600],
    ["空文字", "   ", 600],
    ["数値でない", "abc", 600],
    ["小数", "10.5", 600],
    ["下限未満", "59", 600],
    ["上限超え", "3601", 600],
    ["正しい値", "1200", 1200],
    ["下限ちょうど", "60", 60],
    ["上限ちょうど", "3600", 3600],
  ])("%s は既定値へ倒す", (_name, raw, expected) => {
    expect(readIntEnv(raw as string | undefined, 600, 60, 3600)).toBe(expected);
  });

  it("欠落時の既定値は要件の値になる", () => {
    const empty = {} as Env;
    expect(getAddressTtlSeconds(empty)).toBe(600);
    expect(getMessageTtlSeconds(empty)).toBe(600);
    expect(getIssueLimitPerHour(empty)).toBe(10);
    expect(getMaxRawBytes(empty)).toBe(262_144);
  });

  it("ISSUE_LIMIT_PER_HOUR が欠けても11回目で429になる", async () => {
    // 旧実装は limit=NaN で `count >= NaN` が常に false ＝ 何回でも発行できた
    let last!: Response;
    for (let index = 0; index < 11; index += 1) {
      last = await callApi(issueRequest("198.51.100.7"), { ISSUE_LIMIT_PER_HOUR: undefined });
    }
    expect(last.status).toBe(429);
  });

  it("ADDRESS_TTL_SECONDS が欠けても失効するアドレスになる", async () => {
    const response = await callApi(issueRequest("198.51.100.8"), { ADDRESS_TTL_SECONDS: undefined });
    const issued = (await response.json()) as { expiresAt: number };
    expect(response.status).toBe(201);
    expect(Number.isFinite(issued.expiresAt)).toBe(true);
    expect(issued.expiresAt).toBeGreaterThan(Date.now());

    const config = await callApi(new Request("http://example.com/api/config"), { ADDRESS_TTL_SECONDS: undefined });
    expect(await config.json()).toEqual(expect.objectContaining({ addressTtlSeconds: 600 }));
  });

  it("MAX_RAW_BYTES が欠けても大きすぎるメールを拒否する", async () => {
    const local = "abcdefgh23";
    await putAddress(
      env.INBOX,
      local,
      { tokenHash: await hashToken("token"), createdAt: Date.now(), expiresAt: Date.now() + 600_000 },
      600,
    );
    const result = await handleIncoming(
      { from: "noreply@example.com", to: `${local}@sutemail.test`, raw: "", rawSize: 50 * 1024 * 1024 },
      { ...baseEnv, MAX_RAW_BYTES: undefined },
    );
    expect(result).toEqual({ ok: false, reason: "Message too large" });
  });
});
