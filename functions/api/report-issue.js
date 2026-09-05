// functions/api/report-issue.js
// 課金トラブル専用の問題報告（ユーザー向け）。
//   POST /api/report-issue  body: { title, body }
// 送信されるとDiscordへ即時アラート＋billing_incidentsに記録される（開発者/管理者は管理コンソールで確認可能）。

import { authFromRequest } from "./_auth.js";
import { reportBillingIncident } from "./_alerts.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

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
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const user = await authFromRequest(env, request);
  if (!user) return json({ error: "unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const title = typeof body?.title === "string" ? body.title.trim().slice(0, 100) : "";
  const text = typeof body?.body === "string" ? body.body.trim().slice(0, 2000) : "";
  if (!text) {
    return json({ error: "body は必須です" }, 400);
  }

  // 直近の購入履歴を添えることで調査を速くする（失敗しても報告自体は継続）。
  let recentPurchases = [];
  try {
    const rows = await env.AIMON_DB.prepare(
      `SELECT delta, reason, ref, pack, yen, created_at FROM credit_tx
       WHERE uid = ?1 ORDER BY created_at DESC LIMIT 5`
    )
      .bind(user.uid)
      .all();
    recentPurchases = rows.results || [];
  } catch {}

  await reportBillingIncident(env, {
    kind: "user_report",
    uid: user.uid,
    detail: { title: title || "(無題)", body: text, recentPurchases },
  });

  return json({ ok: true }, 201);
}
