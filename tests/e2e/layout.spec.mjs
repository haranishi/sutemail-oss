import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* 骨格の E2E（FIX r1）。`.agent-harness/SCORE-r1.md` の P1〜P25 と
   `docs/02_ux_design.md` ④骨格 を、数字で確かめられる形にしたもの。
   ここで守るのは「主行動は1つ」「受信後の並び」「到着してもずれない」「2段組」「680px」。 */

function fixture(name) {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
}

/* 発行はIPのハッシュごとに10回/時。テストごとに別のIPを名乗る（flow.spec.mjs と同じ理由）。 */
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
  return (await page.locator("#address").innerText()).trim();
}

async function inject(request, to, fixtureName, from) {
  const response = await request.post(
    `/api/dev/inject?to=${encodeURIComponent(to)}&from=${encodeURIComponent(from)}`,
    { headers: { "content-type": "message/rfc822" }, data: fixture(fixtureName) },
  );
  expect(response.status()).toBe(202);
}

/** 要素の上端（スクロール込み）。到着の前後で比べる */
function topOf(page, selector) {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return Math.round((rect.top + window.scrollY) * 100) / 100;
  }, selector);
}

test("18) 受信後に青の塗りボタンは「コードをコピー」1つだけ（P1）", async ({ page, request }) => {
  const address = await issueAddress(page);
  // 待受のあいだはアドレスのコピーが主行動
  await expect(page.locator("main .btn--primary")).toHaveCount(1);
  await expect(page.locator("#copy-address")).toHaveClass(/btn--primary/);

  await inject(request, address, "supabase-plain.eml", "noreply@supabase.com");
  await expect(appMain(page)).toHaveAttribute("data-state", "received", { timeout: 6000 });

  const primary = page.locator("main .btn--primary");
  await expect(primary).toHaveCount(1);
  await expect(primary).toHaveText("コードをコピー");
  // アドレス側は白抜きに降格。高さと全幅は保つ（タップ目標を削らない）
  const copyAddress = page.locator("#copy-address");
  await expect(copyAddress).not.toHaveClass(/btn--primary/);
  const box = await copyAddress.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(48);
  const face = await copyAddress.evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, color: style.color, border: style.borderTopColor, width: style.borderTopWidth };
  });
  expect(face.background).toBe("rgb(255, 255, 255)");
  expect(face.color).toBe("rgb(28, 31, 38)");
  expect(face.border).toBe("rgb(139, 148, 163)");
  expect(face.width).toBe("1px");

  // 未発行・期限切れの発行ボタンは青のまま
  await page.evaluate(() => localStorage.clear());
  await page.goto("/");
  await expect(appMain(page)).toHaveAttribute("data-state", "idle");
  await expect(page.locator("#issue")).toHaveClass(/btn--primary/);
});

test.describe("390px（iPhone相当）", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("19) 待受と受信で同じ並び・上端160px以内に出るコード（P2・P5・採点r2 TOP5-③）", async ({ page, request }) => {
    /* 並びは待受も受信も「残り時間 → 枠（#code-slot） → アドレスカード → 過去分と本文」で同じ。
       到着で入れ替わるのは枠の中身だけ（docs/02_ux_design.md ④）。 */
    const order = () => page.evaluate(() => {
      const wanted = ["#remaining", "#code-slot", "section.card[aria-label='使い捨てアドレス']", "#msg-extras"];
      const nodes = [...document.querySelectorAll("main#app > *")];
      return wanted.map((selector) => nodes.findIndex((node) => node.matches(selector)));
    });

    const address = await issueAddress(page);
    expect(await order()).toEqual([0, 1, 2, 3]);
    // 待受のあいだ、いちばん大きい要素はアドレス（採点r2 TOP5-③の「ヒーローは動かさない」）
    await expect(page.locator("main [data-hero]")).toHaveCount(1);
    await expect(page.locator("#address")).toHaveAttribute("data-hero", "true");

    await inject(request, address, "supabase-plain.eml", "noreply@supabase.com");
    await expect(appMain(page)).toHaveAttribute("data-state", "received", { timeout: 6000 });

    // 並びは変わらない。ヒーローだけがアドレス → コードに移る
    expect(await order()).toEqual([0, 1, 2, 3]);
    await expect(page.locator("main [data-hero]")).toHaveCount(1);
    await expect(page.locator(".code")).toHaveAttribute("data-hero", "true");

    // カードの中は コード → 送信元・件名・受信 → コードをコピー
    const inside = await page.evaluate(() => {
      const card = document.getElementById("latest-message");
      const y = (sel) => card.querySelector(sel).getBoundingClientRect().top;
      return { code: y(".code"), meta: y(".meta"), button: y("#copy-code") };
    });
    expect(inside.code).toBeLessThan(inside.meta);
    expect(inside.meta).toBeLessThan(inside.button);

    // 急いでいる利用者が最初に見るのはコード。上端から160px以内に出す
    const code = await page.locator(".code").boundingBox();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(code.y).toBeLessThanOrEqual(160);
  });

  test("20) 到着しても下の要素が1pxも動かない（P8・P9）", async ({ page, request }) => {
    // 報告欄は60秒たってから出る（P10）ので、先に出してから比べる
    await page.clock.install({ time: new Date() });
    const address = await issueAddress(page);
    await page.clock.runFor(60000);
    await expect(page.locator("#report")).toBeVisible();

    // 待受のあいだもコードの居場所がある
    const frame = page.locator("#code-slot.slot--waiting .slot__frame");
    await expect(frame).toBeVisible();
    await expect(frame).toContainText("認証コードはここに大きく出ます");
    await expect(frame).toContainText("秒ごとに確認しています");
    const frameStyle = await frame.evaluate((node) => {
      const style = getComputedStyle(node);
      return { style: style.borderTopStyle, width: style.borderTopWidth };
    });
    expect(frameStyle.style).toBe("dashed");
    // 宣言は1.5px。使用値は端末の画素に丸められるので範囲で見る
    expect(Number.parseFloat(frameStyle.width)).toBeGreaterThanOrEqual(1);
    expect(Number.parseFloat(frameStyle.width)).toBeLessThanOrEqual(2);

    /* 枠のすぐ下（アドレスカード）から画面の最後まで、1pxも動かないことを見る。
       r1 は #report より下だけを見ていたので、アドレスカードが 72px 動くのを見逃していた */
    const anchors = ["section.card[aria-label='使い捨てアドレス']", "#msg-extras", "#report", ".promise", ".footer"];
    const before = {};
    for (const selector of anchors) before[selector] = await topOf(page, selector);
    const slotBefore = await page.locator("#code-slot").boundingBox();
    const frameBefore = await frame.boundingBox();

    await inject(request, address, "supabase-plain.eml", "noreply@supabase.com");
    // 時計を止めているのでポーリングのタイマーは手で進める
    for (let i = 0; i < 20 && (await appMain(page).getAttribute("data-state")) !== "received"; i += 1) {
      await page.clock.runFor(3000);
      await page.waitForTimeout(200);
    }
    await expect(appMain(page)).toHaveAttribute("data-state", "received");
    await expect(page.locator(".code")).toHaveText("482913");

    for (const selector of anchors) {
      expect(await topOf(page, selector), `${selector} が到着で動いた`).toBe(before[selector]);
    }
    // 入れ替わったのは枠の中身だけ。枠そのものの位置と大きさは変えない
    await expect(page.locator("#code-slot.slot--filled")).toHaveCount(1);
    const slotAfter = await page.locator("#code-slot").boundingBox();
    expect(slotAfter.y).toBe(slotBefore.y);
    expect(slotAfter.height).toBe(slotBefore.height);

    /* 枠は「認証コードはここに大きく出ます」と場所を約束する。実際にそこへ出ることを見る
       （採点r2 W1＝約束した位置から約300px上に出ていた）。実測の差は3.7px */
    const code = await page.locator(".code").boundingBox();
    expect(Math.abs(code.y - frameBefore.y), "枠の上端とコードの上端のずれ").toBeLessThanOrEqual(8);
    expect(code.y + code.height).toBeLessThanOrEqual(frameBefore.y + frameBefore.height);
  });

  test("21) 案内文が次のカードに重ならない（設計者の目視所見）", async ({ page }) => {
    await page.goto("/");
    await expect(appMain(page)).toHaveAttribute("data-state", "idle");

    /* r2 の waiting-390 で、<main> の最後にある p.hint の最終行が #report の上辺に接していた。
       原因は p.hint に margin-bottom が無く、後ろの節にも margin-top が無かったこと。
       状態にかかわらず「<main> の最後の文と、その次に見える節」が重ならないことを見る。 */
    const gap = async () => page.evaluate(() => {
      const main = document.getElementById("app");
      const visible = [...main.querySelectorAll("p, ul, section, div")]
        .filter((node) => node.getBoundingClientRect().height > 0);
      const last = visible[visible.length - 1];
      const after = [...document.querySelectorAll("#report, .promise, #stats")]
        .filter((node) => !node.hidden && node.getBoundingClientRect().height > 0)[0];
      const lastRect = last.getBoundingClientRect();
      // 文字そのものの最終行で測る（行ボックスの余白ぶん甘くしない）
      const range = document.createRange();
      range.selectNodeContents(last);
      const rects = [...range.getClientRects()];
      const glyphBottom = rects.length > 0 ? rects[rects.length - 1].bottom : lastRect.bottom;
      return {
        tag: `${last.tagName}.${last.className}`,
        box: +(after.getBoundingClientRect().top - lastRect.bottom).toFixed(2),
        glyph: +(after.getBoundingClientRect().top - glyphBottom).toFixed(2),
      };
    });

    const idle = await gap();
    expect(idle.box, `idle: ${idle.tag} と次の節の間隔`).toBeGreaterThanOrEqual(16);
    expect(idle.glyph).toBeGreaterThan(16);

    await page.getByRole("button", { name: "使い捨てアドレスを発行" }).click();
    await expect(appMain(page)).toHaveAttribute("data-state", "waiting");
    const waiting = await gap();
    expect(waiting.box, `waiting: ${waiting.tag} と次の節の間隔`).toBeGreaterThanOrEqual(16);
    expect(waiting.glyph).toBeGreaterThan(16);
  });

  test("22) 実績表は390pxで2段組になる（P13）", async ({ page }) => {
    // 実績は KV に貯まる本番データなので、並びを確かめる回は応答を固定する
    await page.route("**/api/stats/top", (route) =>
      route.fulfill({
        json: { stats: [{ host: "e2e-54z0ox8f.example.com", ok: 3, ng: 1 }] },
        headers: { "cache-control": "no-store" },
      }),
    );
    await page.goto("/");
    await expect(appMain(page)).toHaveAttribute("data-state", "idle");

    const row = page.locator(".stats__table tbody tr").first();
    await expect(row).toBeVisible();
    const host = row.locator("th[scope='row']");
    const counts = row.locator("td");

    const boxes = await page.evaluate(() => {
      const tr = document.querySelector(".stats__table tbody tr");
      const rect = (node) => { const b = node.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, width: b.width, left: b.left, right: b.right }; };
      return {
        row: rect(tr),
        host: rect(tr.querySelector("th[scope='row']")),
        first: rect(tr.querySelectorAll("td")[0]),
        last: rect(tr.querySelectorAll("td")[1]),
        lines: tr.querySelector("th[scope='row']").getClientRects().length,
      };
    });
    // 1段目＝ホスト名が全幅で1行に収まる（単語の途中で1文字だけ残らない）
    expect(boxes.lines).toBe(1);
    expect(boxes.host.width).toBeCloseTo(boxes.row.width, 0);
    // 2段目＝件数がホスト名より下にあり、右端に寄っている
    expect(boxes.first.top).toBeGreaterThanOrEqual(boxes.host.bottom);
    expect(boxes.last.right).toBeCloseTo(boxes.row.right, 0);
    await expect(host).toHaveText("e2e-54z0ox8f.example.com");
    await expect(counts.nth(0)).toHaveText("届いた 3件");
    await expect(counts.nth(1)).toHaveText("届かない 1件");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("23) 更新と新しいアドレスで詰まらずに済む（P11）＋残り1分で太字（P12）", async ({ page }) => {
    // 時計を止めると自動ポーリングも止まるので、「更新」で本当に取りに行くかが見える
    await page.clock.install({ time: new Date() });
    const polls = [];
    page.on("request", (request) => {
      if (request.url().includes("/messages")) polls.push(request.url());
    });
    const first = await issueAddress(page);

    await page.clock.runFor(50); // 発行直後の1回目を流す
    await expect.poll(() => polls.length).toBeGreaterThan(0);
    const before = polls.length;

    // 「更新」は次の3秒を待たずにその場で取りに行く。状態は変わらない
    await page.locator("#poll-now").click();
    await page.clock.runFor(50);
    await expect.poll(() => polls.length, { timeout: 5000 }).toBeGreaterThan(before);
    await expect(appMain(page)).toHaveAttribute("data-state", "waiting");
    await expect(page.locator("#address")).toHaveText(first);

    // 残り1分を切ると太字になる（色は変えない）
    const weightBefore = await page.locator("#remaining-value").evaluate((node) => getComputedStyle(node).fontWeight);
    const colorBefore = await page.locator("#remaining-value").evaluate((node) => getComputedStyle(node).color);
    await page.clock.runFor(541000); // 10分のうち9分1秒を進める＝残り59秒
    await expect(page.locator("#remaining")).toHaveClass(/remaining--soon/);
    const weightAfter = await page.locator("#remaining-value").evaluate((node) => getComputedStyle(node).fontWeight);
    const colorAfter = await page.locator("#remaining-value").evaluate((node) => getComputedStyle(node).color);
    expect(Number(weightAfter)).toBeGreaterThan(Number(weightBefore));
    expect(colorAfter).toBe(colorBefore);

    /* 「新しいアドレス」は隣の「更新」と役割が正反対なので、見た目で分けて確認を1段はさむ
       （採点r2 TOP5-⑤・W5）。押せる範囲どうしを16px以上あけ、破棄する側は青を持たない */
    const spacing = await page.evaluate(() => {
      const poll = document.getElementById("poll-now").getBoundingClientRect();
      const fresh = document.getElementById("new-address").getBoundingClientRect();
      return { gap: +(fresh.left - poll.right).toFixed(2), sameRow: Math.abs(fresh.top - poll.top) < 1 };
    });
    expect(spacing.sameRow).toBe(true);
    expect(spacing.gap).toBeGreaterThanOrEqual(16);
    const pollColor = await page.locator("#poll-now").evaluate((node) => getComputedStyle(node).color);
    const freshColor = await page.locator("#new-address").evaluate((node) => getComputedStyle(node).color);
    expect(freshColor).not.toBe(pollColor);
    expect(freshColor).toBe("rgb(91, 100, 114)"); // --muted（地色に 5.58:1）

    // 取り消したら、いまのアドレスは消えない
    await page.clock.setSystemTime(new Date());
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator("#new-address").click();
    await page.waitForTimeout(500);
    await expect(page.locator("#address")).toHaveText(first);

    // 承諾したときだけ置き換える。localStorage の1件も入れ替わる
    page.once("dialog", (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain("新しいアドレスを発行します");
      dialog.accept();
    });
    await page.locator("#new-address").click();
    // 破棄 → 発行の2往復があるので、アドレスが入れ替わるまで待つ
    await expect
      .poll(async () => {
        if ((await page.locator("#address").count()) === 0) return "";
        const text = (await page.locator("#address").innerText()).trim();
        return text === first ? "" : text;
      }, { timeout: 10000 })
      .toMatch(/^[a-z2-9]{10}@sutemail\.test$/);
    await expect(appMain(page)).toHaveAttribute("data-state", "waiting");
    const second = (await page.locator("#address").innerText()).trim();
    expect(second).not.toBe(first);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("sutemail.v1")));
    expect(second.startsWith(`${stored.local}@`)).toBe(true);
  });

  test("24) シェアボタンは48px以上・罫線は副次ボタンより濃くない（P20・P21）", async ({ page }) => {
    await page.goto("/");
    const buttons = page.locator("#share .share__button");
    expect(await buttons.count()).toBeGreaterThanOrEqual(3);
    const seen = await buttons.evaluateAll((nodes) =>
      nodes.map((node) => ({
        height: node.getBoundingClientRect().height,
        border: getComputedStyle(node).borderTopColor,
      })),
    );
    // #8b94a3（--control-line）と同じか、それより薄いこと
    const limit = 0x8b + 0x94 + 0xa3;
    for (const item of seen) {
      expect(item.height).toBeGreaterThanOrEqual(48);
      const [r, g, b] = item.border.match(/\d+/g).map(Number);
      expect(r + g + b).toBeGreaterThanOrEqual(limit);
    }
  });

  test("26) プライバシーの表は390pxで縦積みになり「保存期間」が読める（採点r2 TOP5-①）", async ({ page }) => {
    await page.goto("/privacy.html");

    // 横スクロールが出ない（3列目が画面の外に出ない）
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const scroller = await page.evaluate(() => {
      const node = document.querySelector(".doc__scroll");
      return { scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
    });
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);

    // 1行＝1ブロックの縦積み。列見出しは各セルの前にラベルとして出る
    const rows = await page.evaluate(() => {
      const cells = [...document.querySelectorAll(".doc__table tbody td")];
      return cells.map((cell) => {
        const box = cell.getBoundingClientRect();
        return {
          label: cell.getAttribute("data-label"),
          before: getComputedStyle(cell, "::before").content,
          display: getComputedStyle(cell).display,
          right: +box.right.toFixed(2),
          clipped: cell.scrollWidth > cell.clientWidth + 1,
        };
      });
    });
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const keep = rows.filter((row) => row.label === "保存期間");
    expect(keep.length).toBe(5); // 5行すべてに保存期間がある
    for (const cell of rows) {
      expect(cell.display).toBe("block");
      expect(cell.before).toBe(`"${cell.label}："`);
      expect(cell.right).toBeLessThanOrEqual(390);
      expect(cell.clipped).toBe(false);
    }
    // 見出し行（thead）は縦積みでは重複するので隠す
    await expect(page.locator(".doc__table thead")).toBeHidden();
  });
});

test.describe("1440px（ノートPC）", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("25) 本文幅680pxとコードカードの2カラム（P3・P15）", async ({ page, request }) => {
    const address = await issueAddress(page);
    const width = await page.locator("main#app").evaluate((node) => node.getBoundingClientRect().width);
    expect(width).toBe(680);

    await inject(request, address, "supabase-plain.eml", "noreply@supabase.com");
    await expect(appMain(page)).toHaveAttribute("data-state", "received", { timeout: 6000 });

    const columns = await page.evaluate(() => {
      const card = document.getElementById("latest-message");
      const rect = (sel) => { const b = card.querySelector(sel).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, width: b.width }; };
      return { card: card.getBoundingClientRect(), code: rect(".code"), meta: rect(".meta"), button: rect("#copy-code") };
    });
    // 左＝コード（中央寄せ）／右＝送信元・件名・受信。行が重なる＝2カラム
    expect(columns.code.right).toBeLessThanOrEqual(columns.meta.left);
    expect(columns.meta.top).toBeLessThan(columns.button.top);
    expect(columns.code.width).toBeLessThan(columns.card.width * 0.6);
    expect(columns.meta.width).toBeGreaterThan(columns.card.width * 0.25);
    const align = await page.locator(".code").evaluate((node) => getComputedStyle(node).textAlign);
    expect(align).toBe("center");

    /* 右列の文字がカードの右端まで届く（採点r2 R2）。1fr 1fr のときは
       いちばん右の文字が x=974・カード内側の右端が x=1044 で、約85pxが未使用だった */
    const unusedRight = await page.evaluate(() => {
      const card = document.getElementById("latest-message");
      const inner = card.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(card).paddingRight);
      const range = document.createRange();
      let rightmost = 0;
      for (const dd of card.querySelectorAll(".meta dd")) {
        range.selectNodeContents(dd);
        for (const rect of range.getClientRects()) rightmost = Math.max(rightmost, rect.right);
      }
      return +(inner - rightmost).toFixed(2);
    });
    expect(unusedRight).toBeLessThanOrEqual(24);

    // 「いちばん大きいのはコード」は2カラムでも変わらない
    await expect(page.locator("main [data-hero]")).toHaveCount(1);
    await expect(page.locator(".code")).toHaveAttribute("data-hero", "true");
  });
});

test("27) コードカードのボタン下に空白が残らない（採点r2 TOP5-④・R1）", async ({ page, request }) => {
  /* --slot-h（コードの居場所として先に取る高さ）の余りがカードの内側に溜まり、
     「コードをコピー」の下に 58px（390）／47px（768）／34px（1440）の白地が残っていた。
     余りはカードの外に出し、予約は実測に寄せる。カードの下余白はアドレスカードと同じ16px相当に揃える。 */
  await page.setViewportSize({ width: 390, height: 844 });
  const address = await issueAddress(page);
  await inject(request, address, "supabase-plain.eml", "noreply@supabase.com");
  await expect(appMain(page)).toHaveAttribute("data-state", "received", { timeout: 6000 });

  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const seen = await page.evaluate(() => {
      const card = document.getElementById("latest-message");
      const button = document.getElementById("copy-code");
      const address = document.querySelector("section.card[aria-label='使い捨てアドレス']");
      const copy = document.getElementById("copy-address");
      const slot = document.getElementById("code-slot");
      const box = (node) => node.getBoundingClientRect();
      return {
        code: +(box(card).bottom - box(button).bottom).toFixed(2),
        // 比較対象＝同じ形のアドレスカード（採点r2 は「約3倍の差」を問題にした）
        address: +(box(address).bottom - box(copy).bottom).toFixed(2),
        // 予約の余りは枠（カードの外）に出る。多すぎると今度はカードの下が空いて見える
        slack: +(box(slot).bottom - box(card).bottom).toFixed(2),
      };
    });
    expect(seen.code, `${width}px: ボタン下端とカード下端の差`).toBeLessThanOrEqual(24);
    expect(seen.code, `${width}px: アドレスカードとの差`).toBeLessThanOrEqual(seen.address + 4);
    expect(seen.slack, `${width}px: 予約の余り`).toBeGreaterThanOrEqual(0);
    expect(seen.slack, `${width}px: 予約の余り`).toBeLessThanOrEqual(24);
  }
});
