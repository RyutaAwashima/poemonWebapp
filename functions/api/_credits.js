// functions/api/_credits.js
// クレジット経済（M2 Phase 1）の共通定義。
// credits.js（残高取得）と credits/daily.js（デイリー付与）から使う。

export const DAILY_GRANT = 5; // デイリーログインボーナス（設計 §5.4・2026-08-14 経済改定で 2 → 5）
export const SHARE_GRANT = 2; // 共有ボーナス・1日1回（設計 §5.1・M5 でインプレッション操作ベースに拡張・2026-08-14 で 1 → 2）
export const BATTLE_GRANT = 5; // 対戦ボーナス・1日1回（CPU対戦・通信対戦どちらでもOK・2026-08-14 で 1 → 5）
export const SIGNUP_GRANT = 25; // 新規登録ボーナス（ニックネーム初回登録時に1回だけ付与・2026-08-22）

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// デイリー付与の冪等キー。UTC の YYYY-MM-DD（credit_tx.ref に使う）。
export function dayRef(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

// 当日のデイリー付与済みかどうか。
export async function hasClaimedDaily(env, uid, ref) {
  const row = await env.AIMON_DB.prepare(
    "SELECT id FROM credit_tx WHERE uid = ?1 AND reason = 'daily' AND ref = ?2 LIMIT 1"
  )
    .bind(uid, ref)
    .first();
  return !!row;
}

// 当日の対戦ボーナス付与済みかどうか。
export async function hasClaimedBattle(env, uid, ref) {
  const row = await env.AIMON_DB.prepare(
    "SELECT id FROM credit_tx WHERE uid = ?1 AND reason = 'battle' AND ref = ?2 LIMIT 1"
  )
    .bind(uid, ref)
    .first();
  return !!row;
}

// 共有ボーナス（+1クレジット・1日1回・冪等）。M5 から「いいね／召喚／共有（新規 or 統合）」といった
// インプレッション操作を行った時に付与する（設計 §5.1 改定）。対象操作はサーバー各所から呼ぶ。
// credit_tx の UNIQUE(uid, reason='share', ref=日付) をゲートに INSERT OR IGNORE でアトミック判定する。
// 返り値: { bonusGranted, credits }。bonusGranted=true ならクライアント側で獲得ダイアログを出す。
export async function claimInteractionBonus(env, uid, now = Date.now()) {
  const ref = dayRef(now);
  const gate = await env.AIMON_DB.prepare(
    "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, created_at) VALUES (?1, ?2, 'share', ?3, ?4)"
  )
    .bind(uid, SHARE_GRANT, ref, now)
    .run();
  const bonusGranted = (gate.meta?.changes ?? 0) > 0;
  if (bonusGranted) {
    // ユーザー行が無い場合でも付与が反映されるよう、行を作成しつつ加算する（UPSERT）。
    await env.AIMON_DB.prepare(
      `INSERT INTO users (uid, credits, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(uid) DO UPDATE SET credits = credits + excluded.credits, updated_at = excluded.updated_at`
    )
      .bind(uid, SHARE_GRANT, now)
      .run();
  }
  const row = await env.AIMON_DB.prepare("SELECT credits FROM users WHERE uid = ?1")
    .bind(uid)
    .first();
  return { bonusGranted, credits: row?.credits ?? 0 };
}

// 新規登録ボーナス（+25クレジット・1回限定・冪等）。ニックネーム初回登録時（users.js POST）に呼ぶ。
// credit_tx の UNIQUE(uid, reason='signup', ref='signup') をゲートに INSERT OR IGNORE で
// アトミック判定する（changes=0 なら付与済み）。返り値: { granted, amount, credits }。
export async function grantSignupBonus(env, uid, now = Date.now()) {
  const gate = await env.AIMON_DB.prepare(
    "INSERT OR IGNORE INTO credit_tx (uid, delta, reason, ref, created_at) VALUES (?1, ?2, 'signup', 'signup', ?3)"
  )
    .bind(uid, SIGNUP_GRANT, now)
    .run();
  const granted = (gate.meta?.changes ?? 0) > 0;
  if (!granted) {
    const row = await env.AIMON_DB.prepare("SELECT credits FROM users WHERE uid = ?1")
      .bind(uid)
      .first();
    return { granted: false, amount: 0, credits: row?.credits ?? 0 };
  }
  // ユーザー行が無い場合でも残高に反映されるよう、行を作成しつつ加算する（UPSERT）。
  await env.AIMON_DB.prepare(
    `INSERT INTO users (uid, credits, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT(uid) DO UPDATE SET credits = credits + excluded.credits, updated_at = excluded.updated_at`
  )
    .bind(uid, SIGNUP_GRANT, now)
    .run();
  const row = await env.AIMON_DB.prepare("SELECT credits FROM users WHERE uid = ?1")
    .bind(uid)
    .first();
  return { granted: true, amount: SIGNUP_GRANT, credits: row?.credits ?? 0 };
}

// コレクション上限（users.collection_limit・既定30・ショップで拡張可・最大99）。
// users 行が無い場合は 30 を既定として返す（aimons/merge/monster-image で使用・P10 2026-08-09）。
export async function getCollectionLimit(env, uid) {
  const row = await env.AIMON_DB.prepare("SELECT collection_limit FROM users WHERE uid = ?1")
    .bind(uid)
    .first();
  return row?.collection_limit ?? 30;
}

// ── 育成アイテム（伝承の巻物・願いの雫）・Phase B 2026-08-09 ──────────
// 伝承の巻物: スロット2解放用・月20枚・1〜10枚目20クレ/11〜20枚目40クレ（2026-08-14 経済改定）。
// 願いの雫: 育成実行（願いの洞窟）用・月30個・1〜15個目10クレ/16〜30個目20クレ（2026-08-14 経済改定）。
// 月間購入数は credit_tx（reason='scroll_purchase'/'wish_purchase'）の当月集計で判定する。
export const SCROLL_MONTHLY_LIMIT = 20;
export const WISH_MONTHLY_LIMIT = 30;

// 当月（UTC）の購入済み枚数。月次制限の判定に使う。
export async function monthlyPurchased(env, uid, reason, now = Date.now()) {
  const monthStart = new Date(now);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const row = await env.AIMON_DB.prepare(
    "SELECT COUNT(*) AS n FROM credit_tx WHERE uid = ?1 AND reason = ?2 AND created_at >= ?3"
  )
    .bind(uid, reason, monthStart.getTime())
    .first();
  return row?.n ?? 0;
}

// 伝承の巻物の現在価格（1〜10枚目20クレ・11〜20枚目40クレ・2026-08-14 経済改定）。
export function scrollPrice(purchasedThisMonth) {
  return purchasedThisMonth < 10 ? 20 : 40;
}

// 願いの雫の現在価格（1〜15個目10クレ・16〜30個目20クレ・2026-08-14 経済改定）。
export function wishPrice(purchasedThisMonth) {
  return purchasedThisMonth < 15 ? 10 : 20;
}

// 育成アイテムの所持数（users 行が無い場合は 0）。
// fragments（願いのカケラ）: レベル上限到達後のあぶれXPが変換される新アイテム（育成システム再設計）。
export async function getItemCounts(env, uid) {
  const row = await env.AIMON_DB.prepare("SELECT scrolls, wishes, fragments FROM users WHERE uid = ?1")
    .bind(uid)
    .first();
  return { scrolls: row?.scrolls ?? 0, wishes: row?.wishes ?? 0, fragments: row?.fragments ?? 0 };
}
