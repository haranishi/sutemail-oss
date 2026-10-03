# sutemail — OSS版

認証コード受信に用途を絞った、一時メールアドレスのプロトタイプです。Cloudflare Workers / Email Routing / KV と、フレームワークを使わないPWAで構成しています。

## ローカル開発

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

ローカルURLは `http://127.0.0.1:8788` です。
`npm run typecheck`、`npm run test:unit`、`npm run test:e2e` が検証コマンドです。E2EにはPlaywrightのブラウザが必要です。
同梱のメールfixtureは合成データです。実メール・アカウントID・KV ID・本番の鍵は含めていません。

## 公開サービスではありません

このリポジトリは新規履歴のソース公開であり、受信サービスを公開・デプロイしたものではありません。
受信ドメイン、運営者の表示、通報窓口、通信の秘密の管理、必要な届出、提供元の条件などは運営者が別途確認してください。
`public/terms.html`、`privacy.html`、`external-transmission.html` は未完成のひな形です。完成した法務文書として流用しないでください。
運用前の確認事項は [SERVICE_RELEASE_CHECKLIST.md](docs/SERVICE_RELEASE_CHECKLIST.md) にあります。

## 設定上の注意

`.dev.vars.example` の `dev-secret` と `DEV_INJECT=1` はローカル試験専用です。本番で使わないでください。
本番では強い秘密鍵を用意し、開発用メール投入を無効にします。Web Push と Turnstile は設定した場合だけ外部へ通信します。
本ソースの公開は、他のサービスの利用規約に反するアカウント作成や、認証回避を許可するものではありません。

## ライセンス

自作ソースは [MIT](LICENSE) です。依存パッケージにはそれぞれの条件が適用されます。
私用の企画メモ・開発指示・評価記録は含めていません。Cloudflare等の公式製品ではありません。
