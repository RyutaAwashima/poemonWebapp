-- 011_billing_alerts.sql — 課金関連の異常検知・ユーザー報告（Discord Webhookアラート基盤）
CREATE TABLE IF NOT EXISTS billing_incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL, -- 'purchase_grant_failed' | 'refund_failed' | 'user_report'
  uid         TEXT,
  ref         TEXT,
  detail      TEXT, -- JSON文字列（診断情報）
  resolved_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_incidents_open ON billing_incidents (resolved_at, created_at DESC);
