import { expect, test } from "@playwright/test";

/* P1機能の E2E（C3b）。docs/01_requirements.md FR-17（通知）・FR-18（報告と実績）を確かめる。
   実 Push サービスは叩かない。通知はボタンが出る／出ないところまでで、購読はしない。 */

/* 発行はIPのハッシュごとに10回/時。テストごとに別のIPを名乗る（flow.spec.mjs と同じ理由）。 */
function benchmarkIp() {
  const value = Math.floor(Math.random() * 0x10000);
  return `198.18.${(value >> 8) & 0xff}.${value & 0xff}`;
}

/* 実績は KV に貯まり、テストを再実行しても消えない。件数を数える回は毎回ちがうホスト名を使う。 */
function freshHost() {
  return `e2e-${Math.random().toString(36).slice(2, 10)}.example.com`;
}

const appMain = (page) => page.locator("main#app");

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ "CF-Connecting-IP": benchmarkIp() });
});

async function issueAddress(page) {
  await page.goto("/");
  await expect(appMain(page)).toHaveAttribute("data-state", "idle");
  await page.getByRole("button", { name: "使い捨てアドレスを発行" }).click();
  await expect(appMain(page)).toHaveAttribute("data-state", "waiting");
}

/* 報告欄は待受のまま60秒たつまで出さない（採点r1 P10。届く前に訊いても判断材料が無い）。
   時計を進めて出す。時計を止めるとポーリングも止まるが、この回は受信を待たないので影響しない。 */
async function issueAndOpenReport(page) {
  await page.clock.install({ time: new Date() });
  await issueAddress(page);
  await expect(page.locator("#report")).toBeHidden();
  await page.clock.runFor(60000);
  await expect(page.locator("#report")).toBeVisible();
}

test("13) 報告すると実績に反映され、同じサイトの2回目は記録済みになる", async ({ page }) => {
  await issueAndOpenReport(page);
  const host = freshHost();

  await page.locator("#report-host").fill(host);
  await page.locator("#report-ok").click();

  await expect(page.locator("#report-message")).toHaveText("ありがとうございます。記録しました。");
  const stat = page.locator("#report-stat");
  await expect(stat).toContainText(host);
  await expect(stat).toContainText("届いた 1件");
  await expect(stat).toContainText("届かなかった 0件");

  await page.locator("#report-ok").click();
  await expect(page.locator("#report-message")).toHaveText("このサイトは記録済みです。");
  await expect(stat).toContainText("届いた 1件"); // 二重には数えない
});

test("14) URLを貼ってもホスト名だけを送り、サイト名が空なら押しても送らない", async ({ page }) => {
  await issueAndOpenReport(page);
  const host = freshHost();

  await page.locator("#report-ng").click();
  await expect(page.locator("#report-message")).toHaveText("使ったサイトを入れてから押してください（例: example.com）。");

  await page.locator("#report-host").fill(`https://${host}/signup?ref=1`);
  await page.locator("#report-ng").click();
  await expect(page.locator("#report-message")).toHaveText("ありがとうございます。記録しました。");
  await expect(page.locator("#report-stat")).toContainText(`${host} の実績: 届いた 0件／届かなかった 1件`);
});

test("15) 未発行と期限切れの画面に「最近の実績」が出る", async ({ page }) => {
  await page.goto("/");
  await expect(appMain(page)).toHaveAttribute("data-state", "idle");

  const stats = page.locator("#stats");
  await expect(stats).toBeVisible();
  await expect(stats.locator("h2")).toHaveText("最近の実績");
  // 0件なら文言、1件以上なら表。どちらか片方だけが出る
  await expect(page.locator("#stats-empty, .stats__table")).toHaveCount(1);
  const rows = page.locator(".stats__table tbody tr");
  expect(await rows.count()).toBeLessThanOrEqual(10);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);

  // 待受に入ると実績表を引っ込める。報告欄は60秒たってから出る（採点r1 P10）
  await page.clock.install({ time: new Date() });
  await page.getByRole("button", { name: "使い捨てアドレスを発行" }).click();
  await expect(appMain(page)).toHaveAttribute("data-state", "waiting");
  await expect(stats).toBeHidden();
  await expect(page.locator("#report")).toBeHidden();
  await page.clock.runFor(60000);
  await expect(page.locator("#report")).toBeVisible();
});

test("16) 通知ボタンは push が無効なサーバーでは出ない", async ({ page, request }) => {
  const config = await (await request.get("/api/config")).json();
  expect(config.push).toBe(false);
  expect(config.vapidPublicKey).toBeUndefined();

  await issueAddress(page);
  await expect(page.locator("#push-on")).toHaveCount(0);
  await expect(page.locator("#push-off")).toHaveCount(0);
  await expect(page.locator("#push-ios-hint")).toHaveCount(0);
});

test.describe("通知が有効なサーバーを装う", () => {
  // Service Worker が動いていると page.route が素通りすることがあるので、この回だけ止める。
  // 通知ボタンの表示は Service Worker の登録結果を待たずに決まるので、判定には影響しない
  test.use({ serviceWorkers: "block" });

  test("17) config が push:true を返すと通知ボタンが出る（購読はしない）", async ({ page }) => {
    await page.route("**/api/config", async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      await route.fulfill({
        json: { ...config, push: true, vapidPublicKey: "BFakeKeyForUiTestOnly" },
        headers: { "cache-control": "no-store" },
      });
    });

    await issueAddress(page);
    const button = page.locator("#push-on");
    await expect(button).toBeVisible();
    await expect(button).toHaveText("通知をオンにする");
    await expect(page.locator("#push-off")).toHaveCount(0);
    // 通知そのものは押さない。許可を1度も求めていないことを permission で確かめる
    // （権限を与えていないテスト用ブラウザでは default か denied のどちらかになる）
    expect(await page.evaluate(() => Notification.permission)).not.toBe("granted");
  });
});
