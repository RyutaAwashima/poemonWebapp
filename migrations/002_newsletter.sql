-- キャンペーンメール配信希望（オプトイン）。
-- 登録フォームは初期OFF（未チェック＝デフォルト希望なし=0）。登録後に希望/解除を変更可能
-- （POST /api/users/account { newsletter: boolean }）。
-- ※2026-08-07 デフォルトOFF（ダークパターン回避）へ方針変更。既存ユーザーのリセットは 003 で実施。
ALTER TABLE users ADD COLUMN newsletter INTEGER NOT NULL DEFAULT 0;
