# インフラ再設定仕様（TECH_SPEC_INFRA_SETUP）

> ステータス: 未実施（新リポジトリでの開発開始時に実施）
> 対象: poemonWebapp（ポエモン）
> 前提: sangyoufare2026（メイモン）から雛形コードを流用済み。**インフラ系はすべて新規に設定し直す**

## 1. 概要

コード本体（認証ロジック・画像生成・ハッシュ抽選・経済・育成）とマイグレーションSQLは流用できるが、
**Firebase / Cloudflare / Stripe / X などの外部サービスはすべて新規プロジェクトとして再設定が必要**。

本ドキュメントは、新リポジトリで開発を始める際のインフラ設定手順をまとめたもの。

## 2. 再設定が必要なもの

### 2.1 Firebase（認証）

| 項目 | 内容 |
|---|---|
| 新規プロジェクト作成 | 例: `poemon-app` |
| Authentication 有効化 | メール/パスワード等 |
| 設定反映先① | `app/firebase-config.js` のプレースホルダを新プロジェクトの実値に差し替え |
| 設定反映先② | `functions/api/_auth.js` の `PROJECT_ID` を新プロジェクトIDに差し替え |

`app/firebase-config.js` のプレースホルダ:
```js
export const FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};
```

### 2.2 Cloudflare（ホスティング・DB・ストレージ）

| リソース | 新規作成 | 設定反映先（`wrangler.jsonc`） |
|---|---|---|
| Pages プロジェクト | `poemonWebapp` | `name` |
| KV Namespace | 新規作成 | `AIMON_KV` の `id` / `preview_id` |
| D1 Database | 新規作成 | `AIMON_DB` の `database_id` |
| R2 Bucket | 新規作成 | `AIMON_IMAGES` の `bucket_name` |

`wrangler.jsonc` のプレースホルダ:
```jsonc
{
  "name": "poemonWebapp",
  "pages_build_output_dir": ".",
  "compatibility_date": "2026-06-28",
  "kv_namespaces": [
    { "binding": "AIMON_KV", "id": "YOUR_KV_NAMESPACE_ID", "preview_id": "YOUR_KV_PREVIEW_ID" }
  ],
  "r2_buckets": [
    { "binding": "AIMON_IMAGES", "bucket_name": "YOUR_R2_BUCKET" }
  ],
  "d1_databases": [
    { "binding": "AIMON_DB", "database_name": "YOUR_DB_NAME", "database_id": "YOUR_D1_DATABASE_ID" }
  ]
}
```

**マイグレーション適用**（新D1にテーブル作成）:
```bash
wrangler d1 execute YOUR_DB_NAME --remote --file migrations/001_init.sql
# 以降、必要なマイグレーションを順に適用
```

### 2.3 Secrets（環境変数・`wrangler secret put`）

コードに含まれない秘密情報は新プロジェクトで再設定が必要:

| Secret | 用途 |
|---|---|
| `GEMINI_API_TOKEN` | 画像生成・ポエム生成 |
| `REPLICATE_API_TOKEN` | 画像生成フォールバック |
| `STRIPE_SECRET_KEY` | 課金（買い切り） |
| `DISCORD_WEBHOOK_URL` | エラー通知 |
| `X_*`（APIキー等） | X広報・共有（使う場合） |

```bash
wrangler secret put GEMINI_API_TOKEN
wrangler secret put REPLICATE_API_TOKEN
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put DISCORD_WEBHOOK_URL
```

### 2.4 Stripe（課金）

- 新規アカウント or 既存アカウントの**新プロダクト**作成
- `functions/api/_stripe.js` の `PACKS` 定義（買い切り商品）を新価格に差し替え
- Webhook エンドポイントを Pages の URL に設定

### 2.5 X（旧Twitter）連携（使う場合）

- 新規アプリ登録・OAuth 1.0a クレデンシャル取得
- `functions/api/_x-client.js` の設定を新アプリに差し替え

## 3. 再利用できるもの（再設定不要）

- **コード本体**: 認証ロジック・画像生成・ハッシュ抽選・経済・育成
- **マイグレーションSQL**: 汎用テーブル定義はそのまま適用可能
- **FontAwesome**: ライセンス表示を維持すればOK

## 4. 推奨の進め方（新リポジトリでの開発開始時）

1. **Firebase + Cloudflare のアカウント/プロジェクト作成**（手動・ブラウザ作業）
2. `wrangler.jsonc` と `firebase-config.js` に実値を設定
3. D1マイグレーション適用
4. Secrets 設定
5. ローカルで動作確認 → デプロイ

## 5. 注意点

- インフラの実値（ID・キー）は**このリポジトリにコミットしない**（`.gitignore` 対象・Secrets 管理）
- `wrangler.jsonc` の binding 名はコードとの整合のため `AIMON_*` のままでも可（変更する場合はコード側も一括置換）
- 元プロジェクト（sangyoufare2026）の実インフラには**触れない**（別プロジェクトとして独立運用）