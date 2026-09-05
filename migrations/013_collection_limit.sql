-- 013_collection_limit.sql — コレクション拡張（1クレジット=3枠・最大99枠）
-- 既定30枠。users.collection_limit を拡張API（POST /api/collection/expand）が増やす。
-- aimons.js / aimons/merge.js / monster-image.js の保存上限チェックはこの値を使う。
-- 2026-08-09 適用。
ALTER TABLE users ADD COLUMN collection_limit INTEGER NOT NULL DEFAULT 30;
