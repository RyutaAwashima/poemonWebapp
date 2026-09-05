// functions/api/aimons/merge.js
// 初回登録・ログイン時のコレクション安全引き継ぎ用マージエンドポイント。
//   POST /api/aimons/merge { aimons: [...] }
// ローカルフォールバック（localStorage）に退避されていたアイモンをアカウント
// （aimons:{uid}）へマージする。安全性:
//   - 既存データは一切上書き・削除しない（id で重複排除）
//   - 追加後もコレクション上限（users.collection_limit・既定30）を超えない
//   - 上限超過で追加できなかった分は leftover として返し、クライアントはローカルに残す
// 応答: { total, added, skipped, full, leftover }

import { authFromRequest } from "../_auth.js";
import { getCollectionLimit } from "../_credits.js";
import { saveAimons } from "../_aimon-store.js";

const AIMON_ID_RE = /^[0-9a-f]{12}-R[1-4]$/;

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

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const incoming = Array.isArray(body?.aimons) ? body.aimons : null;
  if (!incoming) {
    return json({ error: "invalid aimons" }, 400);
  }

  // 不正な id は黙って除外（壊れたローカルデータでコレクションを汚さない）。
  const valid = incoming.filter(
    (a) => a && typeof a?.id === "string" && AIMON_ID_RE.test(a.id)
  );

  const kvKey = `aimons:${user.uid}`;
  const data = (await env.AIMON_KV.get(kvKey, "json")) || [];
  const existingIds = new Set(data.map((a) => a.id));
  const limit = await getCollectionLimit(env, user.uid);

  let added = 0;
  let skipped = 0;
  let full = 0;
  const leftover = [];

  for (const aimon of valid) {
    if (existingIds.has(aimon.id)) {
      skipped++;
      continue;
    }
    if (data.length >= limit) {
      full++;
      leftover.push(aimon);
      continue;
    }
    data.push({ ...aimon, savedAt: new Date().toISOString() });
    existingIds.add(aimon.id);
    added++;
  }

  if (added > 0) {
    await saveAimons(env, user.uid, data);
  }

  return json({ total: data.length, added, skipped, full, leftover });
}
