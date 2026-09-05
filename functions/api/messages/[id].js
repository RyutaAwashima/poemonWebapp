// functions/api/messages/[id].js
// 個別メッセージを既読にする（本人のみ）。
//   PATCH /api/messages/:id

import { authFromRequest } from "../_auth.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  if (request.method !== "PATCH") {
    return json({ error: "method not allowed" }, 405);
  }

  const user = await authFromRequest(env, request);
  if (!user) return json({ error: "unauthorized" }, 401);

  const id = Number(params.id);
  if (!Number.isInteger(id)) return json({ error: "invalid id" }, 400);

  const now = Date.now();
  const result = await env.AIMON_DB.prepare(
    `UPDATE user_messages SET read_at = ?1 WHERE id = ?2 AND uid = ?3 AND read_at IS NULL`
  )
    .bind(now, id, user.uid)
    .run();

  if (!result.meta?.changes) {
    return json({ error: "not_found_or_already_read" }, 404);
  }
  return json({ ok: true });
}
