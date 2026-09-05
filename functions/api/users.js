// ユーザーのニックネーム（初発見者「おや」表示用）を管理するエンドポイント。
// D1 users テーブルに保存する（ニックネームは正規化済み UNIQUE 制約・30日クールダウンで変更可）。
//   GET  /api/users                  → { nickname, canChangeAt, createdAt, email }（未設定なら nickname: null）
//   POST /api/users { nickname }     → 登録／変更（30日クールダウン・一意制約付き）。{ nickname, canChangeAt } を返す
//   （メール登録は /api/users/account を参照）
//
// 注意: Firebase の displayName は ID token に含まれず Admin SDK が無い Worker からは読めないため、
// ニックネームは自前ストレージ（D1）に持つ。
// ニックネーム未設定のユーザーは画像生成（＝アイモン発見）ができない（monster-image.js 側で強制）。
// 既存 KV (user:{uid}) のデータは _users.js の遅延移行で D1 へ引き継がれる。

import { authFromRequest } from "./_auth.js";
import { USER_COOLDOWN_MS, normalizeNickname, getUser, toPublicUser } from "./_users.js";
import { grantSignupBonus } from "./_credits.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const NICKNAME_MAX = 20; // 全角1文字=1として数える（実用上の上限）
// 制御文字・全角スペースのみ等の「表示上壊れる文字」を弾く。
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const SPACES_ONLY_RE = /^[\s\u3000]+$/;

// NGワード／版権名リストを正規化する（クライアント側 name-filter.js と同一ルール）。
// normalizeNickname = NFKC + 小文字化 + カタカナ→ひらがな + 空白除去。
function normalizeForMatch(str) {
  return normalizeNickname(str);
}

// NGワード／版権名リストはクライアント側 (name-filter.js) と同じ JSON を同一オリジンから読み、
// モジュールスコープでキャッシュする（isr ごと。単一の情報源を保つ）。
// 読み込み失敗時は構造チェックのみにフォールバックし、正当なユーザーを阻害しない。
let cachedNgWords = null;
let cachedBrandWords = null;

async function loadWordLists(env, request) {
  if (cachedNgWords && cachedBrandWords) {
    return { ng: cachedNgWords, brand: cachedBrandWords };
  }
  try {
    const origin = new URL(request.url).origin;
    const [ngRes, brandRes] = await Promise.all([
      fetch(`${origin}/app/data/ng-words-ja.json`),
      fetch(`${origin}/app/data/blocked-brand-names.json`),
    ]);
    const ng = ngRes.ok ? await ngRes.json() : { words: [] };
    const brand = brandRes.ok ? await brandRes.json() : { words: [] };
    cachedNgWords = (ng.words || []).map(normalizeForMatch).filter(Boolean);
    cachedBrandWords = (brand.words || []).map(normalizeForMatch).filter(Boolean);
  } catch {
    cachedNgWords = cachedNgWords || [];
    cachedBrandWords = cachedBrandWords || [];
  }
  return { ng: cachedNgWords, brand: cachedBrandWords };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ニックネームを検証し、問題があれば { ok:false, error, reason } を返す。
async function validateNickname(env, request, raw) {
  if (typeof raw !== "string") return { ok: false, error: "ニックネームを入力してください" };
  const nickname = raw.normalize("NFKC").trim();
  if (!nickname) return { ok: false, error: "ニックネームを入力してください" };
  if (SPACES_ONLY_RE.test(nickname)) return { ok: false, error: "空白だけのニックネームは使えません" };
  if (CONTROL_CHAR_RE.test(nickname)) return { ok: false, error: "ニックネームに制御文字は使えません" };
  // 視覚的な文字数で数える（サロゲートペア・結合文字も概ね1文字扱い）。
  const length = [...nickname].length;
  if (length > NICKNAME_MAX) {
    return { ok: false, error: `ニックネームは${NICKNAME_MAX}文字以内にしてください` };
  }

  // クライアント側と同じ NG ワード／版権名チェック（部分一致・正規化済み）。
  const { ng, brand } = await loadWordLists(env, request);
  const norm = normalizeNickname(nickname);
  if (ng.some((w) => w && norm.includes(w))) {
    return { ok: false, error: "このニックネームは使用できません", reason: "ng" };
  }
  if (brand.some((w) => w && norm.includes(w))) {
    return { ok: false, error: "このニックネームは使用できません", reason: "brand" };
  }

  return { ok: true, nickname };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  // メンテナンスチェック（管理者はバイパス）
  const { checkMaintenance } = await import("./_maintenance.js");
  const m = await checkMaintenance(context);
  if (m) return m.response;

  const user = await authFromRequest(env, request);
  if (!user) {
    return json({ error: "unauthorized" }, 401);
  }

  const uid = user.uid;
  const now = Date.now();

  if (request.method === "GET") {
    const row = await getUser(env, uid);
    // 移行待ちで KV にしかニックネームが無いケースは表示用にフォールバックする。
    const kv = await env.AIMON_KV.get(`user:${uid}`, "json");
    const fallbackNickname = row?.nickname ? null : kv?.nickname || null;
    return json(toPublicUser(row, { tokenEmail: user.email || null, fallbackNickname }));
  }

  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const check = await validateNickname(env, request, body?.nickname);
  if (!check.ok) {
    return json({ error: check.error, reason: check.reason }, 400);
  }

  const row = await getUser(env, uid);

  // 既存ユーザーは 30 日クールダウン（前回ニックネーム変更から）をサーバー側で強制する。
  if (row?.nickname_updated_at) {
    const elapsed = now - row.nickname_updated_at;
    if (elapsed < USER_COOLDOWN_MS) {
      const remainingDays = Math.ceil((USER_COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000));
      return json(
        { error: `ニックネームは30日に1回しか変更できません（あと${remainingDays}日）`, cooldownDays: remainingDays },
        429
      );
    }
  }

  // 一意制約（正規化済みニックネーム）。自分以外で既に使われていれば 409。
  const norm = normalizeNickname(check.nickname);
  const clash = await env.AIMON_DB.prepare(
    "SELECT uid FROM users WHERE nickname_norm = ?1 AND uid != ?2 LIMIT 1"
  )
    .bind(norm, uid)
    .first();
  if (clash) {
    return json({ error: "このニックネームは既に別のユーザーが使用しています", reason: "taken" }, 409);
  }

  const email = user.email || null;
  if (row) {
    await env.AIMON_DB.prepare(
      `UPDATE users SET nickname = ?1, nickname_norm = ?2, nickname_updated_at = ?3,
        email = COALESCE(email, ?4), updated_at = ?5
       WHERE uid = ?6`
    )
      .bind(check.nickname, norm, now, email, now, uid)
      .run();
  } else {
    await env.AIMON_DB.prepare(
      `INSERT INTO users (uid, nickname, nickname_norm, nickname_updated_at, email, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`
    )
      .bind(uid, check.nickname, norm, now, email, now)
      .run();
  }

  // 新規登録ボーナス（ニックネーム初回登録時のみ・1回だけ・credit_tx 冪等ゲート）。
  // 既存ユーザーのニックネーム変更では付与されない。レスポンスの signupBonus は
  // 初回登録で付与された場合のみ 25（クライアントのモーダル表示用）。
  let signupBonus = 0;
  if (!row?.nickname) {
    const bonus = await grantSignupBonus(env, uid, now);
    if (bonus.granted) signupBonus = bonus.amount;
  }

  const next = await getUser(env, uid);
  return json({ ...toPublicUser(next, { tokenEmail: email }), signupBonus }, 200);
}
