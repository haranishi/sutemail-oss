import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkAndCount, hashIp } from "../../src/lib/ratelimit";

describe("ratelimit", () => {
  it("IPを秘密鍵付きで固定長ハッシュ化する", async () => {
    const first = await hashIp("192.0.2.1", "secret");
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(await hashIp("192.0.2.1", "secret")).toBe(first);
    expect(await hashIp("192.0.2.1", "other")).not.toBe(first);
  });

  it("直近1時間の上限とRetry-Afterを返す", async () => {
    const now = 3_600_000 + 5000;
    expect(await checkAndCount(env.INBOX, "abc", 2, now)).toEqual({ ok: true });
    expect(await checkAndCount(env.INBOX, "abc", 2, now)).toEqual({ ok: true });
    // 最初の発行が窓から外れるまで＝ちょうど1時間待てば1枠空く
    expect(await checkAndCount(env.INBOX, "abc", 2, now)).toEqual({ ok: false, retryAfter: 3600 });
    expect(await checkAndCount(env.INBOX, "abc", 2, now + 3_600_001)).toEqual({ ok: true });
  });

  it("時間窓の境界をまたいでも上限の2倍を通さない（I-3）", async () => {
    // 旧実装は floor(now / 3600000) の固定バケットで、境界の前後2秒に20回通った
    const justBeforeBoundary = 100 * 3_600_000 - 1000;
    for (let index = 0; index < 10; index += 1) {
      expect(await checkAndCount(env.INBOX, "boundary", 10, justBeforeBoundary)).toEqual({ ok: true });
    }
    expect((await checkAndCount(env.INBOX, "boundary", 10, justBeforeBoundary)).ok).toBe(false);
    // 境界の向こう側（+2秒）でも通らない。ここが旧実装では通っていた
    expect((await checkAndCount(env.INBOX, "boundary", 10, justBeforeBoundary + 2000)).ok).toBe(false);
    // 1時間経つと10件とも窓から外れる（同じミリ秒に打ったため）＝また10回まで
    const afterWindow = justBeforeBoundary + 3_600_001;
    for (let index = 0; index < 10; index += 1) {
      expect(await checkAndCount(env.INBOX, "boundary", 10, afterWindow)).toEqual({ ok: true });
    }
    expect((await checkAndCount(env.INBOX, "boundary", 10, afterWindow)).ok).toBe(false);
  });

  it("壊れた値が入っていても数え直せる", async () => {
    await env.INBOX.put("rl:issue:broken", "not json");
    expect(await checkAndCount(env.INBOX, "broken", 1, 1_000_000)).toEqual({ ok: true });
    expect((await checkAndCount(env.INBOX, "broken", 1, 1_000_000)).ok).toBe(false);
  });

  it("保存する時刻の配列は上限件数までで頭打ちになる", async () => {
    for (let index = 0; index < 5; index += 1) {
      await checkAndCount(env.INBOX, "capped", 3, 1_000_000 + index);
    }
    expect(JSON.parse((await env.INBOX.get("rl:issue:capped")) ?? "[]")).toHaveLength(3);
  });
});
