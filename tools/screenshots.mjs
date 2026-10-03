#!/usr/bin/env node
/*
  採点用のスクリーンショットを撮る。

    node tools/screenshots.mjs --round 3
    node tools/screenshots.mjs --round 3 --port 8797   # 8788 が塞がっているとき

  .agent-harness/shots/r<N>/ に保存する。撮るもの:

    <state>-<width>.png        4状態 × 3幅（390 / 768 / 1440）のビューポートぶん（素のまま）
    <state>-<width>-full.png   同じくページ全体（position: fixed / sticky を隠してから撮る）
    <state>-390-dark.png       4状態のダーク版（採点r1 P24）
    <state>-390-focus.png      各状態で Tab を1回押したフォーカスリング（採点r1 P22）
    <page>-<width>.png         静的3ページ（terms / privacy / external-transmission）を
    <page>-<width>-full.png    390 と 1440 で（採点r1 P25）

  wrangler dev が動いていなければ自分で起動し、終わったら自分で止める。
  すでに動いていれば借りるだけで、止めない。git・deploy・外部通信はしない（AGENTS.md）。
*/
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const SIZES = [
  { width: 390, height: 844 }, // iPhone 相当
  { width: 768, height: 1024 }, // タブレット縦
  { width: 1440, height: 900 }, // ノートPC
];
const STATES = ["idle", "waiting", "received", "expired"];
// 静的ページ（項目8「静的ページとの一貫性」の判定材料。採点r1 P25）
const DOCS = [
  { path: "/terms", name: "terms" },
  { path: "/privacy", name: "privacy" },
  { path: "/external-transmission", name: "external-transmission" },
];
const DOC_SIZES = [SIZES[0], SIZES[2]];

/* 発行は IP のハッシュごとに10回/時。撮り直しで 429 に当たらないよう、
   組ごとに別のIPを名乗る（198.18.0.0/15 はベンチマーク用の予約帯）。 */
function benchmarkIp() {
  const value = Math.floor(Math.random() * 0x10000);
  return `198.18.${(value >> 8) & 0xff}.${value & 0xff}`;
}

function readOption(argv, name) {
  const index = argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index === -1) return null;
  return argv[index].includes("=") ? argv[index].split("=")[1] : argv[index + 1];
}

function parseRound(argv) {
  const raw = readOption(argv, "round");
  if (raw === null) return 1;
  const round = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(round) || round < 1) throw new Error(`--round は1以上の整数: ${raw}`);
  return round;
}

/* 8788 は別のプロジェクトが握っていることがある（実際に起きた。runs/2026-09-05-C3b.md）。
   そのときは --port で逃がす。起動・停止・空き確認はすべてこの番号で行う。 */
function parsePort(argv) {
  const raw = readOption(argv, "port");
  if (raw === null) return 8788;
  const port = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`--port は1024〜65535の整数: ${raw}`);
  }
  return port;
}

const PORT = parsePort(process.argv.slice(2));
const BASE = `http://127.0.0.1:${PORT}`;

async function ping() {
  try {
    const response = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/* 応答が止まってもソケットを掴んだままの workerd が残ることがある。HTTP の生死ではなく
   TCP で確かめる。ここを見落とすと、残骸が .wrangler/state の SQLite を握ったままになり、
   次に起動した wrangler dev が SQLITE_BUSY で落ちる（実際に E2E を巻き込んで落とした）。 */
function portInUse() {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port: PORT });
    const finish = (result) => {
      socket.destroy();
      done(result);
    };
    socket.setTimeout(2000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitFor(predicate, { timeout, label }) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`待ち時間を超えた: ${label}`);
}

/** wrangler dev を用意する。自分で起動したときだけ停止関数を返す */
async function ensureServer() {
  if (await ping()) {
    console.log(`既に :${PORT} が応答しているので、そのまま使う（このスクリプトでは止めない）`);
    return null;
  }
  if (await portInUse()) {
    throw new Error(
      `:${PORT} は塞がっているのに /api/config が応答しない。前の wrangler dev の残骸が` +
        ` .wrangler/state を握っている可能性が高い。\`lsof -i :${PORT}\` で確認して片付けてから、もう一度実行する`,
    );
  }
  console.log(`:${PORT} が空いているので wrangler dev を起動する`);
  const child = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], {
    cwd: root,
    // wrangler は workerd を孫プロセスとして持つ。まとめて畳めるよう別のプロセスグループにする
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_LOG_PATH: ".wrangler/logs",
      WRANGLER_REGISTRY_PATH: ".wrangler/registry",
    },
  });

  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* すでに終わっている */
    }
  };
  // 途中で落ちても残骸を置いていかない（detached の子は親の終了では死なない）
  const onExit = () => killGroup("SIGKILL");
  process.on("exit", onExit);

  try {
    await waitFor(ping, { timeout: 60000, label: "wrangler dev の起動" });
  } catch (error) {
    killGroup("SIGKILL");
    process.off("exit", onExit);
    throw error;
  }
  console.log("wrangler dev が応答した");

  return async () => {
    const exited = new Promise((done) => child.once("exit", () => done(true)));
    killGroup("SIGTERM");
    const stopped = await Promise.race([
      exited,
      new Promise((done) => setTimeout(() => done(false), 8000)),
    ]);
    // SIGTERM で畳み切れないことがある。ソケットと SQLite を握ったまま残るので、必ず止める
    if (!stopped) {
      console.log("SIGTERM で終わらなかったので SIGKILL する");
      killGroup("SIGKILL");
      await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))]);
    }
    await waitFor(async () => !(await portInUse()), { timeout: 15000, label: `${PORT} の解放` });
    process.off("exit", onExit);
    console.log(`wrangler dev を止めた（${PORT} は解放済み）`);
  };
}

const appState = (state) => `main#app[data-state="${state}"]`;

/** 字形が確定してから撮る */
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300); // Node 側のタイマー。page.clock を入れていても効く
}

/* fullPage は position: fixed / sticky の要素をスクロール位置ぶん焼き込むので、
   全体図のときだけ見えなくする。ビューポート版は素のまま撮る。 */
async function hideFixed(page) {
  const hidden = await page.evaluate(() => {
    window.__sutemailFixed = [];
    for (const node of document.querySelectorAll("body *")) {
      const position = getComputedStyle(node).position;
      if (position !== "fixed" && position !== "sticky") continue;
      window.__sutemailFixed.push([node, node.style.visibility]);
      node.style.visibility = "hidden";
    }
    return window.__sutemailFixed.length;
  });
  return {
    hidden,
    async restore() {
      await page.evaluate(() => {
        for (const [node, visibility] of window.__sutemailFixed ?? []) node.style.visibility = visibility;
        window.__sutemailFixed = [];
      });
    },
  };
}

/** 目当ての状態まで進めたページを作る。状態の作り方は runs/2026-09-05-C2a.md に従う */
async function openState(browser, state, size, { dark }) {
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    colorScheme: dark ? "dark" : "light",
    extraHTTPHeaders: { "CF-Connecting-IP": benchmarkIp() },
  });
  const page = await context.newPage();

  // 時計は goto より前に差し替える（あとからだと起動時の失効時刻が実時間のままになる）
  if (state === "expired") await page.clock.install({ time: new Date() });

  await page.goto("/");
  await page.waitForSelector(appState("idle"), { timeout: 15000 });

  if (state !== "idle") {
    await page.getByRole("button", { name: "使い捨てアドレスを発行" }).click();
    await page.waitForSelector(appState("waiting"), { timeout: 15000 });
  }

  if (state === "received") {
    const address = (await page.locator("#address").innerText()).trim();
    const raw = await readFile(resolve(root, "tests/fixtures/supabase-plain.eml"));
    const query = `to=${encodeURIComponent(address)}&from=${encodeURIComponent("noreply@supabase.com")}`;
    const response = await context.request.post(`/api/dev/inject?${query}`, {
      headers: { "content-type": "message/rfc822" },
      data: raw,
    });
    if (response.status() !== 202) {
      throw new Error(`メールの投入に失敗した（${response.status()}）: ${await response.text()}`);
    }
    // 画面のポーリングは3秒間隔。1周ぶんと往復の余裕を見る
    await page.waitForSelector(appState("received"), { timeout: 10000 });
  }

  if (state === "expired") {
    await page.clock.fastForward("11:00"); // 失効は10分
    await page.waitForSelector(appState("expired"), { timeout: 15000 });
  }

  await settle(page);
  return { context, page };
}

async function main() {
  const round = parseRound(process.argv.slice(2));
  const outDir = resolve(root, ".agent-harness/shots", `r${round}`);
  await mkdir(outDir, { recursive: true });

  const stopServer = await ensureServer();
  const browser = await chromium.launch();
  const saved = [];

  const shoot = async (page, name, { fullPage }) => {
    const path = resolve(outDir, name);
    await page.screenshot({ path, fullPage, scale: "css" });
    saved.push(name);
    console.log(`  ${name}`);
  };

  try {
    console.log(`\n撮影先: .agent-harness/shots/r${round}/`);
    for (const state of STATES) {
      for (const size of SIZES) {
        const { context, page } = await openState(browser, state, size, { dark: false });
        try {
          await shoot(page, `${state}-${size.width}.png`, { fullPage: false });
          const fixed = await hideFixed(page);
          await shoot(page, `${state}-${size.width}-full.png`, { fullPage: true });
          await fixed.restore();
        } finally {
          await context.close();
        }
      }
    }

    // ダークモードは4状態とも撮る（採点r1 P24。r2 は received の1枚しか無く判定できなかった）
    for (const state of STATES) {
      const { context, page } = await openState(browser, state, SIZES[0], { dark: true });
      try {
        await shoot(page, `${state}-390-dark.png`, { fullPage: false });
      } finally {
        await context.close();
      }
    }

    /* キーボードで最初に触れる部品のフォーカスリング（採点r1 P22）。
       r2 は1枚も無く、項目9の判定材料が揃わなかった。Tab を1回だけ押した姿を撮る。 */
    for (const state of STATES) {
      const { context, page } = await openState(browser, state, SIZES[0], { dark: false });
      try {
        await page.keyboard.press("Tab");
        const focused = await page.evaluate(() => {
          const node = document.activeElement;
          if (!node || node === document.body) return "(なし)";
          return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""} ${(node.textContent ?? "").trim().slice(0, 16)}`;
        });
        await settle(page);
        await shoot(page, `${state}-390-focus.png`, { fullPage: false });
        console.log(`    Tab 1回で ${focused} に入った`);
      } finally {
        await context.close();
      }
    }

    // 静的3ページ（採点r1 P25。項目8「静的ページとの一貫性」の判定材料）
    for (const doc of DOCS) {
      for (const size of DOC_SIZES) {
        const context = await browser.newContext({
          baseURL: BASE,
          viewport: { width: size.width, height: size.height },
          deviceScaleFactor: 1,
        });
        const page = await context.newPage();
        try {
          await page.goto(doc.path);
          await page.waitForSelector("main.doc h1");
          await settle(page);
          await shoot(page, `${doc.name}-${size.width}.png`, { fullPage: false });
          const fixed = await hideFixed(page);
          await shoot(page, `${doc.name}-${size.width}-full.png`, { fullPage: true });
          await fixed.restore();
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    if (stopServer) await stopServer();
  }

  console.log(`\n合計 ${saved.length} 枚`);
}

await main();
