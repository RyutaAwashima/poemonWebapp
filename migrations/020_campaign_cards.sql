-- 020_campaign_cards.sql — イベント会場用使い捨てQRカード
-- カード販売時に事前発行し、ユーザーがQRをスキャンしてログイン後にクレジット付与。
-- 冪等性: credit_tx の UNIQUE(uid, reason='card', ref=token) で「1カード=1ユーザー」を保証。
CREATE TABLE IF NOT EXISTS campaign_cards (
  token         TEXT PRIMARY KEY,         -- QRコードに埋めるトークン（例: SPR2026-A3K9F）
  credits       INTEGER NOT NULL,         -- 付与クレジット数
  price_yen     INTEGER NOT NULL DEFAULT 0, -- 販売価格（円・管理用メモ）
  max_uses      INTEGER NOT NULL DEFAULT 1, -- 利用回数上限（通常=1・使い捨て）
  used_count    INTEGER NOT NULL DEFAULT 0, -- 使用済み回数
  starts_at     INTEGER,                  -- 有効開始（epoch ms。NULL=即時）
  expires_at    INTEGER,                  -- 有効期限（epoch ms。NULL=無期限）
  note          TEXT,                     -- 用途メモ（管理用）
  created_at    INTEGER NOT NULL
);
