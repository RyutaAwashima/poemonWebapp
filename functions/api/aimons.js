import { authFromRequest } from "./_auth.js";
import { getOrigin, toOriginView } from "./_registry.js";
import { getCollectionLimit } from "./_credits.js";
import { getUser } from "./_users.js";
import { normalizeSlots, applyEffects } from "./_slots.js";
import { normalizeTraining } from "./_level.js";
import { saveAimons } from "./_aimon-store.js";
import { generateMonster } from "./_monster-gen.js";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AIMON_ID_RE = /^[0-9a-f]{12}-R[1-4]$/;
// メイモ/クロエ等の originFixed 持ちメイモンは、イラスト調整・フレーバー再生成を開発者/管理者アカウントに限定する。
const STAFF_ROLES = new Set(["developer", "admin"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// 旧版（uuid ベース）コレクションの一回限り移行。
// aimons:{uid} が空のときだけ aimons:{oldUuid} をコピーする（既存データを上書きしない）。
async function migrateCollection(env, uid, oldUuid) {
  const destKey = `aimons:${uid}`;
  const srcKey = `aimons:${oldUuid}`;
  const dest = await env.AIMON_KV.get(destKey, "json");
  if (dest && dest.length > 0) return;
  const src = await env.AIMON_KV.get(srcKey, "json");
  if (!src || src.length === 0) return;
  await env.AIMON_KV.put(destKey, JSON.stringify(src));
  await env.AIMON_KV.delete(srcKey);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// 各カードに発見者（初発見者レジストリ）情報を付与する。最大30枚なので読みは軽量。
// 読み出しは D1 monster_registry 優先（KV aimon-origin:{baseHash} フォールバック＋遅延移行）。
// 過去に保存したカード（レジストリ導入前）も自動バックフィルされる。フル uid は返さない。
// isStaff: メイモ/クロエ等 originFixed 持ちのメイモンで isMine（イラスト調整権限）を開発者/管理者に限定するためのフラグ。
async function enrichAimons(env, aimons, uid, isStaff) {
  return Promise.all(
    aimons.map(async (aimon) => {
      // 育成スロット補完 + 効果適用（normalize）。slots は DB に無いため毎回補完する。
      // applyEffects は hp/p/s/t・skill.value を加算済みに更新し、baseStats は素のまま残す（差分表示用）。
      aimon.slots = normalizeSlots(aimon.slots, aimon.rarity, aimon.level);
      applyEffects(aimon);
      // 育成レベル正規化（旧データはレベル1・XP0・masterpiece:false で補完）。
      const training = normalizeTraining(aimon);
      aimon.level = training.level;
      aimon.xp = training.xp;
      aimon.masterpiece = training.masterpiece;
      // originFixed（メイモ/クロエ等の公式マスコット）は固定表示・isMine は開発者/管理者のみ true。
      if (aimon.originFixed) {
        return { ...aimon, origin: { nickname: aimon.originFixed, shortUid: "", isMine: isStaff, discoveredAt: null } };
      }
      const baseHash = String(aimon.id || "").slice(0, 12);
      if (!/^[0-9a-f]{12}$/.test(baseHash)) return { ...aimon, origin: null };
      const record = await getOrigin(env, baseHash);
      if (!record) return { ...aimon, origin: null };
      return { ...aimon, origin: toOriginView(record, uid) };
    })
  );
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  // 認証必須。Authorization: Bearer <Firebase ID token> から uid を特定する。
  const user = await authFromRequest(env, request);
  if (!user) {
    return json({ error: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const kvKey = `aimons:${user.uid}`;

  // 旧版 localStorage uuid からの一回限り移行（uid 側が空のときのみコピー）。
  const migrateFrom = url.searchParams.get("migrateFrom");
  if (migrateFrom && UUID_RE.test(migrateFrom) && migrateFrom !== user.uid) {
    await migrateCollection(env, user.uid, migrateFrom);
  }

  if (request.method === "GET") {
    const data = (await env.AIMON_KV.get(kvKey, "json")) || [];
    const me = await getUser(env, user.uid);
    const isStaff = !!me && STAFF_ROLES.has(me.role);
    const aimons = await enrichAimons(env, data, user.uid, isStaff);
    return json({ aimons });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
    const aimon = body?.aimon;
    if (!aimon?.id || !AIMON_ID_RE.test(aimon.id)) {
      return json({ error: "invalid aimon" }, 400);
    }
    if (!aimon.name || typeof aimon.name !== "string") {
      return json({ error: "invalid aimon" }, 400);
    }

    // ── 対策1: クライアント送信カードの整合性をサーバー側で検証 ──
    // 名前からサーバー側で決定論的に再生成し、(1) id（名前+レア度のハッシュ）の一致と
    // (2) 未育成ベース値 baseStats の一致を確認する。育成済み（slots適用）でも
    // baseStats は素のまま保たれるため、この比較でステータス偽装は無効化される。
    // baseStats を持たない旧データは id 検証のみ行う（互換維持・後方互換）。
    let regenerated;
    try {
      regenerated = await generateMonster(aimon.name, new URL(request.url).origin);
    } catch {
      return json({ error: "invalid aimon" }, 400);
    }
    if (aimon.id !== regenerated.id) {
      return json({ error: "invalid aimon" }, 400);
    }
    if (aimon.baseStats) {
      const a = aimon.baseStats;
      const b = regenerated.baseStats;
      const statMismatch = ["hp", "p", "s", "t"].some((k) => a[k] !== b[k]);
      if (statMismatch) return json({ error: "invalid aimon" }, 400);
    }

    const data = (await env.AIMON_KV.get(kvKey, "json")) || [];
    const limit = await getCollectionLimit(env, user.uid);
    if (data.length >= limit) {
      return json({ error: `collection full (max ${limit})` }, 400);
    }
    if (data.find((a) => a.id === aimon.id)) {
      return json({ error: "already saved" }, 409);
    }

    data.push({ ...aimon, savedAt: new Date().toISOString() });
    await saveAimons(env, user.uid, data);
    return json({ aimon, total: data.length });
  }

  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "missing id" }, 400);

    const data = (await env.AIMON_KV.get(kvKey, "json")) || [];
    const filtered = data.filter((a) => a.id !== id);
    await saveAimons(env, user.uid, filtered);
    return json({ removed: data.length - filtered.length });
  }

  return json({ error: "method not allowed" }, 405);
}
