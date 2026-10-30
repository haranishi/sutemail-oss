import { reset } from "cloudflare:test";
import { beforeEach } from "vitest";

// 新しいプラグインでも、各テストを空のローカルストレージから始める。
beforeEach(async () => {
  await reset();
});
