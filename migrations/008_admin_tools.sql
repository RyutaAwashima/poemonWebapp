-- 008_admin_tools.sql — 管理コンソール拡張（ユーザー管理・アカウントロック・個別メッセージ）
-- users: アカウントロック用カラム（locked_at=NULL は通常状態、epoch ms でロック中）
ALTER TABLE users ADD COLUMN locked_at INTEGER;
ALTER TABLE users ADD COLUMN locked_reason TEXT;

-- credit_tx: 管理者による手動調整の理由を残す監査用カラム
ALTER TABLE credit_tx ADD COLUMN note TEXT;

-- user_messages: 運営から特定ユーザーへの個別メッセージ（ダッシュボードに表示・既読管理）
CREATE TABLE IF NOT EXISTS user_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_by TEXT,
  read_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_messages_uid ON user_messages (uid, created_at DESC);
