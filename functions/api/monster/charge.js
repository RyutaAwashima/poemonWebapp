// functions/api/monster/charge.js
// 即引き落としAPI（リセマラ防止 Phase 2）。
// 画像生成の前にクレジットを確実に消費し、chargeId を発行する。
// クライアントはこの chargeId を /api/monster-image に渡す（二重課金防止）。
// POST /api/monster/charge { name } → { chargeId, cost, source, owned }
import { authFromRequest } from "../_auth.js";
import { CORS, json } from "../_credits.js";
import { isAccountLocked } from "../_users.js";
import { isRateLimited } from "../_rate-limit.js";
import { generateMonster } from "../_monster-gen.js";
import { isUniqueMonster, getUniqueMonsterFromKv, toMonsterFormat } from "../_unique-monsters.js";
import { summonCost } from "../_summon.js";
import { getCollectionLimit } from "../_credits.js";
import { saveAimons } from "../_aimon-store.js";
import { IMAGE_COST } from "../_image-gen-core.js";

const MAX_NAME_LENGTH = 20;
const RATE_LIMIT = 60; // 1ユーザー60回/分（generate と同一）

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

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const rawName = typeof body?.name === "string" ? body.name.trim() : "";
  if (!rawName) {
    return json({ error: "missing name" }, 400);
  }
  if (rawName.length > MAX_NAME_LENGTH) {
    return json({ error: "name too long", max: MAX_NAME_LENGTH }, 400);
  }

  if (isRateLimited("monster-charge", user.uid, RATE_LIMIT)) {
    return json({ error: "rate_limited", message: "処理が多すぎます。少し待ってからお試しください" }, 429);
  }

  try {
    const origin = new URL(request.url).origin;

    // ── ユニークモンスター: 画像生成不要・無料でコレクション追加 ──
    if (isUniqueMonster(rawName)) {
      const uniqueData = await getUniqueMonsterFromKv(env, rawName);
      if (uniqueData) {
        const um = toMonsterFormat(uniqueData);
        const collection = (await env.AIMON_KV.get(`aimons:${user.uid}`, "json")) || [];
        const owned = collection.some((a) => a.id === um.id);
        // 所有済み: 課金不要（image.js の owned パスで処理）
        if (owned) {
          return json({ chargeId: null, cost: 0, source: "unique", owned: true });
        }
        // 未所有: コレクション上限チェック
        const limit = await getCollectionLimit(env, user.uid);
        if (collection.length >= limit) {
          return json({ error: "collection_full", message: `コレクションが満杯です（上限 ${limit}体）` }, 400);
        }
        // ユニークモンスターは無料でコレクションに追加
        const aimonToStore = { ...um, id: um.id, imageUrl: um.imageUrl, savedAt: new Date().toISOString() };
        collection.push(aimonToStore);
        await saveAimons(env, user.uid, collection);
        return json({ chargeId: null, cost: 0, source: "unique", owned: false });
      }
    }

    // ── 通常モンスター: サーバー決定論生成 ──
    const aimon = await generateMonster(rawName, origin);
    const monsterId = aimon.id;

    // コレクション参照
    const collection = (await env.AIMON_KV.get(`aimons:${user.uid}`, "json")) || [];
    const limit = await getCollectionLimit(env, user.uid);
    const owned = collection.some((a) => a.id === monsterId);

    // ① 自分のコレクション → 再呼び出し（無料）
    if (owned) {
      return json({ chargeId: null, cost: 0, source: "cache", owned: true });
    }

    // コレクション上限チェック
    if (collection.length >= limit) {
      return json({
        error: "collection_full",
        message: `コレクションが満杯です（上限 ${limit}体）。編成ページで不要なメイモンを削除してください`,
      }, 400);
    }

    // ② 新規生成 or 他人の召喚: クレジット消費
    const existing = await env.AIMON_IMAGES.head(`monsters/${monsterId}.jpg`);
    const cost = existing ? summonCost() : IMAGE_COST;

    const now = Date.now();
    const charge = await env.AIMON_DB.prepare(
      "UPDATE users SET credits = credits - ?1, updated_at = ?2 WHERE uid = ?3 AND credits >= ?1"
    ).bind(cost, now, user.uid).run();

    if (charge.meta?.changes === 0) {
      return json({
        error: "insufficient_credits",
        message: "クレジットが不足しています。デイリーボーナスを受け取るか、クレジットパックをご利用ください",
      }, 403);
    }

    // chargeId 発行: monsterId + ランダムUUID（二重課金防止の KEY に利用）
    const chargeId = `${monsterId}-${crypto.randomUUID()}`;

    // credit_tx に記録（reason='image' / 'summon' で区別）
    const reason = existing ? "summon" : "image";
    await env.AIMON_DB.prepare(
      "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, created_at) VALUES (?1, ?2, ?3, ?4, ?5)"
    ).bind(user.uid, -cost, reason, chargeId, now).run();

    // 障害対策: 新規生成時は画像生成前にコレクション所有権を先に確保する。
    // ユーザー端末で画像生成中にブラウザがクラッシュしても、所有権は既にあるため、
    // 次回再生成/再取得時に無料で画像が得られる。
    if (!existing) {
      const aimonToReserve = {
        ...aimon,
        id: monsterId,
        imageUrl: null, // 画像未生成マーカー（monster-image.js で検知）
        savedAt: new Date().toISOString(),
      };
      const existIdx = collection.findIndex((a) => a.id === monsterId);
      if (existIdx >= 0) {
        collection[existIdx] = aimonToReserve;
      } else {
        collection.push(aimonToReserve);
      }
      await saveAimons(env, user.uid, collection);
    }

    return json({
      chargeId,
      cost,
      source: existing ? "summon" : "generate",
      owned: false,
    });
  } catch (e) {
    return json({ error: e.message || "charge failed" }, 500);
  }
}
