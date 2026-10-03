# ソース公開とサービス提供を分ける

OSS版はローカル開発用のソース公開です。本番に出す前に [SERVICE_RELEASE_CHECKLIST.md](SERVICE_RELEASE_CHECKLIST.md) の確認を行ってください。
この文書の記載は、デプロイ・契約・鍵発行の許可や、法的適合性の判定ではありません。

## 設定が必要な箇所

- `wrangler.jsonc`: Worker名、KVの実ID、受信ドメイン、公開オリジン。いまの値はローカル用またはプレースホルダーです。
- secrets: `IP_HASH_SECRET`。必要な場合だけVAPIDの3項目とTurnstileの2項目を設定します。
- 開発用の `DEV_INJECT` は本番に置きません。`.dev.vars.example` の鍵も本番で使いません。
- HTML: canonical・OGPのURL、運営者表示、通報窓口、利用規約、プライバシー・外部送信の説明。
- Cloudflare: Email Routingとcatch-allからWorkerへの受信経路。既存のメール設定に影響する変更は、別途確認してください。

## 確認

型検査、単体テスト、ブラウザテスト、ビルドに加え、テスト用メールで認証・保存期限・削除・負荷制限を確認します。
通知を使う場合は送信先の制限と秘密情報の扱いも確認します。価格・無料枠・CPU・KVの条件は現行の公式資料を参照してください。

公式資料: [Email Workers](https://developers.cloudflare.com/email-routing/email-workers/)、[Workers](https://developers.cloudflare.com/workers/)、[Cloudflareの条件](https://www.cloudflare.com/terms/)。
