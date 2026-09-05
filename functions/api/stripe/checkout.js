// functions/api/stripe/checkout.js
// クレジットパック購入の Stripe Checkout セッション作成。
//   POST /api/stripe/checkout  { packId }
// 認証必須＋登録済み（email）アカウントのみ（設計 §5.7・児童課金対策）。
// 成功 → { url, sessionId, pack }（クライアントは url へリダイレクトして Stripe Checkout で支払う）

import { authFromRequest } from "../_auth.js";
import { isAccountLocked } from "../_users.js";
import { CORS, json } from "../_credits.js";
import {
  getPack,
  callStripe,
  normalCredits,
  campaignCredits,
  isCampaignActive,
} from "../_stripe.js";
import { getAgeTier, getMonthlySpend } from "../_age_tier.js";

export async function onRequest(context) {
  const { request, env } = context;

  // Checkout 後のリダイレクトは、購入を開始した環境（オリジン）のショップへ戻す。
  // 本番ドメインでも開発用（*.pages.dev）でも購入元の環境に戻れるよう、
  // リクエストオリジンから動的に解決する（固定すると pages.dev 等で購入したときに
  // 本番ドメインへ飛ばされ、ショップに戻れなくなる）。
  const APP_ORIGIN = new URL(request.url).origin;

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
  // 匿名ユーザーは購入不可。登録（email 設定）を促す。
  if (!user.email) {
    return json(
      { error: "クレジット購入にはアカウント登録が必要です", code: "registration_required" },
      403
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const pack = getPack(body?.packId);
  if (!pack) {
    return json({ error: "invalid pack" }, 400);
  }

  // ── 未成年購入制限（2026-08-07 実装） ──────────────────────────
  // 購入前に年齢区分の確認（強制ポップアップ）が必須。月内の区分未設定・期限切れ（翌月）は購入不可。
  const tierInfo = await getAgeTier(env, user.uid);
  if (!tierInfo.effective || !tierInfo.tier) {
    return json(
      { error: "購入前に年齢区分の確認が必要です（ダッシュボードで選択してください）", code: "age_tier_required" },
      403
    );
  }
  // 未成年区分は月間購入上限（円）を適用。超過したら警告して購入をブロックする。
  if (tierInfo.limit != null) {
    const monthlySpend = await getMonthlySpend(env, user.uid);
    const projected = monthlySpend + pack.price;
    if (projected > tierInfo.limit) {
      return json(
        {
          error:
            `月間購入上限（¥${tierInfo.limit.toLocaleString()}）を超過します（今月 ¥${monthlySpend.toLocaleString()}＋今回 ¥${pack.price.toLocaleString()} = ¥${projected.toLocaleString()}）`,
          code: "purchase_limit",
          monthlySpend,
          limit: tierInfo.limit,
          remaining: Math.max(0, tierInfo.limit - monthlySpend),
        },
        403
      );
    }
  }

  // このユーザーが対象パックを既に購入済みか（初回購入ならキャンペーンの対象）。
  const purchasedRow = await env.AIMON_DB.prepare(
    "SELECT id FROM credit_tx WHERE uid = ?1 AND reason = 'purchase' AND pack = ?2 LIMIT 1"
  )
    .bind(user.uid, pack.id)
    .first();
  const firstPurchase = !purchasedRow;

  const campaignActive = isCampaignActive();
  const useCampaign = campaignActive && firstPurchase;
  // 付与枚数（通常: base+bonus / キャンペーン初回: base+bonus*2）。
  const credits = useCampaign ? campaignCredits(pack) : normalCredits(pack);
  // 今回のボーナス分（キャンペーン適用時のみ 2 倍。Webhook 側で初回判定を再検証するために記録）。
  const bonus = useCampaign ? pack.bonus * 2 : pack.bonus;

  try {
    const session = await callStripe(env, "/checkout/sessions", {
      mode: "payment",
      // アカウントで Managed Payments（Stripe Tax）が既定有効だが、
      // 税コード txcd_99999999 は Managed Payments の対象外で 502 になるため、
      // セッション単位で無効化し、税込み固定価格のまま Checkout を通す。
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "jpy",
      "line_items[0][price_data][unit_amount]": String(pack.price),
      "line_items[0][price_data][product_data][name]": `Aimon クレジットパック ${pack.name}`,
      "line_items[0][price_data][product_data][description]": `クレジット ${credits} 枚`,
      "managed_payments[enabled]": "false",
      success_url: `${APP_ORIGIN}/shop.html?stripe=success&pack=${pack.id}`,
      cancel_url: `${APP_ORIGIN}/shop.html?stripe=cancel`,
      client_reference_id: user.uid,
      "metadata[uid]": user.uid,
      "metadata[credits]": String(credits),
      "metadata[base]": String(pack.base),
      "metadata[bonus]": String(bonus),
      "metadata[pack]": pack.id,
      "metadata[campaign]": useCampaign ? "1" : "0",
    });

    // Stripe側のmetadataが何らかの理由で欠落してもwebhookが復元できるよう、
    // セッション作成時点のスナップショットを自前DBにも保存する（ベストエフォート・失敗しても購入は継続）。
    try {
      await env.AIMON_DB.prepare(
        `INSERT OR IGNORE INTO pending_purchases (session_id, uid, pack, credits, yen, campaign, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
        .bind(session.id, user.uid, pack.id, credits, pack.price, useCampaign ? 1 : 0, Date.now())
        .run();
    } catch {}

    return json({
      url: session.url,
      sessionId: session.id,
      pack: {
        id: pack.id,
        name: pack.name,
        price: pack.price,
        credits,
        campaign: useCampaign,
      },
    });
  } catch (err) {
    return json(
      { error: "決済セッションの作成に失敗しました", detail: err.message },
      502
    );
  }
}
