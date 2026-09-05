-- 001_init.sql — Aimon D1 初期スキーマ（M2: アカウント基盤）
-- users: ユーザー台帳。ニックネームは自前管理（Firebase displayName は Worker から読めないため）。
--   nickname_norm に UNIQUE 制約（ニックネームの一意化。NULL は複数可＝未設定）。
--   nickname_updated_at は 30 日クールダウン判定用（メール登録等の一般更新と分離）。
--   credits は Phase1 課金経済用（今回のマイグレーションではカラムのみ用意）。
-- credit_tx: クレジット台帳（Phase1 で使用。今回はテーブル作成のみ）。

CREATE TABLE IF NOT EXISTS users (
  uid                 TEXT PRIMARY KEY,
  email               TEXT,                -- 任意メール（linkWithCredential 後にトークンから同期）
  nickname            TEXT,                -- 表示名（初発見者「おや」）
  nickname_norm       TEXT UNIQUE,         -- 正規化済みニックネーム（一意制約。NULL は複数可）
  nickname_updated_at INTEGER,             -- ニックネーム最終変更時刻（30日クールダウン判定用）
  credits             INTEGER NOT NULL DEFAULT 0,
  agreed_at           INTEGER,             -- 利用規約・プライバシーポリシー同意日時
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_tx (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        TEXT NOT NULL,
  delta      INTEGER NOT NULL,             -- 正=付与 / 負=消費
  reason     TEXT NOT NULL,                -- 'onboarding' | 'daily' | 'share' | 'purchase' | 'image' | 'refund'
  ref        TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_credit_tx_uid ON credit_tx(uid);
