import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { IP_HASH_SECRET: "test-secret", DEV_INJECT: "1" } },
    }),
  ],
  test: {
    // 既定の除外を維持して、unitだけを対象にする。
    include: ["tests/unit/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
