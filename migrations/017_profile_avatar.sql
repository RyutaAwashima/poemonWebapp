-- 017_profile_avatar.sql — プレイヤープロフィール画像（アバター）
-- avatar_updated_at: R2(profiles/{uid}.jpg)のキャッシュバスティング用タイムスタンプ（null=未生成）
-- avatar_free_used: 初回生成が無料特典として消費済みか（2回目以降は通常通り1クレジット消費）
ALTER TABLE users ADD COLUMN avatar_updated_at INTEGER;
ALTER TABLE users ADD COLUMN avatar_free_used INTEGER NOT NULL DEFAULT 0;
