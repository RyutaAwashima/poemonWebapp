-- 021_app_errors.sql — 汎用エラーログ（未知のクラッシュ調査用・2026-08-22）
-- billing_incidents / image_gen_events と同じ思想だが、こちらは機能を問わず
-- 「原因不明の例外」を広く受け止める共通の受け皿。肥大化防止のため message/detail は
-- truncate済みで保存し、_error-log.js が書き込みのたび低確率で30日超過分を間引き削除する。

CREATE TABLE IF NOT EXISTS app_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,   -- 発生箇所（例: 'monster-image' | 'resume' | 'flavor-gen'）
  uid         TEXT,
  message     TEXT,            -- truncate済み（500字）
  detail      TEXT,            -- JSON文字列・truncate済み（2000字）
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_errors_created ON app_errors (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_errors_scope   ON app_errors (scope, created_at DESC);
