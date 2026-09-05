// functions/api/credits/redeem-card.js
// イベント会場の使い捨てQRカードでクレジットを受け取る。
//   POST /api/credits/redeem-card   body: { token }
// 成功 → { ok: true, granted, credits, token }
// 失敗 → 404 invalid_token / 410 card_exhausted / 409 already_redeemed / 400 未入力 / 403 有効期間外
// 冪等性: credit_tx の UNIQUE(uid, reason='card', ref=トークン) を
// ゲートに INSERT OR IGNORE で「1カード=1ユーザー」をアトミック保証する。

import { authFromRequest } from "../_auth.js";
import { isAccountLocked } from "../_users.js";
import { CORS, json } from "../_credits.js";

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
    return json({ error: "unauthorized", message: "ログインしてください" }, 401);
  }
  if (await isAccountLocked(env, user.uid)) {
    return json({ error: "account_locked", message: "アカウントがロックされています" }, 403);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    // 空ボディは token 欠落エラー扱いにする。
  }
  const token = String(body.token || "").trim().toUpperCase();
  if (!token) {
    return json({ error: "invalid_token", message: "トークンが入力されていません" }, 400);
  }

  const now = Date.now();

  const cardRow = await env.AIMON_DB.prepare(
    "SELECT token, credits, max_uses, used_count, starts_at, expires_at FROM campaign_cards WHERE token = ?1"
  )
    .bind(token)
    .first();

  if (!cardRow) {
    return json({ error: "invalid_token", message: "このカードは無効です" }, 404);
  }

  const grant = cardRow.credits;

  // 有効期間チェック（starts_at / expires_at が NULL なら制限なし）。
  if (cardRow.starts_at && now < cardRow.starts_at) {
    return json({ error: "card_not_started", message: "このカードはまだ利用開始前です" }, 403);
  }
  if (cardRow.expires_at && now > cardRow.expires_at) {
    return json({ error: "card_expired", message: "このカードの有効期限は終了しました" }, 403);
  }

  const maxUses = cardRow.max_uses ?? 1;
  if (maxUses > 0 && (cardRow.used_count ?? 0) >= maxUses) {
    return json(
      { error: "card_exhausted", message: "このカードは既に使用済みです" },
      410
    );
  }

  // 同一ユーザーによる再使用をアトミックに防止（changes=0 なら使用済み）。
  const gate = await env.AIMON_DB.prepare(
    "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, created_at) VALUES (?1, ?2, 'card', ?3, ?4)"
  )
    .bind(user.uid, grant, token, now)
    .run();

  if (gate.meta?.changes === 0) {
    return json({ error: "already_redeemed", message: "このカードは受け取り済みです" }, 409);
  }

  // 使用回数をカウントし、クレジットを加算。
  await env.AIMON_DB.batch([
    env.AIMON_DB.prepare("UPDATE campaign_cards SET used_count = used_count + 1 WHERE token = ?1").bind(token),
    env.AIMON_DB.prepare(
      `INSERT INTO users (uid, credits, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(uid) DO UPDATE SET credits = credits + excluded.credits, updated_at = excluded.updated_at`
    ).bind(user.uid, grant, now),
  ]);

  const row = await env.AIMON_DB.prepare("SELECT credits FROM users WHERE uid = ?1")
    .bind(user.uid)
    .first();

  return json({
    ok: true,
    granted: grant,
    credits: row?.credits ?? 0,
    token,
  });
}
