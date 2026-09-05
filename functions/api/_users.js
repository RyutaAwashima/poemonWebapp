// functions/api/_users.js
// D1 users テーブルの共通ヘルパー。
// - 既存 KV (user:{uid}) からの遅延移行（冪等・読み出し時に必要なら1回だけ実行）
// - ニックネームの正規化（UNIQUE 制約用）・取得・公開プロフィール変換
// 画像生成ゲート（monster-image.js）とニックネーム API（users.js / users/account.js）から使う。

export const USER_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30日

// カタカナ→ひらがな＋NFKC＋小文字化＋空白除去。
// UNIQUE 制約（nickname_norm）と NG ワード部分一致チェックで同一ルールを使う。
export function normalizeNickname(str) {
  if (!str) return null;
  return String(str)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/[\s\u3000]/g, "");
}

// 既存 KV レコードを D1 へ移行する（読み出し時・冪等）。
// D1 に該当 uid が無い かつ KV にレコードがある場合のみ INSERT する。
// UNIQUE 衝突等で INSERT が無視された場合は KV を残す（getNickname のフォールバックで読める）。
export async function migrateFromKvIfNeeded(env, uid) {
  try {
    const row = await env.AIMON_DB.prepare("SELECT uid FROM users WHERE uid = ?1").bind(uid).first();
    if (row) return;
    const kv = await env.AIMON_KV.get(`user:${uid}`, "json");
    if (!kv) return;
    const now = Date.now();
    const created = kv.createdAt ? Date.parse(kv.createdAt) : now;
    const updated = kv.updatedAt ? Date.parse(kv.updatedAt) : created;
    const result = await env.AIMON_DB.prepare(
      `INSERT OR IGNORE INTO users (uid, nickname, nickname_norm, nickname_updated_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
      .bind(uid, kv.nickname || null, normalizeNickname(kv.nickname), updated, created, now)
      .run();
    if (result.meta?.changes > 0) {
      await env.AIMON_KV.delete(`user:${uid}`).catch(() => {});
    }
  } catch {
    // 移行失敗時も API は継続する（KV に残るため次回再試行される）。
  }
}

// D1 のユーザー行を返す（無ければ null）。必要に応じて KV から遅延移行する。
export async function getUser(env, uid) {
  await migrateFromKvIfNeeded(env, uid);
  return env.AIMON_DB.prepare("SELECT * FROM users WHERE uid = ?1").bind(uid).first();
}

// アカウントロック判定（管理者が不正利用対策でロックしたユーザーの操作を止める）。
// クレジット消費・生成・共有・購入など「新たに何かを行う」書き込み系エンドポイントの入口で使う。
// 閲覧系（GET）はブロックしない（ロック理由の確認等はできるようにする）。
export async function isAccountLocked(env, uid) {
  const row = await env.AIMON_DB.prepare("SELECT locked_at FROM users WHERE uid = ?1").bind(uid).first();
  return !!row?.locked_at;
}

// ニックネームを返す（未設定/無ければ null）。画像生成ゲート用。
// D1 に無い場合は KV（移行待ち/衝突で残った分）をフォールバックする。
export async function getNickname(env, uid) {
  const row = await getUser(env, uid);
  if (row?.nickname) return row.nickname;
  const kv = await env.AIMON_KV.get(`user:${uid}`, "json");
  return kv?.nickname || null;
}

// 公開プロフィール（クライアントへ返す形）。ニックネーム未設定なら nickname: null。
// opts.tokenEmail: トークン上の email（メールリンク済みなら新鮮な値で上書き）
// opts.fallbackNickname: KV フォールバック（移行待ち表示用）
export function toPublicUser(row, opts = {}) {
  const { tokenEmail = null, fallbackNickname = null } = opts;
  const email = row?.email || tokenEmail || null;
  const newsletter = row?.newsletter != null ? !!row.newsletter : null;
  const nickname = row?.nickname || fallbackNickname || null;
  // ロール（user | developer | admin）。開発者/管理者は管理コンソール等の権限判定に使う。
  const role = row?.role || "user";
  // クレジット残高（クレジット経済 Phase 1）。未初期化ユーザーは 0。
  const credits = row?.credits ?? 0;
  // アカウントロック状態（管理コンソールから設定・ロック中は課金/生成/共有等の操作ができない）。
  const locked = !!row?.locked_at;
  const lockedReason = row?.locked_reason || null;
  // プロフィール画像（アバター）の状態。avatarUpdatedAt は R2 URL のキャッシュバスティング用クエリにも使う。
  const avatarUpdatedAt = row?.avatar_updated_at ? new Date(row.avatar_updated_at).toISOString() : null;
  const avatarFreeUsed = !!row?.avatar_free_used;
  if (!nickname) {
    return {
      nickname: null,
      canChangeAt: null,
      createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
      email,
      newsletter,
      role,
      credits,
      locked,
      lockedReason,
      avatarUpdatedAt,
      avatarFreeUsed,
    };
  }
  const base = row?.nickname_updated_at || row?.created_at || Date.now();
  const canChangeAt = new Date(base + USER_COOLDOWN_MS).toISOString();
  return {
    nickname,
    canChangeAt,
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
    email,
    newsletter,
    role,
    credits,
    locked,
    lockedReason,
    avatarUpdatedAt,
    avatarFreeUsed,
  };
}
