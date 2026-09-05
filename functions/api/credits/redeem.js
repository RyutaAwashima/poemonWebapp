// functions/api/credits/redeem.js
// キャンペーンコードでクレジットを受け取る（検証・キャンペーン用）。
//   POST /api/credits/redeem   body: { code }
// 成功 → { ok: true, granted, credits, code }
// 失敗 → 404 invalid_code / 410 code_exhausted / 409 already_redeemed / 400 未入力
// 冪等性: credit_tx の UNIQUE(uid, reason, ref)（reason='campaign', ref=コード）を
// ゲートに INSERT OR IGNORE で「同一ユーザーは1回のみ」をアトミック保証する（デイリー付与と同型）。

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
    return json({ error: "unauthorized" }, 401);
  }
  if (await isAccountLocked(env, user.uid)) {
    return json({ error: "account_locked" }, 403);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    // 空ボディは code 欠落エラー扱いにする。
  }
  const code = String(body.code || "").trim().toUpperCase();
  if (!code) {
    return json({ error: "invalid_code", message: "キャンペーンコードを入力してください" }, 400);
  }

  const now = Date.now();

  const codeRow = await env.AIMON_DB.prepare(
    "SELECT code, credits, max_uses, used_count, starts_at, expires_at FROM campaign_codes WHERE code = ?1"
  )
    .bind(code)
    .first();

  if (!codeRow) {
    return json({ error: "invalid_code", message: "このキャンペーンコードは無効です" }, 404);
  }

  const grant = codeRow.credits;

  // 有効期間チェック（期間限定コード用。starts_at/expires_at が NULL なら制限なし）。
  if (codeRow.starts_at && now < codeRow.starts_at) {
    return json({ error: "code_not_started", message: "このキャンペーンコードはまだ利用開始前です" }, 403);
  }
  if (codeRow.expires_at && now > codeRow.expires_at) {
    return json({ error: "code_expired", message: "このキャンペーンコードの有効期限は終了しました" }, 403);
  }

  const maxUses = codeRow.max_uses ?? 0;
  if (maxUses > 0 && (codeRow.used_count ?? 0) >= maxUses) {
    return json(
      { error: "code_exhausted", message: "このキャンペーンコードは利用回数上限に達しました" },
      410
    );
  }

  // 同一ユーザーによる再使用をアトミックに防止（changes=0 なら使用済み）。
  const gate = await env.AIMON_DB.prepare(
    "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, created_at) VALUES (?1, ?2, 'campaign', ?3, ?4)"
  )
    .bind(user.uid, grant, code, now)
    .run();

  if (gate.meta?.changes === 0) {
    return json({ error: "already_redeemed", message: "このキャンペーンコードは受け取り済みです" }, 409);
  }

  // 使用回数をカウントし、クレジットを加算。
  // ユーザー行が無い匿名ユーザーにも反映されるよう行を作成しつつ加算する（UPSERT）。
  await env.AIMON_DB.batch([
    env.AIMON_DB.prepare("UPDATE campaign_codes SET used_count = used_count + 1 WHERE code = ?1").bind(code),
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
    code,
  });
}
