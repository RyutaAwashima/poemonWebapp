// functions/api/monster/generate.js
// アイモン生成（サーバー側・対策1）。クライアントの generateMonster を置き換える。
// 決定論ロジック（名前→レアリティ/ステータス/スキル/世界観）は _monster-gen.js に集約し、
// クライアントからは隠蔽する（オフラインでの当たり名前の無料試算を防ぐ）。
// リクエスト: { name } → { aimon }（保存・課金はしない。画像生成は別途 monster-image）。
// 認証必須・レート制限付き（無料ブルートフォース抑制）。
// ユニークモンスター（開発者定義）はハッシュ生成をスキップし、定義データを直接返す。
import { authFromRequest } from "../_auth.js";
import { CORS, json } from "../_credits.js";
import { isAccountLocked } from "../_users.js";
import { isRateLimited } from "../_rate-limit.js";
import { generateMonster, generateMonsterFromName } from "../_monster-gen.js";
import { isUniqueMonster, getUniqueMonsterFromKv, toMonsterFormat } from "../_unique-monsters.js";

const MAX_NAME_LENGTH = 20; // 入力の安全上限（生成自体は trim 後の文字列で決定論）
const RATE_LIMIT = 60; // 1ユーザー 60回/分（試算ブルートフォース抑制。feed 表示等は別キャッシュ）

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
  const nameInput = typeof body?.name === "string" ? body.name.trim() : "";
  if (!nameInput) {
    return json({ error: "missing name" }, 400);
  }
  if (nameInput.length > MAX_NAME_LENGTH) {
    return json({ error: "name too long", max: MAX_NAME_LENGTH }, 400);
  }

  // 無料試算対策: 1ユーザーあたりの短時間大量リクエストを制限する（認証済みでも）。
  if (isRateLimited("monster-generate", user.uid, RATE_LIMIT)) {
    return json({ error: "rate_limited", message: "生成の試行が多すぎます。少し待ってからお試しください" }, 429);
  }

  try {
    const origin = new URL(request.url).origin;

    // ユニークモンスター: 開発者定義の特殊モンスター。ハッシュ生成をスキップして定義データを直接返す。
    // NGワードチェック不要（開発者が事前確認済み）。
    if (isUniqueMonster(nameInput)) {
      const uniqueData = await getUniqueMonsterFromKv(env, nameInput);
      if (uniqueData) {
        const aimon = toMonsterFormat(uniqueData);
        return json({ aimon });
      }
    }

    // 通常モンスター: NGワード等はサーバー側で検証（クライアント name-filter と同一ルール）。
    const aimon = await generateMonster(nameInput, origin);
    return json({ aimon });
  } catch (e) {
    // NGワード/版権名（normalizeName の throw）は 400 で返す。
    return json({ error: e.message || "generation failed", code: "invalid_name" }, 400);
  }
}

// 検証済み名から生成する純粋関数（テスト/検証用に再エクスポート）。
export { generateMonsterFromName };
