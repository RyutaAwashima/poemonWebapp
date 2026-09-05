// functions/api/users/account.js
// メール登録（Firebase linkWithCredential）後に、トークン上の email と規約同意日時・
// キャンペーンメール希望を D1 へ記録する。登録後のメール設定変更（解除・再開）にも使う。
//   POST /api/users/account { agreed: true, newsletter?: boolean }  → 新規登録（newsletter 省略時は true）
//   POST /api/users/account { newsletter: boolean }                 → メール設定の変更（再同意不要）
// email はリクエスト本文ではなく ID token の claim（payload.email）から取得する（偽装不可）。
// 認証は _auth.js で行う。ニックネームの 30 日クールダウンには影響しない。
// 新規登録時はオンボーディング特典としてクレジット 5 枚を付与する（設計 §5.4 reason='onboarding'）。

import { authFromRequest } from "../_auth.js";
import { getUser } from "../_users.js";
import { initialRankAssignment } from "../_rank.js";

const ONBOARDING_GRANT = 5;

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
  if (!user) {
    return json({ error: "unauthorized" }, 401);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    // 本文なしでも構わない（同意フラグはデフォルト false として扱う）。
  }

  const email = user.email || null;
  // メールリンクされていないトークン（匿名のまま）では登録扱いにしない。
  if (!email) {
    return json({ error: "メールアドレスが確認できません。登録し直してください" }, 400);
  }

  const now = Date.now();

  // ── 新規登録（規約同意必須） ────────────────────────────
  // agreed:true を先に判定する（newsletter は登録時にも送られるため、
  // 先に newsletter 分岐に入ると新規登録が「未登録」扱いで 400 になる）。
  if (body.agreed === true) {
    // キャンペーンメール希望（オプトイン）。登録フォームは初期未チェックのため、省略時は希望なし(0)。
    const newsletter = body.newsletter === true ? 1 : 0;
    const existing = await getUser(env, user.uid);
    // 初回登録かどうかは「email が未記録」で判定する（ニックネーム設定済みの匿名ユーザーは
    // users 行が既に存在するため、行の有無ではなく email の有無で見る）。
    const wasRegistered = !!(existing?.email);

    if (existing) {
      await env.AIMON_DB.prepare(
        `UPDATE users SET email = ?1, agreed_at = ?2, newsletter = ?3, updated_at = ?4 WHERE uid = ?5`
      )
        .bind(email, now, newsletter, now, user.uid)
        .run();
    } else {
      await env.AIMON_DB.prepare(
        `INSERT INTO users (uid, email, agreed_at, newsletter, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`
      )
        .bind(user.uid, email, now, newsletter, now)
        .run();
    }

    // オンボーディング特典 5 枚は初回登録（email を初めて設定）時のみ付与する（設計 §5.4）。
    // credit_tx の UNIQUE(uid, reason, ref) をゲートに INSERT OR IGNORE で二重付与を防ぐ。
    if (!wasRegistered) {
      const gate = await env.AIMON_DB.prepare(
        "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, created_at) VALUES (?1, ?2, 'onboarding', 'onboarding', ?3)"
      )
        .bind(user.uid, ONBOARDING_GRANT, now)
        .run();
      if (gate.meta?.changes > 0) {
        await env.AIMON_DB.prepare(
          "UPDATE users SET credits = credits + ?1 WHERE uid = ?2"
        )
          .bind(ONBOARDING_GRANT, user.uid)
          .run();
      }

      // ランクマッチ（宝石ランク帯）は登録済みユーザーのみ対象。初回登録時にランクIのグループを
      // ランダム割当する（設計: アカウント登録が必須・ランクIのみランダム）。
      const { rankGroup } = initialRankAssignment();
      await env.AIMON_DB.prepare(
        `UPDATE users SET rank_group = ?1 WHERE uid = ?2 AND rank_group IS NULL`
      )
        .bind(rankGroup, user.uid)
        .run();
    }

    const row = await getUser(env, user.uid);
    return json({
      ok: true,
      email,
      registered: true,
      newsletter: !!row?.newsletter,
      createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
      credits: row?.credits ?? 0,
    });
  }

  // ── メール設定の変更（登録後の解除・再開） ──────────────
  // 再同意なしで newsletter だけ更新できる（登録済みユーザーのみ）。
  if (typeof body.newsletter === "boolean") {
    const existing = await getUser(env, user.uid);
    if (!existing?.email) {
      return json({ error: "アカウント登録が完了していません" }, 400);
    }
    await env.AIMON_DB.prepare(
      `UPDATE users SET newsletter = ?1, updated_at = ?2 WHERE uid = ?3`
    )
      .bind(body.newsletter ? 1 : 0, now, user.uid)
      .run();
    return json({ ok: true, email, newsletter: !!body.newsletter });
  }

  return json({ error: "処理できませんでした" }, 400);
}
