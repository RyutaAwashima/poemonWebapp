-- 010_pending_purchases.sql — Stripe Checkoutセッション作成時のスナップショット。
-- webhookのcheckout.session.completedでsession.metadataが何らかの理由で欠落した場合の
-- フォールバック用（2026-08-08 実購入でmetadataが空になる事象が発生したため冗長化）。
CREATE TABLE IF NOT EXISTS pending_purchases (
  session_id TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  pack       TEXT NOT NULL,
  credits    INTEGER NOT NULL,
  yen        INTEGER NOT NULL,
  campaign   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
