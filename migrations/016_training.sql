-- 016_training.sql — 育成システム再設計（レベル・XP・願いのカケラ）
-- users.fragments（願いのカケラ）: レベル上限(99)到達後のあぶれXPが1:1で変換される新アイテム。
--   100個で願いの雫1個に交換できる（ショップ交換 API）。XPが無駄にならない救済措置。
ALTER TABLE users ADD COLUMN fragments INTEGER NOT NULL DEFAULT 0;
