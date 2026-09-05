// functions/api/stripe/webhook.js
// Stripe Webhook 受信。checkout.session.completed でクレジットを付与する。
//   POST /api/stripe/webhook
// 署名検証: Stripe-Signature ヘッダ（t=...,v1=...）を STRIPE_WEBHOOK_SECRET（whsec_...）で
// HMAC-SHA256 検証する（Web Crypto・依存パッケージ無し）。
// 付与は credit_tx の UNIQUE(uid, reason='purchase', ref=sessionId) で冪等化する
// （Webhook 再送・二重処理で二重付与しない）。

import { CORS, json } from "../_credits.js";
import { getPack, normalCredits } from "../_stripe.js";
import { reportBillingIncident } from "../_alerts.js";

const MAX_BODY = 1_000_000;
const TOLERANCE_SEC = 5 * 60; // 署名タイムスタンプの寛容範囲（±5分）

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifySignature(secret, rawBody, signatureHeader) {
  if (!secret || !signatureHeader) return false;
  const parts = {};
  for (const item of signatureHeader.split(",")) {
    const idx = item.indexOf("=");
    if (idx < 0) continue;
    parts[item.slice(0, idx).trim()] = item.slice(idx + 1);
  }
  const timestamp = parts.t;
  const sig = parts.v1;
  if (!timestamp || !sig) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > TOLERANCE_SEC) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`)
  );
  const expected = new Uint8Array(mac);
  return timingSafeEqual(expected, hexToBytes(sig));
}

// checkout.session.completed でクレジット付与（冪等）。
async function grantOnCheckout(env, session) {
  if (session.payment_status && session.payment_status !== "paid") {
    return false;
  }
  let uid = session.metadata?.uid || session.client_reference_id || null;
  const ref = session.id || null;
  let packId = session.metadata?.pack || null;
  let credits = parseInt(session.metadata?.credits || "0", 10);
  let campaignFlag = session.metadata?.campaign === "1";

  // metadataが何らかの理由で欠落した場合のフォールバック: セッション作成時に
  // checkout.js が保存したスナップショット（pending_purchases）から復元する
  // （2026-08-08 実購入で session.metadata が空 {} になる事象が発生したため冗長化）。
  if (ref && (!uid || !(credits > 0))) {
    try {
      const pending = await env.AIMON_DB.prepare(
        "SELECT uid, pack, credits, campaign FROM pending_purchases WHERE session_id = ?1"
      )
        .bind(ref)
        .first();
      if (pending) {
        uid = uid || pending.uid;
        packId = packId || pending.pack;
        if (!(credits > 0)) credits = pending.credits;
        campaignFlag = campaignFlag || !!pending.campaign;
      }
    } catch {}
  }
  if (!uid || !(credits > 0) || !ref) {
    // 決済完了イベントを受信したのに、metadataもpending_purchasesも頸らず
    // uid/creditsを復元できなかった（=実際に課金されたのに付与できない）。即時アラート。
    await reportBillingIncident(env, {
      kind: "purchase_grant_failed",
      ref,
      detail: {
        sessionId: session.id,
        paymentStatus: session.payment_status,
        metadata: session.metadata,
        clientReferenceId: session.client_reference_id,
      },
    });
    return false;
  }

  const pack = packId ? getPack(packId) : null;
  const campaign = campaignFlag;
  if (campaign && pack) {
    // キャンペーン適用（初回購入）として Checkout を作ったが、
    // 決済完了時点で既に同パックの購入記録があれば通常枚数（base+bonus）へ差し戻す。
    // （並行購入などで二重に初回ボーナスが付かないようにする）
    const existing = await env.AIMON_DB.prepare(
      "SELECT id FROM credit_tx WHERE uid = ?1 AND reason = 'purchase' AND pack = ?2 LIMIT 1"
    )
      .bind(uid, packId)
      .first();
    if (existing) {
      credits = normalCredits(pack);
    }
  }

  const now = Date.now();
  // yen: 月間購入上限（未成年購入制限）の集計用に購入時の円額を記録する。
  const yen = pack?.price ?? null;
  const gate = await env.AIMON_DB.prepare(
    "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, pack, yen, created_at) VALUES (?1, ?2, 'purchase', ?3, ?4, ?5, ?6)"
  )
    .bind(uid, credits, ref, packId, yen, now)
    .run();
  if (gate.meta?.changes > 0) {
    // 匿名ユーザー（users 行なし）でも付与が反映されるよう UPSERT（デイリー付与と同様）。
    await env.AIMON_DB.prepare(
      `INSERT INTO users (uid, credits, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(uid) DO UPDATE SET credits = credits + excluded.credits, updated_at = excluded.updated_at`
    )
      .bind(uid, credits, now)
      .run();
  }
  return true;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY) {
    return json({ error: "too large" }, 413);
  }

  const signature = request.headers.get("stripe-signature") || "";
  const valid = await verifySignature(env.STRIPE_WEBHOOK_SECRET, rawBody, signature);
  if (!valid) {
    return json({ error: "invalid signature" }, 400);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  if (event.type === "checkout.session.completed") {
    await grantOnCheckout(env, event.data?.object || {});
  }

  return json({ received: true });
}
