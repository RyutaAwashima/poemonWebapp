// functions/api/announcements/[id].js
// 下書きお知らせの公開（開発者/管理者のみ）。
//   PATCH /api/announcements/:id → status='draft' のお知らせを 'published' にする

import { authFromRequest } from "../_auth.js";
import { getUser } from "../_users.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const STAFF_ROLES = new Set(["developer", "admin"]);

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
  const me = await getUser(env, user.uid);
  if (!me || !STAFF_ROLES.has(me.role)) return json({ error: "forbidden" }, 403);

  const id = Number(params.id);
  if (!Number.isInteger(id)) return json({ error: "invalid id" }, 400);

  const now = Date.now();
  const result = await env.AIMON_DB.prepare(
    `UPDATE announcements SET status = 'published', published_at = ?1, updated_at = ?1
     WHERE id = ?2 AND status = 'draft'`
  )
    .bind(now, id)
    .run();

  if (!result.meta?.changes) {
    return json({ error: "not_found_or_already_published" }, 404);
  }
  return json({ ok: true, id, publishedAt: now });
}
