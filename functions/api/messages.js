// functions/api/messages.js
// 運営からの個別メッセージ（本人のみ閲覧）。
//   GET /api/messages → 自分宛メッセージ一覧（新しい順・最大20件・未読フラグ付き）

import { authFromRequest } from "./_auth.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const MESSAGE_LIMIT = 20;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  if (request.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  const user = await authFromRequest(env, request);
  if (!user) return json({ error: "unauthorized" }, 401);

  const rows = await env.AIMON_DB.prepare(
    `SELECT id, title, body, read_at, created_at FROM user_messages
     WHERE uid = ?1 ORDER BY created_at DESC LIMIT ?2`
  )
    .bind(user.uid, MESSAGE_LIMIT)
    .all();

  const messages = (rows.results || []).map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    read: !!r.read_at,
    createdAt: r.created_at,
  }));

  return json({ messages, unread: messages.filter((m) => !m.read).length });
}
