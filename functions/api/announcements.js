// functions/api/announcements.js
// お知らせの一元管理 API。
//   GET  /api/announcements   → 公開済みお知らせ一覧（ホームの「お知らせ」欄が読む。認証不要）
//   POST /api/announcements   → 開発者/管理者のみ。お知らせを作成（公開）する。
//        body: { title, body, publish?: boolean }（publish:false なら下書き）
// メール配信（配信キューへの投入）は /api/newsletter が受け持つ。
// 管理権限の判定は users.role IN ('developer', 'admin') で行う（_auth.js のトークン検証を併用）。

import { authFromRequest } from "./_auth.js";
import { getUser } from "./_users.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const STAFF_ROLES = new Set(["developer", "admin"]);
const ANNOUNCEMENT_LIMIT = 20;

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

  // メンテナンスチェック（管理者はバイパス）
  const { checkMaintenance } = await import("./_maintenance.js");
  const m = await checkMaintenance(context);
  if (m) return m.response;

  // ── お知らせ一覧（ホーム表示は認証不要・公開済みのみ。開発者/管理者は下書きも含めて全件） ───
  if (request.method === "GET") {
    let staff = false;
    const user = await authFromRequest(env, request);
    if (user) {
      const me = await getUser(env, user.uid);
      staff = !!(me && STAFF_ROLES.has(me.role));
    }
    const rows = staff
      ? await env.AIMON_DB.prepare(
          `SELECT id, title, body, status, published_at, created_at FROM announcements
           ORDER BY created_at DESC
           LIMIT ?1`
        )
          .bind(ANNOUNCEMENT_LIMIT)
          .all()
      : await env.AIMON_DB.prepare(
          `SELECT id, title, body, published_at, created_at FROM announcements
           WHERE status = 'published'
           ORDER BY published_at DESC
           LIMIT ?1`
        )
          .bind(ANNOUNCEMENT_LIMIT)
          .all();
    const announcements = (rows.results || []).map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      ...(staff ? { status: r.status } : {}),
      publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
    }));
    return json({ announcements });
  }

  // ── お知らせ作成（開発者/管理者のみ） ───────────────────
  if (request.method === "POST") {
    const user = await authFromRequest(env, request);
    if (!user) {
      return json({ error: "unauthorized" }, 401);
    }
    const me = await getUser(env, user.uid);
    if (!me || !STAFF_ROLES.has(me.role)) {
      return json({ error: "forbidden" }, 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const text = typeof body?.body === "string" ? body.body.trim() : "";
    if (!title || !text) {
      return json({ error: "title と body は必須です" }, 400);
    }

    const now = Date.now();
    const status = body.publish === false ? "draft" : "published";
    const publishedAt = status === "published" ? now : null;
    const result = await env.AIMON_DB.prepare(
      `INSERT INTO announcements (title, body, status, published_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`
    )
      .bind(title, text, status, publishedAt, now)
      .run();

    return json({ ok: true, id: result.meta.last_row_id, status }, 201);
  }

  return json({ error: "method not allowed" }, 405);
}
