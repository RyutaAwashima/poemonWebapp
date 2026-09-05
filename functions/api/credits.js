// functions/api/credits.js
// クレジット残高・デイリー/対戦ボーナスの受取可否の取得。
//   GET /api/credits → { credits, daily: { grant, claimable }, battle: { grant, claimable } }
// 認証必須。デイリー受取は POST /api/credits/daily（credits/daily.js）へ。
// 対戦ボーナス受取は POST /api/credits/battle（credits/battle.js）へ。

import { authFromRequest } from "./_auth.js";
import {
  DAILY_GRANT,
  BATTLE_GRANT,
  CORS,
  json,
  dayRef,
  hasClaimedDaily,
  hasClaimedBattle,
  monthlyPurchased,
  scrollPrice,
  wishPrice,
  SCROLL_MONTHLY_LIMIT,
  WISH_MONTHLY_LIMIT,
} from "./_credits.js";
import { publicPacks, isCampaignActive } from "./_stripe.js";
import { isSummonFestivalActive, summonCost } from "./_summon.js";
import { getAgeTierView } from "./_age_tier.js";
import { FRAGMENTS_PER_WISH } from "./_level.js";

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  if (request.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  const user = await authFromRequest(env, request);
  if (!user) {
    return json({ error: "unauthorized" }, 401);
  }

  const row = await env.AIMON_DB.prepare("SELECT credits, collection_limit, scrolls, wishes, fragments FROM users WHERE uid = ?1")
    .bind(user.uid)
    .first();
  const credits = row?.credits ?? 0;
  const collectionLimit = row?.collection_limit ?? 30;
  const scrolls = row?.scrolls ?? 0;
  const wishes = row?.wishes ?? 0;
  const fragments = row?.fragments ?? 0;
  const claimable = !(await hasClaimedDaily(env, user.uid, dayRef()));
  const battleClaimable = !(await hasClaimedBattle(env, user.uid, dayRef()));

  // 購入済みパック（credit_tx reason='purchase' に記録された pack 一覧）。
  // pack が無い古い購入は「未購入」扱いになる（初回判定にのみ影響）。
  const purchased = new Set();
  const rows = await env.AIMON_DB.prepare(
    "SELECT DISTINCT pack FROM credit_tx WHERE uid = ?1 AND reason = 'purchase' AND pack IS NOT NULL"
  )
    .bind(user.uid)
    .all();
  for (const r of rows.results || []) purchased.add(r.pack);

  const campaignActive = isCampaignActive();
  const packs = publicPacks().map((p) => ({
    ...p,
    // 各パックの初回購入かどうか（キャンペーンの対象判定に使う）。
    firstPurchase: !purchased.has(p.id),
  }));

  // 年齢区分（未成年購入制限）の状態・月間購入額・上限。ダッシュボードの強制ポップアップ判定に使う。
  const ageTier = await getAgeTierView(env, user.uid);

  // 育成アイテム（伝承の巻物・願いの雫）: 所持数・現在価格・今月購入数・月間上限。
  const scrollPurchased = await monthlyPurchased(env, user.uid, "scroll_purchase");
  const wishPurchased = await monthlyPurchased(env, user.uid, "wish_purchase");

  return json({
    credits,
    collectionLimit,
    daily: { grant: DAILY_GRANT, claimable },
    // 対戦ボーナス（1日1回・CPU対戦/通信対戦どちらでもOK）。生成ページのクレ0誘導で使う。
    battle: { grant: BATTLE_GRANT, claimable: battleClaimable },
    campaign: { active: campaignActive },
    // 召喚祭（時限キャンペーン）: 開催中は召喚コストが 2 → 1 に半減。生成ページの告知に使う。
    summonFestival: { active: isSummonFestivalActive(), cost: summonCost() },
    packs,
    ageTier,
    items: {
      scrolls: { owned: scrolls, price: scrollPrice(scrollPurchased), purchased: scrollPurchased, limit: SCROLL_MONTHLY_LIMIT },
      wishes: { owned: wishes, price: wishPrice(wishPurchased), purchased: wishPurchased, limit: WISH_MONTHLY_LIMIT },
      // 願いのカケラ（レベル上限到達後のあぶれXP変換アイテム）。100個=願いの雫1に交換。
      fragments: { owned: fragments, perWish: FRAGMENTS_PER_WISH },
    },
  });
}
