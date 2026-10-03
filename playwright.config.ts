import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:8788";

export default defineConfig({
  testDir: "./tests/e2e",
  // wrangler dev は1プロセスしか立てないので、テストも直列に流す
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    permissions: ["clipboard-read", "clipboard-write"],
  },
  webServer: {
    // npm run dev と同じ環境変数（テレメトリ停止・ログとレジストリを .wrangler/ に固定）で起動する
    command:
      "WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=.wrangler/logs WRANGLER_REGISTRY_PATH=.wrangler/registry npx wrangler dev --port 8788",
    url: `${baseURL}/api/config`,
    reuseExistingServer: true,
    timeout: 60000,
  },
});
