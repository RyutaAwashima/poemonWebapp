// functions/api/_stripe.js
// Stripe 決済（M2 Phase 1）の共通定義とヘルパー。
// 依存パッケージ無しで Stripe REST API を直接呼ぶ（_dist からデプロイする構成に合わせる）。
// シークレット: env.STRIPE_SECRET_KEY（sk_test_... / sk_live_...）

const STRIPE_API = "https://api.stripe.com/v1";

// 販売パック定義（2026-08-14 経済改定）。
// 金額・枚数はクライアントから受け取らず、必ずここ（サーバー側）で解決する。
// JPY はゼロ小数通貨のため unit_amount は円そのもの（210 = 210円）。
// 構成: base（本体）＋bonus（通常ボーナス）。通常販売枚数 = base + bonus。
// 初回購入200%キャンペーン時は bonus を 2 倍（200%）にして付与する（スターターは bonus 0 のため変化なし）。
//   スターター: ¥210 / 25枚          （25 + 0）
//   レギュラー: ¥630 / 82枚           （75 + 7）
//   プレミアム: ¥1260 / 173枚         （150 + 23）
//   ウルトラ:  ¥3780 / 545枚          （450 + 95）
export const PACKS = {
  starter: { id: "starter", name: "スターター", price: 210, base: 25, bonus: 0 },
  regular: { id: "regular", name: "レギュラー", price: 630, base: 75, bonus: 7 },
  premium: { id: "premium", name: "プレミアム", price: 1260, base: 150, bonus: 23 },
  ultra: { id: "ultra", name: "ウルトラ", price: 3780, base: 450, bonus: 95 },
};

// 初回購入200%キャンペーンの開催期間（定期的に開催するため配列で管理）。
// 1要素 = 1期間。開始/終了は ISO 8601（JST 表記でも可）。期間外は自動的に無効になる。
// キャンペーンを停止する場合は配列を空にするか、該当要素を削除する。
export const CAMPAIGN_WINDOWS = [
  // 例: 2026-08-07 〜 2026-08-31（オープンβ記念・初回購入ボーナス200%）。
  // 実際の開催日程に合わせて編集してください。
  { start: "2026-08-07T00:00:00+09:00", end: "2026-08-31T23:59:59+09:00" },
];

export function isCampaignActive(now = new Date()) {
  const t = now.getTime();
  return CAMPAIGN_WINDOWS.some((w) => {
    const s = new Date(w.start).getTime();
    const e = new Date(w.end).getTime();
    return Number.isFinite(s) && Number.isFinite(e) && t >= s && t <= e;
  });
}

export function getPack(packId) {
  return PACKS[packId] || null;
}

// 通常販売時の付与枚数（base + bonus）。
export function normalCredits(pack) {
  return pack.base + pack.bonus;
}

// 初回購入200%キャンペーン時の付与枚数（base + bonus*2）。
export function campaignCredits(pack) {
  return pack.base + pack.bonus * 2;
}

// クライアント表示用のパック情報（価格・枚数のみ・金額はサーバー定義）。
// campaignCredits はキャンペーン時の枚数。firstPurchase（初回購入か）は credits.js 側で付与する。
export function publicPacks() {
  return Object.values(PACKS).map(({ id, name, price, base, bonus }) => ({
    id,
    name,
    price,
    base,
    credits: base + bonus,
    bonus,
    campaignCredits: base + bonus * 2,
  }));
}

// Stripe REST API 呼び出し（application/x-www-form-urlencoded）。
// params はキーに配列添字（line_items[0][price_data][currency] 等）を含められる。
export async function callStripe(env, path, params = {}) {
  const secret = env.STRIPE_SECRET_KEY;
  if (!secret) {
    throw new Error("STRIPE_SECRET_KEY not configured");
  }
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    body.append(k, v);
  }
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `stripe ${res.status}`);
  }
  return data;
}
