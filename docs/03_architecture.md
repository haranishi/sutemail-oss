# 技術設計 v1（sutemail）

## 1. 構成と採用理由
- **Cloudflare Workers 1本**（TypeScript）に `fetch`（API＋静的アセット）と `email`（受信）を同居。Email Routing の catch-all → Worker が唯一の受信経路。追加のメールサーバー・別ホスティング不要（費用$0）。
- **Workers Static Assets**（`assets.directory="./public"`, `run_worker_first: true`）でPWAを配信。フレームワーク不使用（vanilla JS）。`run_worker_first` を全リクエストにしているのは、静的アセットの応答へ CSP を Worker から載せるため（→ §6）。静的配信もリクエスト数に数えられるので、Free の1日10万リクエストはここに効く。
- **KV `INBOX`** に `expirationTtl` 付きで保存。自動消滅が要件の中心なので、TTLの無い D1/R2 より合う。結果整合の遅れは数秒ごとのポーリングで吸収するが、`get` のエッジキャッシュぶん（最大30秒）は残る（→ §3）。
- **postal-mime**（MIT-0）で MIME 解析、Workers組み込み **HTMLRewriter** で HTML→テキスト＋`a[href]`。html-to-text は Node 依存が増えるので不採用。
- **@block65/webcrypto-web-push**（MIT・WebCryptoのみ）で Web Push。Node 専用の web-push は不採用。
- シェア導線は作者の自作コードを `public/shared/` に同梱する。

## 2. モジュール
```
src/worker.ts          export default { fetch, email }
src/handlers/email.ts  受信: サイズ判定→宛先照合→解析→抽出→保存→通知
src/handlers/api.ts    ルーター（手書き）と各エンドポイント
src/lib/extract.ts     コード・リンク抽出（純関数。入力: subject/text/links）
src/lib/html-text.ts   HTMLRewriter で text と links を得る
src/lib/address.ts     ローカル部生成・検証、token生成・ハッシュ・定数時間比較
src/lib/store.ts       KV アクセス（キー設計をここに閉じ込める）
src/lib/ratelimit.ts   IPハッシュとスライディング窓カウンタ
src/lib/push.ts        Declarative Web Push の JSON 組み立てと送信
src/lib/env.ts         数値varsの読み出し（欠落・NaN・範囲外を既定値へ倒す）とTurnstileの有効判定
src/lib/headers.ts     CSP・nosniff・Referrer-Policy の組み立てと付与
public/                index.html app.js app.css sw.js manifest.webmanifest
public/shared/         share.js share.css（作者の自作共有コード）
public/{terms,privacy,external-transmission}.html
tests/unit/*.test.ts   vitest（@cloudflare/vitest-pool-workers）
tests/fixtures/*.eml   Message-ID 付き
tests/e2e/*.spec.mjs   Playwright（webServer = wrangler dev）
tools/screenshots.mjs  390/768/1440 の状態別スクショ → .agent-harness/shots/
```

## 3. KV キー設計
| キー | 値 | TTL |
|---|---|---|
| `addr:<local>` | `{tokenHash, createdAt, expiresAt, pushSub?, reportedHosts?, pushSent?}` | `ADDRESS_TTL_SECONDS` |
| `idx:<local>` | `{messages:[{key, receivedAt, id}]}`（受信済みメッセージの索引） | `addr:` と同じ |
| `msg:<local>:<receivedAtMs>-<rand4>` | `{id, from, subject, receivedAt, codes[], links[], text}` | min(アドレス残り, `MESSAGE_TTL_SECONDS`)、下限60 |
| `rl:issue:<ipHash>` | 直近の発行時刻の配列（上限 `ISSUE_LIMIT_PER_HOUR` 件）。read-modify-write のため同時到着は素通りしうる。公開時は Turnstile を有効にすることが前提の防波堤（レビュー r2 N-3） | 3600 |
| `stat:<host>` | `{ok, ng, updatedAt}`（同じ値を KV `metadata` にも載せ、上位10件は `list()` 1回で並べる＝Free のサブリクエスト上限50件を避ける） | なし（個人情報を含まない集計） |
一覧は `idx:` の索引を受信時刻降順に並べ、本文は `get` で引く。**ポーリング経路で `list` を使わない**——3秒ごとの一覧で `kv.list` を1回ずつ走らせると、アドレス1本10分で約88回になり KV の list 無料枠を使い切るため。

**索引を `addr:` から独立した鍵に分けている理由**（レビュー r2 N-1）。当初は `addr:` の中に `messages` を持たせていたが、`addr:` は購読の保存・報告・`pushSent` でも read-modify-write する。受信の直前に読んだ `addr:` を受信の直後に書き戻すと索引ごと消え、**届いたメールが一覧から永久に出なくなる**（本文の鍵は KV に残るが索引から辿れない）。`idx:` を書くのは受信経路（`putMessage`）と `DELETE` の掃除だけにして、この経路を無くした。索引の書き込みは受信時の read-modify-write のままなので、同時受信の取りこぼしは MVP では許容する（索引から漏れた鍵は `DELETE` 時の `list` 掃除で拾う）。`pushSent` は1アドレスあたりの Push 送信回数で、20回で打ち切る。

**KV は get/list とも最大60秒の結果整合。ローカルでは再現不能。** `kv.get` は読んだコロで既定60秒キャッシュされるので、3秒ごとに同じ鍵を引く画面はキャッシュが切れるまで古い値を受け取り続ける（メールを書くのは別のコロで動く `email()` ハンドラ）。緩和として、ポーリング経路の読み取り（`idx:` と `msg:`）に `cacheTtl: 30`（現在の最小値・`POLL_CACHE_TTL`）を付け、最悪の遅れを60秒→30秒にした。**本番の疎通（DEPLOY ⑨）で発行→受信→表示の秒数を10回測り、中央値が10秒を超えるなら Durable Object へ移す**（強整合にすれば遅れは消えるが、KV より高く、10分で消える箱に持たせるには重い）。

## 4. API
| メソッド/パス | 認証 | 応答 |
|---|---|---|
| `GET /api/config` | なし | `{mailDomain, addressTtlSeconds, push, turnstileSiteKey?}` |
| `POST /api/address` | なし（Turnstile任意） | 201 `{address, local, token, expiresAt}` ／ 429 `{error, retryAfter}` |
| `GET /api/address/:local` | Bearer | `{address, expiresAt, remainingSeconds, messageCount}` ／ 401・404・410 |
| `GET /api/address/:local/messages` | Bearer | `{messages:[{id, from, subject, receivedAt, codes:[{value, confidence}], links:[{host, url, label}], textPreview}]}` |
| `GET /api/address/:local/messages/:id` | Bearer | 上記＋`text` |
| `DELETE /api/address/:local` | Bearer | 204 |
| `POST/DELETE /api/address/:local/push` | Bearer | 204（P1） |
| `POST /api/report` | Bearer | 204（P1） `{local, host, result:"ok"|"ng"}`。`local` は必須（token からアドレスを逆引きしないため）。同一アドレス×同一 host の2回目は 204 だが数えない。1アドレス20ホストまで |
| `GET /api/stats?host=` `GET /api/stats/top` | なし | 集計（P1） |
| `POST /api/dev/inject?to=&from=` | なし | 202。`DEV_INJECT!=="1"` なら 404 |
エラーは `{error: string}`。`confidence` は high（ラベル近傍）/ medium（独立行）/ low（文脈なし。既定では非表示）。

## 5. 受信ハンドラの流れ
1. `message.rawSize > MAX_RAW_BYTES` → `setReject("Message too large")`
2. `local = message.to.split("@")[0].toLowerCase()`。形式不正・`addr:` 不在・失効 → `setReject("Mailbox unavailable")`
3. `PostalMime.parse(message.raw, {maxNestingDepth: 4, attachmentEncoding: "utf8"})`。添付は捨てる
4. text優先、無ければ `html-text.ts`。20,000字で切る。NFKC正規化した文字列を抽出器へ
5. `extract.ts` → codes/links。`store.ts` で保存（TTL計算は §3）
6. `pushSub` があれば `push.ts` で送信（失敗は握りつぶしてログのみ。410なら購読を消す）
ローカルでは wrangler の `POST /cdn-cgi/local/email?from=&to=`（bodyは生メール・**Message-ID必須**）で同じ経路を叩ける。E2Eは `FR-16` の注入ルートを使う。

## 6. クライアント
- `app.js` は状態機（idle/waiting/received/expired）を1関数で描画。`localStorage["sutemail.v1"]` に `{local, token, expiresAt, reported: string[]}` を1件だけ（`reported` は報告済みホスト。サーバーは二重報告に 409 を返さず「数えない」だけなので、「記録済み」表示はクライアント側で持つ）。
- 可視時のみポーリング（`document.visibilityState`）。到着は `aria-live="polite"` の領域へ。
- CSP は **Worker が付ける**（`src/lib/headers.ts`。`env.ASSETS.fetch()` の応答へ CSP・`X-Content-Type-Options: nosniff`・`Referrer-Policy: no-referrer` を載せる）。既定は `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`。`TURNSTILE_SITE_KEY` と `TURNSTILE_SECRET_KEY` が揃っているときだけ `challenges.cloudflare.com` を `script-src`・`connect-src`・`frame-src` に足す。
  - **`public/_headers` は置かない**（2026-09-05 に廃止）。静的ファイルでは分岐できないので、Turnstile を有効にしたときに人が2行を差し替える運用だった。差し替えを忘れるとウィジェットの script が CSP で落ち、トークンが空のまま＝発行が100%403になる。画面には「下の確認にチェックを入れて」としか出ず、手がかりはコンソールの CSP 違反だけだった。鍵の有無から CSP を導くことで、この手順そのものを無くしている。
- OGP画像 `public/og.png`（1200×630）とアイコンは `tools/assets.mjs` が Playwright で HTML テンプレートから生成（画像に文字を焼き込むのは製品名のみ）。

## 7. 検証
- `npm run typecheck`（tsc --noEmit）／`npm run build`（`wrangler deploy --dry-run --outdir dist`）／`npm run test:unit`（vitest）／`npm run test:e2e`（Playwright）／`npm test`＝上記すべて。
- E2E は `wrangler dev --port 8788` を webServer に、`.dev.vars` で `DEV_INJECT=1`・`MAIL_DOMAIN=sutemail.test`・`IP_HASH_SECRET=dev`。期限切れは `page.clock` で時計を進めて再現（KVのTTL待ちはしない）。
- UI採点は `tools/screenshots.mjs` の出力（4状態×3幅）を別セッションの評価者に渡す。

## 8. デプロイ（本人作業・詳細は DEPLOY.md）
ドメイン取得（取得前にブロックリスト検査）→ Cloudflare DNS → Email Routing 有効化（MX3本＋SPF）→ catch-all を「Send to a Worker」→ KV作成と `wrangler.jsonc` の id 差し替え → secrets 投入 → `wrangler deploy` → 実メールで疎通 → SPF/DKIM拒否の実測表を作る → CPU超過が出れば Paid へ。
