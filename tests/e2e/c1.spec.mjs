import { expect, test } from "@playwright/test";

/* 発行はIPのハッシュごとに10回/時で、カウンタは .wrangler/state に1時間残る。
   固定IPのままだと同じ時間内に10回テストを回した時点で 429 になるので、
   flow.spec.mjs と同じく毎回ちがうIPを名乗る（198.18.0.0/15 はベンチマーク用の予約帯）。 */
function benchmarkIp() {
  const value = Math.floor(Math.random() * 0x10000);
  return `198.18.${(value >> 8) & 0xff}.${value & 0xff}`;
}

test("C1 API smoke", async ({ request }) => {
  const config = await request.get("/api/config");
  expect(config.status()).toBe(200);
  await expect(config.json()).resolves.toMatchObject({ mailDomain: "sutemail.test", addressTtlSeconds: 600 });

  const issued = await request.post("/api/address", {
    headers: { "CF-Connecting-IP": benchmarkIp() },
  });
  expect(issued.status()).toBe(201);
  await expect(issued.json()).resolves.toMatchObject({ address: expect.stringMatching(/@sutemail\.test$/) });
});
