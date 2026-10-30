# 依存関係の脆弱性対応（2026年10月）

## 要件

[既存要件](01_requirements.md)のFR-01〜18とNFR-02〜05を引き継ぐ。
発行、認証、失効、レート制限、MIME解析とコード抽出、通知、4状態の画面を維持し、
既知の依存脆弱性を修正する。本物のメール送信・受信、Turnstile、Pushや本番設定は使わない。

## 設計

- postal-mimeを修正版4.1.4（Node 20以上）へ更新する。既存のMIME fixtureで
  plain/HTML/multipart、添付非保存、サイズ制限と抽出結果の互換性を確認する。
- 旧poolの固定された脆弱依存を強制上書きせず、公式の後継
  @cloudflare/vitest-plugin 1.4.8へ移行する。Vitest 4.1.12、Wrangler 4.153.0と
  workers-types 5.20261023.1をそろえる。公開から72時間以上の版を選ぶ。
- cloudflareTestプラグインでremoteBindingsを無効にし、local Workerのみで検証する。
  tests/setup.tsの公式resetで各テストのストレージを初期化し、旧テストの分離を維持する。
- 廃止されたfetchMockはVitestのfetchスタブへ置き換える。実際の署名・暗号化は残し、
  合成応答、要求先とPOST回数、未使用・予期しない送信をテストの外側で検証する。
- 転移依存は同majorの修正版へ限定し、公開勧告をローカル照合する。
  privateの依存一覧やソースを監査APIへ送らない。

postal-mimeは[公開勧告](https://github.com/advisories/GHSA-f2hq-32vh-53cc)で
4.0.8以上が修正版と確認し、10月22日公開の4.1.4を選んだ。

根拠：[Cloudflareの後継プラグイン](https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/)、
導入版の公式型定義と公開npm metadata、GitHubのreviewed公開勧告。

## タスクと受け入れ条件

- [x] 既存仕様、依存経路、公式移行APIとテストの送信先を確認する。
- [x] manifestとlockfileを更新し、MIMEとテストハーネスの互換性を反映する。
- [x] frozen install、型検査、既存のunit/E2E、本番向けdry-runが成功する。
- [x] 全公開勧告の照合結果と未検証範囲を記録し、PRにまとめる。

## 検証結果

- postal-mime 4.1.4の固定依存をNode 24.22.1でoffline導入し、型検査が成功。
- 全10ファイル121 unitと、実Chromium/local Workerの28 E2Eが成功。
  MIME fixture、発行・受信注入・コピー・失効・再発行、各幅のレイアウトと実績報告を確認。
- Wrangler deploy --dry-runのビルドが成功。実deployはしていない。
- reviewed npm公開勧告8,048件のローカル照合は、対象167版で指摘・解析エラー0件。
  取得時点の公開勧告との照合であり、アプリ全体の安全性を保証するものではない。
- 検証用の.dev.varsはignored領域に合成値だけを新規作成した。
  ブラウザの実行パスはcontrol側だけで調整し、プロダクト設定には加えていない。
- 公開repoの依存名と版だけをnpm公式監査APIへ照合し、全severityで指摘0件。
  private原本の依存一覧やソースは送っていない。
- 本番メール・Turnstile・Push・資格情報・本番設定は使用していない。
