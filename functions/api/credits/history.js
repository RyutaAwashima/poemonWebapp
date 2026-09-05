// functions/api/credits/history.js
// 自分のクレジット獲得・消費履歴の取得（P8）。
//   GET /api/credits/history → { history: [{ delta, reason, ref, pack, yen, note, created_at }] }
// 認証必須。credit_tx を新しい順で最大100件返す。
// 表示文言（reason の日本語ラベル等）はフロント側で持つ。

import { authFromRequest } from "../_auth.js";
import { CORS, json } from "../_credits.js";

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  if (request.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  const user = await authFromRequest(env, request);
  if (!user) {
    return json({ error: "unauthorized" }, 401);
  }

  const rows = await env.AIMON_DB.prepare(
    `SELECT delta, reason, ref, pack, yen, note, created_at AS createdAt
     FROM credit_tx
     WHERE uid = ?1
     ORDER BY created_at DESC, id DESC
     LIMIT 100`
  )
    .bind(user.uid)
    .all();

  return json({ history: rows.results || [] });
}
