// functions/api/credits/daily.js
// デイリーログインボーナスの受取（設計 §5.4）。1日1回・冪等。
//   POST /api/credits/daily → { ok, granted, credits, daily: { grant, claimable:false } }
// 二重付与防止: credit_tx の UNIQUE(uid, reason, ref) をゲートに INSERT OR IGNORE で
// アトミックに受取済み判定する（changes=0 なら受取済み → 409）。

import { authFromRequest } from "../_auth.js";
import { isAccountLocked } from "../_users.js";
import { DAILY_GRANT, CORS, json, dayRef } from "../_credits.js";

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const user = await authFromRequest(env, request);
  if (!user) {
    return json({ error: "unauthorized" }, 401);
  }
  if (await isAccountLocked(env, user.uid)) {
    return json({ error: "account_locked" }, 403);
  }

  const now = Date.now();
  const ref = dayRef(now);

  // アトミックゲート: 今日の付与済みなら INSERT が無視される（changes=0）。
  const gate = await env.AIMON_DB.prepare(
    "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, created_at) VALUES (?1, ?2, 'daily', ?3, ?4)"
  )
    .bind(user.uid, DAILY_GRANT, ref, now)
    .run();

  if (gate.meta?.changes === 0) {
    return json(
      { error: "already_claimed", message: "本日はすでに受け取り済みです（明日またどうぞ）" },
      409
    );
  }

  // ユーザー行が無い匿名ユーザーにもデイリー付与が反映されるよう、行を作成しつつ加算する（UPSERT）。
  // 既存行（ニックネーム設定済み等）の場合は credits と updated_at だけ更新する。
  await env.AIMON_DB.prepare(
    `INSERT INTO users (uid, credits, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT(uid) DO UPDATE SET credits = credits + excluded.credits, updated_at = excluded.updated_at`
  )
    .bind(user.uid, DAILY_GRANT, now)
    .run();

  const row = await env.AIMON_DB.prepare("SELECT credits FROM users WHERE uid = ?1")
    .bind(user.uid)
    .first();

  return json({
    ok: true,
    granted: DAILY_GRANT,
    credits: row?.credits ?? 0,
    daily: { grant: DAILY_GRANT, claimable: false },
  });
}
