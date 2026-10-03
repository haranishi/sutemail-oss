import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* 画面の E2E（C2a）。docs/02_ux_design.md ③④⑤ と docs/01_requirements.md FR-08〜FR-15 を確かめる。
   OGP画像とアイコン（/og.png・/icons/*・/apple-touch-icon.png）は C2b が生成するため、
   この時点ではまだ存在しない。HTMLとmanifestからの参照だけ先に書いてあるので、
   「console error が0件」の判定ではその404だけを除外する。 */
const C2B_ASSET_PATTERN = /(og\.png|apple-touch-icon\.png|icons\/[a-z0-9._-]+\.png)/i;

function fixture(name) {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
}

/* 発行はIPのハッシュごとに10回/時。テストごとに別のIPを名乗って、連続実行や再実行で
   上限に当たらないようにする（198.18.0.0/15 はベンチマーク用の予約帯）。 */
function benchmarkIp() {
  const value = Math.floor(Math.random() * 0x10000);
  return `198.18.${(value >> 8) & 0xff}.${value & 0xff}`;
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
  const address = (await page.locator("#address").innerText()).trim();
  expect(address).toMatch(/^[a-z2-9]{10}@sutemail\.test$/);
  return address;
}

async function inject(request, to, fixtureName, from) {
  const response = await request.post(
    `/api/dev/inject?to=${encodeURIComponent(to)}&from=${encodeURIComponent(from)}`,
    { headers: { "content-type": "message/rfc822" }, data: fixture(fixtureName) },
  );
  expect(response.status()).toBe(202);
}

/* 「その状態でいちばん大きい要素は1つ」（docs/02_ux_design.md ④）を字の大きさで測る。
   main の中で、直接テキストを持ち、目に見える大きさのある要素を全部拾い、
   data-hero より大きい字のものが1つも無いことを確かめる。 */
async function biggerThanHero(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    const hero = main.querySelector("[data-hero]");
    if (!hero) return ["data-hero が見つからない"];
    const heroSize = Number.parseFloat(getComputedStyle(hero).fontSize);
    return [...main.querySelectorAll("*")]
      .filter((node) => {
        if (node === hero || hero.contains(node) || node.contains(hero)) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 12) return false;
        return [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim());
      })
      .filter((node) => Number.parseFloat(getComputedStyle(node).fontSize) > heroSize)
      .map((node) => `${node.tagName}.${node.className} ${getComputedStyle(node).fontSize}`);
  });
}

test("1) idle は発行ボタンが最大の要素", async ({ page }) => {
  await page.goto("/");
  await expect(appMain(page)).toHaveAttribute("data-state", "idle");
  const hero = page.locator("main [data-hero]");
  await expect(hero).toHaveCount(1);
  await expect(hero).toHaveText("使い捨てアドレスを発行");
  const box = await hero.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(48);
  expect(await biggerThanHero(page)).toEqual([]);
});

test("2) 発行すると waiting になり、アドレスをコピーできる", async ({ page }) => {
  const address = await issueAddress(page);
  expect(address.endsWith("@sutemail.test")).toBe(true);
  await expect(page.locator("main [data-hero]")).toHaveCount(1);
  await expect(page.locator("#address")).toHaveAttribute("data-hero", "true");
  expect(await biggerThanHero(page)).toEqual([]);
  await expect(page.locator("#remaining-value")).toHaveText(/^\d{2}:\d{2}$/);
  await expect(page.locator(".remaining")).toHaveAttribute("aria-live", "off");

  await page.locator("#copy-address").click();
  await expect(page.locator("#toast")).toHaveText("コピーしました");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);
});

test("3) メールが届くと received になり、コードをコピーできる", async ({ page, request }) => {
  const address = await issueAddress(page);
  const injectedAt = Date.now();
  await inject(request, address, "supabase-plain.eml", "noreply@supabase.com");
  // ポーリングは3秒間隔。1周ぶんの待ちと往復の余裕を見て6秒で判定する
  await expect(appMain(page)).toHaveAttribute("data-state", "received", { timeout: 6000 });
  expect(Date.now() - injectedAt).toBeLessThan(6000);

  const code = page.locator(".code");
  await expect(code).toHaveText("482913");
  await expect(code).toHaveAttribute("data-hero", "true");
  const codeSize = await code.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  expect(codeSize).toBeGreaterThanOrEqual(40);
  expect(await biggerThanHero(page)).toEqual([]);
  await expect(page.locator("#announce")).toHaveText("認証コードが届きました");
  await expect(page.locator("#latest-message")).toContainText("noreply@supabase.com");
  await expect(page.locator("#latest-message")).toContainText("Your verification code");

  await page.locator("#copy-code").click();
  await expect(page.locator("#toast")).toHaveText("コピーしました");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("482913");
});

test("4) リンク方式のメールはホスト名を大きく出し、URL全体は折りたたむ", async ({ page, request }) => {
  const address = await issueAddress(page);
  await inject(request, address, "github-link.eml", "noreply@github.com");
  await expect(appMain(page)).toHaveAttribute("data-state", "received", { timeout: 6000 });

  await expect(page.locator(".link__host")).toHaveText("github.com");
  const open = page.getByRole("link", { name: "開く" });
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("rel", "noopener noreferrer");
  await expect(open).toHaveAttribute("href", "https://github.com/users/verify?token=secret");

  const url = page.locator(".link__url");
  await expect(url).toBeHidden();
  await page.locator("details.link__details > summary").click();
  await expect(url).toHaveText("https://github.com/users/verify?token=secret");
});

test("5) 期限が切れると expired になり、1タップで新しいアドレスを発行できる", async ({ page }) => {
  await page.clock.install({ time: new Date() });
  const first = await issueAddress(page);

  await page.clock.fastForward("11:00");
  await expect(appMain(page)).toHaveAttribute("data-state", "expired");
  const hero = page.locator("main [data-hero]");
  await expect(hero).toHaveCount(1);
  await expect(hero).toHaveText("新しいアドレスを発行");
  expect(await biggerThanHero(page)).toEqual([]);

  // 進めたままだと、サーバーが返す新しい失効時刻（実時間+10分）がページの現在時刻より
  // 過去になり、発行した瞬間にまた期限切れになる。再発行の前に実時間へ戻す
  await page.clock.setSystemTime(new Date());
  await page.getByRole("button", { name: "新しいアドレスを発行" }).click();
  await expect(appMain(page)).toHaveAttribute("data-state", "waiting");
  const second = (await page.locator("#address").innerText()).trim();
  expect(second).not.toBe(first);
});

test("6) 読み込み直しても状態が戻る", async ({ page, request }) => {
  const address = await issueAddress(page);
  await inject(request, address, "supabase-plain.eml", "noreply@supabase.com");
  await expect(appMain(page)).toHaveAttribute("data-state", "received", { timeout: 6000 });

  await page.reload();
  await expect(appMain(page)).toHaveAttribute("data-state", "received", { timeout: 6000 });
  await expect(page.locator("#address")).toHaveText(address);
  await expect(page.locator(".code")).toHaveText("482913");
});

test.describe("390px（iPhone相当）", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("7) 390px で横スクロールが出ず、ボタンが親指で押せる", async ({ page, request }) => {
    const address = await issueAddress(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await inject(request, address, "github-link.eml", "noreply@github.com");
    await expect(appMain(page)).toHaveAttribute("data-state", "received", { timeout: 6000 });
    await page.locator("details.link__details > summary").click();
    await page.locator("details.body > summary").click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    const heights = await page
      .locator(".btn")
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(0);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(48);
  });
});

test("8) シェア欄に X・LINE・リンクコピーがある", async ({ page }) => {
  await page.goto("/");
  const share = page.locator("#share .share");
  await expect(share).toBeVisible();
  await expect(share.getByRole("link", { name: "Xで投稿" })).toBeVisible();
  await expect(share.getByRole("link", { name: "LINEで送る" })).toBeVisible();
  await expect(share.getByRole("button", { name: "リンクをコピー" })).toBeVisible();
});

/* 静的3ページに必ずある節（FR-13）。
   運営者の3項目は「【要記入】のまま残っているか」ではなく「項目が存在するか」で見る。
   埋めるのは docs/DEPLOY.md ⑫ の作業で、手順どおり埋めた瞬間にテストが赤くなってはいけない
   （REVIEW-r1 I-8）。 */
const DOC_SECTIONS = {
  "/terms": ["本サービスの内容", "無保証", "使ってはいけない用途", "禁止行為"],
  "/privacy": ["取得する情報", "保存期間", "第三者提供", "外部への送信"],
  "/external-transmission": ["例外は2つだけ", "メールの中のリンクについて", "サーバーの所在"],
};

test("9) 静的3ページが開き、必要な節があり、トップへ戻れる", async ({ page }) => {
  for (const [path, sections] of Object.entries(DOC_SECTIONS)) {
    const response = await page.goto(path);
    expect(response.status()).toBe(200);
    await expect(page.locator("h1")).toBeVisible();
    for (const section of sections) {
      await expect(page.locator("main.doc h2", { hasText: section })).toHaveCount(1);
    }
    // 運営者の連絡先3項目（氏名・所在地・窓口）が項目として置かれていること
    await expect(page.locator("main.doc h2", { hasText: "運営者" })).toHaveCount(1);
    const owner = page.locator('main.doc h2:text-is("運営者") + ul > li');
    await expect(owner).toHaveCount(3);
    await expect(owner.nth(0)).toContainText("氏名");
    await expect(owner.nth(1)).toContainText("所在地");
    await expect(owner.nth(2)).toContainText("窓口");
    const back = page.getByRole("link", { name: "トップへ戻る" });
    await expect(back).toHaveCount(1);
    await expect(back).toHaveAttribute("href", "/");
  }
  await page.goto("/external-transmission");
  await expect(page.locator("body")).toContainText("challenges.cloudflare.com");
  await page.getByRole("link", { name: "トップへ戻る" }).click();
  await expect(appMain(page)).toHaveAttribute("data-state", "idle");
});

test("10) 一連の流れで console error が出ない", async ({ page, request }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    errors.push(`${message.text()} @ ${message.location()?.url ?? ""}`);
  });
  page.on("pageerror", (error) => errors.push(String(error)));

  const address = await issueAddress(page);
  await inject(request, address, "supabase-plain.eml", "noreply@supabase.com");
  await expect(appMain(page)).toHaveAttribute("data-state", "received", { timeout: 6000 });
  await page.locator("details.body > summary").click();
  await expect(page.locator("#body-text")).toContainText("482913");
  for (const path of ["/terms", "/privacy", "/external-transmission", "/"]) await page.goto(path);

  expect(errors.filter((line) => !C2B_ASSET_PATTERN.test(line))).toEqual([]);
});

test("11) 2通目が届くと1通目は「前に届いたメール」に畳まれる", async ({ page, request }) => {
  const address = await issueAddress(page);
  await inject(request, address, "supabase-plain.eml", "noreply@supabase.com");
  await expect(appMain(page)).toHaveAttribute("data-state", "received", { timeout: 6000 });
  await page.waitForTimeout(150); // 受信時刻をずらして並び順を確定させる
  await inject(request, address, "cognito-multipart.eml", "noreply@aws.amazon.com");
  await expect(page.locator(".code")).toHaveText("640218", { timeout: 6000 });

  const past = page.locator("details.past");
  await expect(past.locator("summary")).toHaveText("前に届いたメール（1件）");
  await expect(past.locator(".past-item__code")).toBeHidden();
  await past.locator("summary").click();
  await expect(past.locator(".past-item__code")).toHaveText("482913");

  await page.locator("details.body > summary").click();
  await expect(page.locator("#body-text")).toContainText("640218");
});

test("12) 「しないこと」3行・フッター・PWAの土台がある", async ({ page }) => {
  await page.goto("/");
  const promise = page.locator(".promise__list li");
  await expect(promise).toHaveCount(3);
  await expect(promise.nth(0)).toContainText("送信しません");
  await expect(promise.nth(1)).toContainText("消えます");
  await expect(promise.nth(2)).toContainText("外部に通信しません");

  const footerLinks = page.locator(".footer__nav a");
  await expect(footerLinks).toHaveCount(3);

  const head = await page.evaluate(() => ({
    manifest: document.querySelector('link[rel="manifest"]')?.getAttribute("href"),
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
    ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute("content"),
    ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute("content"),
    ogUrl: document.querySelector('meta[property="og:url"]')?.getAttribute("content"),
    twitter: document.querySelector('meta[name="twitter:card"]')?.getAttribute("content"),
    shareText: document.querySelector('meta[name="share:text"]')?.getAttribute("content"),
    inlineScripts: [...document.querySelectorAll("script")].filter((node) => !node.src).length,
    inlineStyles: document.querySelectorAll("style").length,
  }));
  expect(head.manifest).toBe("/manifest.webmanifest");
  /* 公開URLは docs/DEPLOY.md ⑦ で本人が置換する。置換前の目印を逐語で比べると、
     手順どおり置換した瞬間にテストが赤くなる（REVIEW-r1 I-8）。
     見るのは「絶対URLであること」と「og:image と og:url が canonical と同じオリジンであること」 */
  expect(head.canonical).toMatch(/^https:\/\/[^/\s]+\/$/);
  expect(head.ogUrl).toBe(head.canonical);
  expect(head.ogImage).toBe(`${head.canonical}og.png`);
  expect(head.ogTitle).toContain("捨てメール");
  expect(head.twitter).toBe("summary_large_image");
  expect(head.shareText).toContain("捨てメール");
  // CSP は self のみ。インラインの script / style を置かない（NFR-03）
  expect(head.inlineScripts).toBe(0);
  expect(head.inlineStyles).toBe(0);

  const serviceWorkerReady = await page.evaluate(() =>
    Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
    ]),
  );
  expect(serviceWorkerReady).toBe(true);
});
