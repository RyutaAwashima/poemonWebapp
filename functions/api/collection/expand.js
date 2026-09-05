// functions/api/collection/expand.js
// コレクション拡張（1クレジット=3枠・最大99枠）。
//   POST /api/collection/expand → { credits, collectionLimit, added }
// 認証必須。クレジット消費は残高チェック付き UPDATE でアトミックに行う（既存パターン）。
// 画像APIを叩かずにクレジットを消費する施策（P10・2026-08-09）。

import { authFromRequest } from "../_auth.js";
import { CORS, json } from "../_credits.js";

const EXPAND_COST = 3; // 1回あたりのクレジット消費（2026-08-14 経済改定で 1 → 3）
const EXPAND_ADD = 3; // +3枠（3列表示に合わせて）
const MAX_LIMIT = 99; // 上限

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

  const now = Date.now();
  const row = await env.AIMON_DB.prepare(
    "SELECT credits, collection_limit FROM users WHERE uid = ?1"
  )
    .bind(user.uid)
    .first();
  const credits = row?.credits ?? 0;
  const limit = row?.collection_limit ?? 30;

  if (limit >= MAX_LIMIT) {
    return json(
      { error: "collection_limit_max", message: `コレクションは上限（${MAX_LIMIT}枠）までです` },
      400
    );
  }
  if (credits < EXPAND_COST) {
    return json({ error: "insufficient_credits", message: "クレジットが不足しています" }, 403);
  }

  const nextLimit = Math.min(MAX_LIMIT, limit + EXPAND_ADD);
  // 残高チェック（credits >= cost）付き UPDATE でアトミックに減算＋拡張。
  const charge = await env.AIMON_DB.prepare(
    "UPDATE users SET credits = credits - ?1, collection_limit = ?2, updated_at = ?3 WHERE uid = ?4 AND credits >= ?1"
  )
    .bind(EXPAND_COST, nextLimit, now, user.uid)
    .run();
  if (charge.meta?.changes === 0) {
    return json({ error: "insufficient_credits", message: "クレジットが不足しています" }, 403);
  }

  await env.AIMON_DB.prepare(
    "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, created_at) VALUES (?1, ?2, 'collection', ?3, ?4)"
  )
    .bind(user.uid, -EXPAND_COST, `expand-${now}`, now)
    .run();

  const fresh = await env.AIMON_DB.prepare(
    "SELECT credits, collection_limit FROM users WHERE uid = ?1"
  )
    .bind(user.uid)
    .first();
  return json({
    credits: fresh?.credits ?? 0,
    collectionLimit: fresh?.collection_limit ?? 30,
    added: EXPAND_ADD,
  });
}
