-- 018_image_gen_events.sql — 画像生成の全件ログ（成功/失敗/フォールバック追跡）
-- Phase 1: 画像生成の可観測性。30日自動扫除クエリの対象。

CREATE TABLE IF NOT EXISTS image_gen_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uid         TEXT,
  monster_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  rarity      INTEGER,
  model       TEXT NOT NULL,                -- 'gemini' | 'replicate'
  fallback    INTEGER NOT NULL DEFAULT 0,   -- 1=プライマリ失敗→フォールバック成功
  success     INTEGER NOT NULL DEFAULT 1,   -- 1=成功 / 0=全モデル失敗
  error_code  TEXT,                         -- 'gemini_error' | 'replicate_error' | 'timeout' | null
  error_msg   TEXT,                         -- エラーメッセージ（truncate 500字）
  duration_ms INTEGER,                      -- 画像生成にかかった時間（ミリ秒）
  source      TEXT,                         -- 'generate' | 'summon' | 'cache'
  charged     INTEGER NOT NULL DEFAULT 0,   -- 1=課金済み
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ige_created ON image_gen_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ige_model   ON image_gen_events (model, success);
CREATE INDEX IF NOT EXISTS idx_ige_uid     ON image_gen_events (uid, created_at DESC);
