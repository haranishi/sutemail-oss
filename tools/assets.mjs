#!/usr/bin/env node
/*
  OGP画像とアプリアイコンを生成する。

    node tools/assets.mjs

  @playwright/test 同梱の chromium で tools/*-template.html を開き、ビューポートぶんを
  そのまま PNG にする。外部フォント・外部画像・CDN は使わない（AGENTS.md）。
  生成物は public/ に置き、最後に index.html と manifest.webmanifest の参照が
  実在するファイルを指しているかを突き合わせて表示する。
*/
import { chromium } from "@playwright/test";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** 原稿と出力の対応。幅・高さがそのまま PNG の画素数になる */
const targets = [
  { template: "og-template.html", out: "public/og.png", width: 1200, height: 630 },
  { template: "icon-template.html", out: "public/icons/icon-192.png", width: 192, height: 192 },
  { template: "icon-template.html", out: "public/icons/icon-512.png", width: 512, height: 512 },
  { template: "icon-template.html", out: "public/apple-touch-icon.png", width: 180, height: 180 },
];

/** PNG のヘッダー（IHDR）から実際の画素数を読む。sips に頼らず自分で検算するため */
async function pngSize(path) {
  const buffer = await readFile(path);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error(`PNG ではない: ${path}`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length };
}

async function render(browser, target) {
  const page = await browser.newPage({
    viewport: { width: target.width, height: target.height },
    deviceScaleFactor: 1,
    colorScheme: "light", // 共有先のサムネは1枚しか持てないのでライト固定
  });
  const template = pathToFileURL(resolve(here, target.template)).href;
  await page.goto(template, { waitUntil: "load" });
  // 日本語のシステムフォントが載り切る前に撮ると字形が変わるので、必ず待つ
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);

  const out = resolve(root, target.out);
  await mkdir(dirname(out), { recursive: true });
  await page.screenshot({ path: out, type: "png", scale: "css" });
  await page.close();

  const size = await pngSize(out);
  if (size.width !== target.width || size.height !== target.height) {
    throw new Error(
      `画素数が指定と違う: ${target.out} は ${size.width}×${size.height}（期待 ${target.width}×${target.height}）`,
    );
  }
  console.log(`  ${target.out.padEnd(28)} ${size.width}×${size.height}  ${size.bytes} bytes`);
}

/** index.html と manifest.webmanifest が指している画像パスを集める */
async function referencedImages() {
  const html = await readFile(resolve(root, "public/index.html"), "utf8");
  const manifest = JSON.parse(await readFile(resolve(root, "public/manifest.webmanifest"), "utf8"));
  const paths = new Set();
  for (const match of html.matchAll(/(?:href|content)="([^"]*\.png)"/g)) {
    // og:image は絶対URL。パス部分だけ見る
    paths.add(match[1].replace(/^https?:\/\/[^/]+/, ""));
  }
  for (const icon of manifest.icons ?? []) paths.add(icon.src);
  return [...paths].sort();
}

async function main() {
  const browser = await chromium.launch();
  try {
    console.log("生成:");
    for (const target of targets) await render(browser, target);
  } finally {
    await browser.close();
  }

  console.log("\n参照の突き合わせ（index.html・manifest.webmanifest → public/）:");
  let missing = 0;
  for (const path of await referencedImages()) {
    const file = resolve(root, "public", path.replace(/^\//, ""));
    const exists = await stat(file).then(() => true, () => false);
    if (!exists) missing += 1;
    console.log(`  ${exists ? "OK  " : "無し"} ${path}`);
  }
  if (missing > 0) throw new Error(`参照されているのに存在しない画像が ${missing} 件ある`);
}

await main();
