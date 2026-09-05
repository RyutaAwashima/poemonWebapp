// アイモン生成時に一度だけ呼び出す、アイモン画像の自動生成・永続化エンドポイント。
// Gemini (gemini-2.5-flash-image) をメインの画像生成に使用し、
// 失敗時は Replicate (black-forest-labs/flux-schnell) にフォールバックする。
// 生成した画像はR2バケット(AIMON_IMAGES)へ保存する。
// GET  /api/monster-image?id={monsterId}          → R2に保存済みの画像をストリーム配信
// POST /api/monster-image { monsterId, name, rarity, p, s, t } → 画像生成＋R2保存、{ url } を返す

import { authFromRequest } from "./_auth.js";
import { getNickname, isAccountLocked, getUser } from "./_users.js";
import { getOrigin, toOriginView } from "./_registry.js";
import { summonCost } from "./_summon.js";
import { claimInteractionBonus, getCollectionLimit } from "./_credits.js";
import { reportBillingIncident } from "./_alerts.js";
import { saveAimons } from "./_aimon-store.js";
import { generateMonster } from "./_monster-gen.js";
import { isUniqueMonster, getUniqueMonsterFromKv, toMonsterFormat } from "./_unique-monsters.js";
import { logError } from "./_error-log.js";
import {
  IMAGE_COST,
  ART_STYLES,
  r2Key,
  logHistory,
  generateAndSaveNewMonster,
} from "./_image-gen-core.js";

// functions/api/profile-image.js が同じアートスタイル定義を流用するための再エクスポート。
export { ART_STYLES };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const AIMON_ID_RE = /^[0-9a-f]{12}-R[1-4]$/;
// メイモ/クロエ等 originFixed 持ちのユニークモンスターは、イラスト調整・フレーバー再生成を開発者/管理者アカウントに限定する（party.js の isParent 判定用）。
const STAFF_ROLES = new Set(["developer", "admin"]);

const IN_FLIGHT_TTL_MS = 5 * 60 * 1000; // 画像生成ロックの期限（5分超で掃除）
// コレクション上限は users.collection_limit（aimons.js と同一・既定30・ショップで拡張可・最大99）。

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ユーザーのコレクション（aimons:{uid} KV）を読み出す。失敗時は空配列（防御的）。
async function getCollection(env, uid) {
  try {
    return (await env.AIMON_KV.get(`aimons:${uid}`, "json")) || [];
  } catch {
    return [];
  }
}

// 課金済みの場合の返金（credit_tx refund の INSERT OR IGNORE で冪等・設計 §5.3）。
// ref は対応する課金（chargeRef）と同じ値を渡すこと。monsterId 固定だと同一アイモン名の
// 再挑戦（失敗→リトライ）で UNIQUE(uid,reason,ref) に衝突し、2回目以降の返金が無視されるバグがあった。
async function refundCredits(env, uid, cost, ref, now) {
  const refund = await env.AIMON_DB.prepare(
    "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, created_at) VALUES (?1, ?2, 'refund', ?3, ?4)"
  )
    .bind(uid, cost, ref, now)
    .run();
  if (refund.meta?.changes > 0) {
    await env.AIMON_DB.prepare("UPDATE users SET credits = credits + ?1 WHERE uid = ?2")
      .bind(cost, uid)
      .run();
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const url = new URL(request.url);

  if (request.method === "GET") {
    // 生成前の確認ダイアログ用プレフライト（認証必須・画像は配信しない）。
    //   GET /api/monster-image?check=1&id={monsterId}
    //   → { exists, owned, cost, collectionCount, collectionFull }
    if (url.searchParams.get("check") === "1") {
      const checkUser = await authFromRequest(env, request);
      if (!checkUser) return json({ error: "unauthorized" }, 401);
      const cid = url.searchParams.get("id");
      if (!cid || !AIMON_ID_RE.test(cid)) return json({ error: "invalid id" }, 400);
      const exists = !!(await env.AIMON_IMAGES.head(r2Key(cid)));
      const collection = await getCollection(env, checkUser.uid);
      const owned = collection.some((a) => a.id === cid);
      return json({
        exists,
        owned,
        cost: summonCost(), // 召喚時のコスト（召喚祭中は1）
        collectionCount: collection.length,
        collectionFull: collection.length >= (await getCollectionLimit(env, checkUser.uid)),
      });
    }

    const id = url.searchParams.get("id");
    if (!id || !AIMON_ID_RE.test(id)) return json({ error: "invalid id" }, 400);

    const object = await env.AIMON_IMAGES.get(r2Key(id));
    if (!object) return json({ error: "not found" }, 404);

    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType || "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
        ...CORS,
      },
    });
  }

  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  // 画像の取得(GET)は公開（<img> タグや共有フィードで使用）だが、生成(POST)は認証必須。
  // 生成はクレジット 1 枚を消費する（設計 §5.2・§5.3）。
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

  // ── 対策1: クライアントのパラメータは信用せず、名前からサーバー側で決定論的に再生成 ──
  // レアリティ/ステータス/スキル/世界観はすべてサーバー生成値を正として使用する（偽装無効化）。
  // 名前検証（NGワード等）もサーバー側で行う（無効名は 400）。
  // クライアントは { name } だけ送ればよく、id/rarity/p/s/t/world は送信しても無視される。
  const { name: rawName, chargeId: preChargeId } = body || {};
  if (!rawName || typeof rawName !== "string" || !rawName.trim()) {
    return json({ error: "missing name" }, 400);
  }
  let aimon;
  try {
    const origin = new URL(request.url).origin;
    aimon = await generateMonster(rawName, origin);
  } catch (e) {
    return json({ error: e.message || "invalid name" }, 400);
  }

  // ── ユニークモンスター: 画像生成をスキップし pre-uploaded 画像を返す ──
  // 開発者定義の特殊モンスター。Gemini/Replicate で新規生成せず、R2 の pre-uploaded 画像を使う。
  // コレクションへの保存は通常の召喚フローと同じ形式で行う。
  if (isUniqueMonster(aimon.name)) {
      const uniqueData = await getUniqueMonsterFromKv(env, aimon.name);
    if (uniqueData) {
      const um = toMonsterFormat(uniqueData);
      const umMonsterId = um.id;
      const umBaseHash = um.hash;
      const now = Date.now();

      // originFixed（メイモ/クロエ等の公式マスコット）は「メイモン公式」固定表示。
      // isMine（イラスト調整・フレーバー再生成の許可）は開発者/管理者ロールのみ true。
      let originView = null;
      if (um.originFixed) {
        const me = await getUser(env, user.uid);
        const isStaff = !!me && STAFF_ROLES.has(me.role);
        originView = { nickname: um.originFixed, shortUid: "", isMine: isStaff, discoveredAt: null };
      }

      // ニックネーム確認
      let nickname = null;
      try {
        nickname = await getNickname(env, user.uid);
        if (!nickname) {
          return json({ error: "nickname_required", message: "ニックネームを設定してから生成してください" }, 403);
        }
      } catch (e) {
        return json({ error: e.message || "validation failed" }, 502);
      }

      const collection = await getCollection(env, user.uid);
      const limit = await getCollectionLimit(env, user.uid);

      // 既に所有しているか確認
      const owned = collection.some((a) => a.id === umMonsterId);
      if (owned) {
        return json({
          url: um.imageUrl,
          source: "cache",
          cost: 0,
          origin: originView,
          isNewDiscovery: false,
          owned: true,
          collectionCount: collection.length,
        });
      }

      // コレクション上限チェック
      if (collection.length >= limit) {
        return json({
          error: "collection_full",
          message: `コレクションが満杯です（上限 ${limit}体）。編成ページで不要なメイモンを削除してください`,
        }, 400);
      }

      // ユニークモンスターは無料でコレクションに追加（クレジット消費なし）
      const aimonToStore = {
        ...um,
        id: umMonsterId,
        imageUrl: um.imageUrl,
        savedAt: new Date().toISOString(),
      };
      try {
        collection.push(aimonToStore);
        await saveAimons(env, user.uid, collection);
      } catch {
        return json({ error: "collection_save_failed", message: "コレクションへの保存に失敗しました" }, 502);
      }

      await logHistory(env, user.uid, umMonsterId, aimon.name, um.rarity, "unique", 0, now);
      return json({
        url: um.imageUrl,
        source: "unique",
        cost: 0,
        origin: originView,
        isNewDiscovery: false,
        owned: true,
        acquired: true,
        collectionCount: collection.length,
      });
    }
  }

  // 以後はサーバー生成値のみ使う（クライアント送信値は id/rarity/p/s/t/world とも無視）。
  const monsterId = aimon.id;
  const baseHash = monsterId.slice(0, 12);
  const name = aimon.name;
  const rarity = aimon.rarity;
  const p = aimon.p;
  const s = aimon.s;
  const t = aimon.t;
  const world = aimon.world;

  // ── 同時実行ロック（ユーザー単位の in-flight 1本化） ────────
  // 同じユーザーが画像生成を同時に複数リクエストしても1本だけ通す（生成費用の暴走・二重課金防止）。
  // 開始前に古いロック（5分超）を掃除し、INSERT OR IGNORE（uid が PK）で獲得する。
  const now = Date.now();
  const unlock = async () => {
    try {
      await env.AIMON_DB.prepare("DELETE FROM image_jobs WHERE uid = ?1").bind(user.uid).run();
    } catch {}
  };
  try {
    await env.AIMON_DB.prepare("DELETE FROM image_jobs WHERE uid = ?1 AND started_at < ?2")
      .bind(user.uid, now - IN_FLIGHT_TTL_MS)
      .run();
    const lock = await env.AIMON_DB.prepare(
      "INSERT OR IGNORE INTO image_jobs (uid, monster_id, started_at) VALUES (?1, ?2, ?3)"
    )
      .bind(user.uid, monsterId, now)
      .run();
    if (lock.meta?.changes === 0) {
      return json(
        { error: "generation_in_progress", message: "画像生成は処理中です。少し待ってからお試しください" },
        429
      );
    }
  } catch {
    // ロック基盤（D1）が未適用でも従来どおり生成を許可する（マイグレーション前の後方互換）。
  }

  // ── ニックネームゲート（レジストリ記録は生成成功時に行う） ──
  // 名前検証と決定論的生成は上のブロックで完了済み。
  // ニックネーム未設定のユーザーは「発見（画像生成）」自体をブロックする（設計 §9.3②・§9.9）。
  let nickname = null;
  try {
    // ニックネームは D1 users テーブルから読む（移行待ち分は _users.js が KV へフォールバック）。
    nickname = await getNickname(env, user.uid);
    if (!nickname) {
      await unlock();
      return json(
        { error: "nickname_required", message: "ニックネームを設定してから生成してください" },
        403
      );
    }
  } catch (e) {
    await unlock();
    return json({ error: e.message || "validation failed" }, 502);
  }

  // 課金済みかどうかと課金額（失敗時の返金判定に使う。課金前の失敗では返金しない）。
  let charged = false;
  let chargedCost = IMAGE_COST;
  // credit_tx.ref: monsterId をそのまま使うと同じアイモン名の再挑戦（失敗→リトライ）で
  // UNIQUE(uid,reason,ref) に衝突し、2回目以降の返金が INSERT OR IGNORE で無視される
  // バグがあったため、試行ごとに一意な値にする（返金と対応づけられるよう charge/refund で共有）。
  let chargeRef = null;
  try {
    // コレクションは新規生成（自動保存）・召喚（所有権追加）の両方で使うため先に読む。
    const collection = await getCollection(env, user.uid);
    // コレクション上限（users.collection_limit・既定30・ショップで拡張可・最大99）。
    const limit = await getCollectionLimit(env, user.uid);
    const existing = await env.AIMON_IMAGES.head(r2Key(monsterId));
    if (existing) {
      const record = await getOrigin(env, baseHash);
      const originView = toOriginView(record, user.uid);
      // 所有権はコレクション（aimons:{uid}）の有無で判定する
      // （自分で生成/召喚したアイモンはコレクションに入っている）。
      const ownedEntry = collection.find((a) => a.id === monsterId);
      const owned = !!ownedEntry;

      if (owned) {
        // ② 自分のコレクションのアイモン → 再呼び出し（クレジット消費なし・設計 §5.8②）。
        if (ownedEntry.imageUrl !== null) {
          await unlock();
          return json({
            url: `/api/monster-image?id=${monsterId}`,
            source: "cache",
            cost: 0,
            origin: originView,
            isNewDiscovery: false,
            owned: true,
            collectionCount: collection.length,
            // 保存済みの確定フレーバー(AI反映済み)をカード更新用に返す（フォールバック表示バグの修正・2026-08-22）。
            skill: ownedEntry.skill || null,
          });
        }
        // imageUrl === null のまま所有権だけある場合: charge.js での引き落とし後、画像生成前に
        // クラッシュ等で中断されている（既に課金済みのため、ここでは追加課金しない・無料で完成させる）。
        try {
          const result = await generateAndSaveNewMonster(env, {
            user, aimon, nickname, source: "generate", cost: 0,
          });
          await unlock();
          return json({ ...result, cost: 0, owned: true });
        } catch (e) {
          await logError(env, {
            scope: "monster-image-resume-inline",
            uid: user.uid,
            message: e?.message || String(e),
            detail: { monsterId },
          });
          await unlock();
          return json({ error: e.message || "image generation failed" }, 502);
        }
      }

      // ③ 他人生成のキャッシュ → 「召喚」で所有権を獲得する（設計 §5.8③・2026-08-07）。
      // 召喚祭（時限キャンペーン）開催中はコストが 2 → 1 に半減。
      if (collection.length >= limit) {
        await unlock();
        return json(
          {
            error: "collection_full",
            message: `コレクションが満杯です（上限 ${limit}体）。編成ページで不要なメイモンを削除してください`,
          },
          400
        );
      }
      // Phase 2: chargeId が渡されている場合は /api/monster/charge で課金済み（二重課金防止）。
      if (preChargeId) {
        charged = true;
        chargeRef = preChargeId;
        const chargedParts = preChargeId.split("-");
        chargedCost = summonCost(); // charge.js と同一のコスト計算
        // charge_ref の UNIQUE 制約で二重課金を防止（冪等）。
        // 既に同じ ref で INSERT 済みならスキップ（リトライケース）。
        await env.AIMON_DB.prepare(
          "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, created_at) VALUES (?1, ?2, 'summon', ?3, ?4)"
        )
          .bind(user.uid, -chargedCost, chargeRef, now)
          .run();
      } else {
        const charge = await env.AIMON_DB.prepare(
          "UPDATE users SET credits = credits - ?1, updated_at = ?2 WHERE uid = ?3 AND credits >= ?1"
        )
          .bind(chargedCost, now, user.uid)
          .run();
        if (charge.meta?.changes === 0) {
          await unlock();
          return json(
            {
              error: "insufficient_credits",
              message: "クレジットが不足しています。デイリーボーナスを受け取るか、クレジットパックをご利用ください",
            },
            403
          );
        }
        charged = true;
        chargeRef = `${monsterId}-${crypto.randomUUID()}`;
        await env.AIMON_DB.prepare(
          "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, created_at) VALUES (?1, ?2, 'summon', ?3, ?4)"
        )
          .bind(user.uid, -chargedCost, chargeRef, now)
          .run();
      }

      // 所有権を獲得: 召喚者のコレクションへ自動追加（「おや」は初発見者を保持したまま）。
      // カード情報はサーバー側で再生成した正のアイモン（aimon）をそのまま使う（対策1・偽装無効）。
      // ① 召喚者自身のコレクションにあればそれを使う（再召喚）。
      // ② なければ親（初発見者）のコレクションからAIフレーバーを引き継ぐ。
      const existingEntry = collection.find((a) => a.id === monsterId);
      let inheritedSkill = existingEntry?.skill || null;
      if (!inheritedSkill && record?.uid && record.uid !== user.uid) {
        try {
          const parentCollection = (await env.AIMON_KV.get(`aimons:${record.uid}`, "json")) || [];
          const parentEntry = parentCollection.find((a) => a.id === monsterId);
          if (parentEntry?.skill) inheritedSkill = parentEntry.skill;
        } catch { /* 親のコレクション読み失敗は無視（フォールバック） */ }
      }
      const aimonToStore = {
        ...aimon,
        ...(inheritedSkill ? { skill: inheritedSkill } : {}),
        id: monsterId,
        imageUrl: `/api/monster-image?id=${monsterId}`,
        savedAt: new Date().toISOString(),
      };
      try {
        // 既に所有していれば上書き、なければ追加
        const existIdx = collection.findIndex((a) => a.id === monsterId);
        if (existIdx >= 0) {
          collection[existIdx] = aimonToStore;
        } else {
          collection.push(aimonToStore);
        }
        await saveAimons(env, user.uid, collection);
      } catch {
        // 保存失敗時は返金して所有権を与えない（二重取り防止）。
        try { await refundCredits(env, user.uid, chargedCost, chargeRef, now); } catch (e) {
          await reportBillingIncident(env, { kind: "refund_failed", uid: user.uid, ref: chargeRef, detail: { monsterId, cost: chargedCost, context: "summon_save_failed", error: e?.message } });
        }
        charged = false;
        await unlock();
        return json({ error: "summon_save_failed", message: "召喚に失敗しました。もう一度お試しください" }, 502);
      }
      await logHistory(env, user.uid, monsterId, name, rarity, "summon", chargedCost, now);
      // 召喚はインプレッション操作（M5）: 共有ボーナス（1日1回）を付与。
      const bonus = await claimInteractionBonus(env, user.uid, now);
      await unlock();
      return json({
        url: `/api/monster-image?id=${monsterId}`,
        source: "summon",
        cost: chargedCost,
        origin: originView,
        isNewDiscovery: false,
        owned: true,
        acquired: true,
        collectionCount: collection.length,
        bonusGranted: bonus.bonusGranted,
        credits: bonus.credits,
        // 初発見者から引き継いだ確定フレーバーをカード更新用に返す（フォールバック表示バグの修正・2026-08-22）。
        skill: aimonToStore.skill || null,
      });
    }

    // ── ① 新規生成: クレジット消費（1枚・アトミック） ───────────
    // ワンストップ保存（M4）: 生成したアイモンはコレクションへ自動保存するため、
    // 課金前に満杯チェック（設計 §5.8③ と同様・有償拒否防止）。
    if (collection.length >= limit) {
      await unlock();
      return json(
        {
          error: "collection_full",
          message: `コレクションが満杯です（上限 ${limit}体）。編成ページで不要なメイモンを削除してください`,
        },
        400
      );
    }
    // Phase 2: chargeId が渡されている場合は /api/monster/charge で課金済み（二重課金防止）。
    if (preChargeId) {
      charged = true;
      chargeRef = preChargeId;
      chargedCost = IMAGE_COST; // charge.js と同一のコスト
      await env.AIMON_DB.prepare(
        "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, created_at) VALUES (?1, ?2, 'image', ?3, ?4)"
      )
        .bind(user.uid, -IMAGE_COST, chargeRef, now)
        .run();
    } else {
      // 残高が足りない UPDATE は changes=0 になるため、二重消費や残高マイナスは起きない（設計 §5.2）。
      const charge = await env.AIMON_DB.prepare(
        "UPDATE users SET credits = credits - ?1, updated_at = ?2 WHERE uid = ?3 AND credits >= ?1"
      )
        .bind(IMAGE_COST, now, user.uid)
        .run();
      if (charge.meta?.changes === 0) {
        await unlock();
        return json(
          {
            error: "insufficient_credits",
            message: "クレジットが不足しています。デイリーボーナスを受け取るか、クレジットパックをご利用ください",
          },
          403
        );
      }
      charged = true;
      chargeRef = `${monsterId}-${crypto.randomUUID()}`;
      await env.AIMON_DB.prepare(
        "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, created_at) VALUES (?1, ?2, 'image', ?3, ?4)"
      )
        .bind(user.uid, -IMAGE_COST, chargeRef, now)
        .run();
    }

    const result = await generateAndSaveNewMonster(env, {
      user, aimon, nickname, source: "generate", cost: IMAGE_COST,
    });
    await unlock();
    return json(result);
  } catch (e) {
    // 課金済みの場合のみクレジットを返金する（生成失敗で画像が無いため・設計 §5.3）。
    // 課金前の失敗（キャッシュ取得エラー等）では返金しない（誤加算防止）。
    // Phase 2: chargeId ベースの事前課金でも、failedCost（実際の課金額）で正しく返金する。
    if (charged) {
      const failedCost = preChargeId ? chargedCost : IMAGE_COST;
      try { await refundCredits(env, user.uid, failedCost, chargeRef, now); } catch (e) {
        await reportBillingIncident(env, { kind: "refund_failed", uid: user.uid, ref: chargeRef, detail: { monsterId, cost: failedCost, context: "generation_failed", error: e?.message } });
      }
    }
    await logError(env, {
      scope: "monster-image",
      uid: user.uid,
      message: e?.message || String(e),
      detail: { monsterId, chargeRef, charged },
    });
    await unlock();
    return json({ error: e.message || "image generation failed" }, 502);
  }
}
