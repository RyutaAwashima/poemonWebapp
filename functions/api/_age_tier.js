// functions/api/_age_tier.js
// 未成年購入制限（2026-08-07 実装）の共通定義とヘルパー。
// 年齢区分を月単位で管理する（選択は当月いっぱい有効・翌月に自動リセット）。
// 月間購入額は credit_tx (reason='purchase', yen) の当月合計（JST）で算出する。

// 年齢区分ごとの月間購入上限（円）。adult は制限なし（null）。
export const AGE_LIMITS = {
  under13: 5000,   // 13歳未満: 5,000円
  under18: 30000,  // 18歳未満: 30,000円
  adult: null,     // 18歳以上: 制限なし
};

// 表示用ラベル（クライアント表示に使う）。
export const TIER_LABELS = {
  under13: "13歳未満",
  under18: "13歳以上18歳未満",
  adult: "18歳以上",
};

// 親権者同意が必須の区分か（未成年のみ）。
export function requiresGuardianConsent(tier) {
  return tier === "under13" || tier === "under18";
}

// JST（UTC+9）での YYYY-MM（月ごとの有効期限・購入集計は JST 基準）。
export function monthKeyJst(ts = Date.now()) {
  const d = new Date(ts + 9 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// 当月の開始（JST 00:00 = UTC 前日 15:00）のエポックms。
export function monthStartJst(ts = Date.now()) {
  return Date.parse(`${monthKeyJst(ts)}-01T00:00:00+09:00`);
}

// 保存済み区分が当月も有効か（選択月と現在月が一致するか）。
export function tierEffective(tier, setAt) {
  if (!tier || !setAt) return false;
  return monthKeyJst(setAt) === monthKeyJst();
}

// D1 の users から年齢区分を読み、当月有効な区分と上限を返す。
export async function getAgeTier(env, uid) {
  const row = await env.AIMON_DB.prepare(
    "SELECT age_tier, guardian_consent_at, age_tier_set_at FROM users WHERE uid = ?1"
  )
    .bind(uid)
    .first();
  const tier = row?.age_tier || null;
  const setAt = row?.age_tier_set_at || null;
  const effective = tierEffective(tier, setAt);
  return {
    tier,                 // 保存されている区分（有効かどうかは effective）
    effective,            // 当月有効か（false なら要再選択）
    setMonth: setAt ? monthKeyJst(setAt) : null,
    limit: AGE_LIMITS[tier] ?? null,
    requireConsent: requiresGuardianConsent(tier),
  };
}

// 当月（JST）の購入合計（円）。credit_tx reason='purchase' の yen を集計。
export async function getMonthlySpend(env, uid) {
  const start = monthStartJst();
  const row = await env.AIMON_DB.prepare(
    `SELECT COALESCE(SUM(yen), 0) AS s FROM credit_tx
     WHERE uid = ?1 AND reason = 'purchase' AND yen IS NOT NULL AND created_at >= ?2`
  )
    .bind(uid, start)
    .first();
  return row?.s ?? 0;
}

// クライアントへ返すビュー（GET /api/credits と /api/age-tier で共用）。
export async function getAgeTierView(env, uid) {
  const t = await getAgeTier(env, uid);
  const monthlySpend = await getMonthlySpend(env, uid);
  const limit = t.limit;
  return {
    tier: t.effective ? t.tier : null, // 有効な区分（未選択・期限切れは null）
    setMonth: t.setMonth,
    effective: t.effective,
    monthlySpend,
    limit,
    remaining: limit == null ? null : Math.max(0, limit - monthlySpend),
    requireConsent: t.requireConsent,
  };
}
