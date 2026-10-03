import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // 拾う対象を明示する。exclude の上書きだと既定の除外が消え、tests/ の外の *.test.ts まで混ざる（M-5）
    include: ["tests/unit/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { IP_HASH_SECRET: "test-secret", DEV_INJECT: "1" },
        },
      },
    },
  },
});
